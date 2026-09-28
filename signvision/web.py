"""Browser UI and upload API for collecting, recognizing and evaluating clips."""
from __future__ import annotations

from pathlib import Path
from tempfile import NamedTemporaryFile
import logging

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .classifier import classify
from .config import ROOT, load_settings
from .extract import extract_video
from .normalize import hand_present
from .storage import Dataset

settings = load_settings()
dataset = Dataset(ROOT / "data")
valid_ids = {phrase.id for phrase in settings.phrases}
log_dir = ROOT / "logs"
log_dir.mkdir(exist_ok=True)
logging.basicConfig(level=logging.INFO, handlers=[logging.StreamHandler(), logging.FileHandler(log_dir / "errors.log", encoding="utf-8")])
LOG = logging.getLogger(__name__)
app = FastAPI(title="SignVision MVP")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/config")
def config():
    return {"phrases": [vars(p) for p in settings.phrases], "counts": dataset.counts(valid_ids),
            "min_frames": settings.min_frames, "sample_fps": settings.sample_fps}


async def process(upload: UploadFile) -> np.ndarray:
    suffix = Path(upload.filename or "clip.webm").suffix.lower()
    if suffix not in (".webm", ".mp4", ".mov", ".avi"):
        raise HTTPException(400, "Нужен видеофайл WebM, MP4, MOV или AVI")
    limit = settings.max_video_mb * 1024 * 1024
    try:
        with NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
            path = Path(temporary.name)
            size = 0
            try:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(413, "Видеофайл слишком большой")
                    temporary.write(chunk)
            finally:
                await upload.close()
        sequence = extract_video(path, settings.sample_fps, settings.max_frames)
    except (ValueError, RuntimeError) as exc:
        LOG.exception("Ошибка обработки видео")
        raise HTTPException(422, str(exc)) from exc
    finally:
        path.unlink(missing_ok=True)
    ratio = float(np.mean([hand_present(frame) for frame in sequence]))
    if len(sequence) < settings.min_frames or ratio < settings.min_hand_ratio:
        raise HTTPException(422, f"Недостаточно кадров или рук в кадре ({len(sequence)} кадров, руки {ratio:.0%})")
    return sequence


@app.post("/api/samples")
async def add_sample(video: UploadFile = File(...), phrase_id: str = Form(...)):
    if phrase_id not in valid_ids:
        raise HTTPException(400, "Неизвестная фраза")
    sequence = await process(video)
    sample_id = dataset.save(phrase_id, sequence, source="upload")
    return {"sample_id": sample_id, "frames": len(sequence), "counts": dataset.counts(valid_ids)}


def prediction_payload(sequence: np.ndarray, samples: list[tuple[str, np.ndarray]]):
    result = classify(sequence, samples, neighbors=settings.neighbors,
                      max_distance=settings.max_distance, min_margin=settings.min_margin)
    phrase = settings.phrase(result.phrase_id) if result.phrase_id else None
    return {"phrase_id": result.phrase_id, "text": phrase.text if phrase else "Неизвестный жест",
            "distance": result.distance, "margin": result.margin, "reason": result.reason,
            "frames": len(sequence)}


@app.post("/api/recognize")
async def recognize(video: UploadFile = File(...)):
    sequence = await process(video)
    return prediction_payload(sequence, dataset.load(valid_ids))


@app.post("/api/evaluate")
async def evaluate(videos: list[UploadFile] = File(...), phrase_ids: list[str] = Form(...)):
    if len(videos) != len(phrase_ids) or len(videos) > 30:
        raise HTTPException(400, "Нужно по одной метке на видео, максимум 30 файлов")
    if any(label not in valid_ids and label != "unknown" for label in phrase_ids):
        raise HTTPException(400, "Неизвестная метка")
    samples = dataset.load(valid_ids)  # fixed training snapshot; test videos are never saved
    rows = []
    for video, expected in zip(videos, phrase_ids):
        try:
            result = prediction_payload(await process(video), samples)
            rows.append({"file": video.filename, "expected": expected, "predicted": result["phrase_id"] or "unknown",
                         "distance": result["distance"], "correct": (result["phrase_id"] or "unknown") == expected})
        except HTTPException as exc:
            rows.append({"file": video.filename, "expected": expected, "predicted": None,
                         "correct": False, "error": exc.detail})
    correct = sum(row["correct"] for row in rows)
    return {"total": len(rows), "correct": correct, "accuracy": correct / len(rows), "results": rows}
