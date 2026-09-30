"""Browser UI and upload API for collecting, recognizing and evaluating clips."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit

import numpy as np
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .classifier import classify
from .config import ROOT, load_settings
from .extract import extract_video
from .normalize import hand_present
from .storage import Dataset
from .tracking import MAX_FRAME_BYTES, LandmarkTracker

settings = load_settings()
dataset = Dataset(ROOT / "data")
valid_ids = {phrase.id for phrase in settings.phrases}
log_dir = ROOT / "logs"
log_dir.mkdir(exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(log_dir / "errors.log", encoding="utf-8"),
    ],
)
LOG = logging.getLogger(__name__)
app = FastAPI(title="SignVision MVP")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

MESSAGES = {
    "ru": {
        "bad_format": "Нужен видеофайл WebM, MP4, MOV или AVI",
        "too_large": "Видеофайл слишком большой",
        "bad_video": "Не удалось обработать видео. Проверьте формат и модели MediaPipe",
        "low_signal": "Недостаточно кадров или рук в кадре ({frames} кадров, руки {ratio:.0%})",
        "bad_phrase": "Неизвестная фраза",
        "bad_labels": "Нужно по одной метке на видео, максимум 30 файлов",
        "bad_label": "Неизвестная метка",
        "unknown": "Неизвестный жест",
        "empty_dataset": "Датасет пуст",
        "too_far": "Слишком далеко от известных жестов",
        "ambiguous": "Недостаточный отрыв от других фраз",
        "recognized": "Распознано",
    },
    "en": {
        "bad_format": "Upload a WebM, MP4, MOV or AVI video",
        "too_large": "Video file is too large",
        "bad_video": "Could not process the video. Check its format and the MediaPipe models",
        "low_signal": "Not enough frames or visible hands ({frames} frames, hands in {ratio:.0%})",
        "bad_phrase": "Unknown phrase",
        "bad_labels": "Provide one label per video, up to 30 files",
        "bad_label": "Unknown label",
        "unknown": "Unknown gesture",
        "empty_dataset": "Dataset is empty",
        "too_far": "Too far from known gestures",
        "ambiguous": "Too close to another phrase",
        "recognized": "Recognized",
    },
}


def locale_for(request: Request) -> str:
    return "en" if request.headers.get("accept-language", "ru").lower().startswith("en") else "ru"


def message(locale: str, key: str, **values) -> str:
    return MESSAGES[locale][key].format(**values)


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/config")
def config():
    return {
        "phrases": [vars(p) for p in settings.phrases],
        "counts": dataset.counts(valid_ids),
        "min_frames": settings.min_frames,
        "sample_fps": settings.sample_fps,
    }


async def process(upload: UploadFile, locale: str = "ru") -> np.ndarray:
    suffix = Path(upload.filename or "clip.webm").suffix.lower()
    if suffix not in (".webm", ".mp4", ".mov", ".avi"):
        raise HTTPException(400, message(locale, "bad_format"))
    limit = settings.max_video_mb * 1024 * 1024
    try:
        with NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
            path = Path(temporary.name)
            size = 0
            try:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(413, message(locale, "too_large"))
                    temporary.write(chunk)
            finally:
                await upload.close()
        sequence = await run_in_threadpool(
            extract_video, path, settings.sample_fps, settings.max_frames
        )
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        LOG.exception("Ошибка обработки видео")
        raise HTTPException(422, message(locale, "bad_video")) from exc
    finally:
        path.unlink(missing_ok=True)
    ratio = float(np.mean([hand_present(frame) for frame in sequence]))
    if len(sequence) < settings.min_frames or ratio < settings.min_hand_ratio:
        raise HTTPException(422, message(locale, "low_signal", frames=len(sequence), ratio=ratio))
    return sequence


@app.websocket("/api/track")
async def live_tracking(socket: WebSocket):
    """One tracker per connection. Each frame is acknowledged before the next is sent."""
    origin = socket.headers.get("origin")
    if origin and urlsplit(origin).netloc != socket.headers.get("host"):
        await socket.close(code=1008)
        return
    await socket.accept()
    tracker = None
    try:
        tracker = await run_in_threadpool(LandmarkTracker)
        await socket.send_json({"type": "ready"})
        while True:
            data = await asyncio.wait_for(socket.receive_bytes(), timeout=30)
            if len(data) > MAX_FRAME_BYTES:
                await socket.send_json({"type": "error", "code": "invalid_frame"})
                await socket.close(code=1009)
                return
            result = await run_in_threadpool(tracker.track_jpeg, data)
            await socket.send_json(result)
    except WebSocketDisconnect:
        pass
    except (TimeoutError, FileNotFoundError, ValueError) as exc:
        code = (
            "missing_models"
            if isinstance(exc, FileNotFoundError)
            else "tracking_timeout"
            if isinstance(exc, asyncio.TimeoutError)
            else "invalid_frame"
        )
        await socket.send_json({"type": "error", "code": code})
        await socket.close(code=1011)
    except Exception:
        LOG.exception("Live landmark tracking failed")
        try:
            await socket.send_json({"type": "error", "code": "tracking_failed"})
            await socket.close(code=1011)
        except (RuntimeError, WebSocketDisconnect):
            pass
    finally:
        if tracker is not None:
            await run_in_threadpool(tracker.close)


@app.post("/api/samples")
async def add_sample(request: Request, video: UploadFile = File(...), phrase_id: str = Form(...)):
    locale = locale_for(request)
    if phrase_id not in valid_ids:
        raise HTTPException(400, message(locale, "bad_phrase"))
    sequence = await process(video, locale)
    sample_id = dataset.save(phrase_id, sequence, source="upload")
    return {"sample_id": sample_id, "frames": len(sequence), "counts": dataset.counts(valid_ids)}


def prediction_payload(
    sequence: np.ndarray, samples: list[tuple[str, np.ndarray]], locale: str = "ru"
):
    result = classify(
        sequence,
        samples,
        neighbors=settings.neighbors,
        max_distance=settings.max_distance,
        min_margin=settings.min_margin,
        target_frames=settings.target_frames,
    )
    phrase = settings.phrase(result.phrase_id) if result.phrase_id else None
    return {
        "phrase_id": result.phrase_id,
        "text": phrase.localized(locale) if phrase else message(locale, "unknown"),
        "distance": result.distance,
        "margin": result.margin,
        "reason": message(locale, result.reason),
        "reason_code": result.reason,
        "frames": len(sequence),
    }


@app.post("/api/recognize")
async def recognize(request: Request, video: UploadFile = File(...)):
    locale = locale_for(request)
    sequence = await process(video, locale)
    return prediction_payload(sequence, dataset.load(valid_ids), locale)


@app.post("/api/evaluate")
async def evaluate(
    request: Request, videos: list[UploadFile] = File(...), phrase_ids: list[str] = Form(...)
):
    locale = locale_for(request)
    if len(videos) != len(phrase_ids) or len(videos) > 30:
        raise HTTPException(400, message(locale, "bad_labels"))
    if any(label not in valid_ids and label != "unknown" for label in phrase_ids):
        raise HTTPException(400, message(locale, "bad_label"))
    samples = dataset.load(valid_ids)  # fixed training snapshot; test videos are never saved
    rows = []
    for video, expected in zip(videos, phrase_ids, strict=True):
        try:
            result = prediction_payload(await process(video, locale), samples, locale)
            rows.append(
                {
                    "file": video.filename,
                    "expected": expected,
                    "predicted": result["phrase_id"] or "unknown",
                    "distance": result["distance"],
                    "correct": (result["phrase_id"] or "unknown") == expected,
                }
            )
        except HTTPException as exc:
            rows.append(
                {
                    "file": video.filename,
                    "expected": expected,
                    "predicted": None,
                    "correct": False,
                    "error": exc.detail,
                }
            )
    correct = sum(row["correct"] for row in rows)
    return {
        "total": len(rows),
        "correct": correct,
        "accuracy": correct / len(rows),
        "results": rows,
    }
