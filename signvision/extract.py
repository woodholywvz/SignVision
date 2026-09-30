"""OpenCV video decoding and MediaPipe Tasks landmark tracking."""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from .normalize import frame_features
from .tracking import LandmarkTracker

LOG = logging.getLogger(__name__)


def extract_video(path: Path, sample_fps: int, max_frames: int) -> np.ndarray:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError(
            "Не удалось открыть видео. Используйте MP4 или WebM с поддерживаемым кодеком"
        )
    fps = capture.get(cv2.CAP_PROP_FPS)
    fps = fps if np.isfinite(fps) and fps > 0 else float(sample_fps)
    step = max(1, round(fps / sample_fps))
    frames = []
    try:
        with LandmarkTracker() as tracker:
            index = 0
            last_ms = -1
            while len(frames) < max_frames:
                ok, bgr = capture.read()
                if not ok:
                    break
                if index % step:
                    index += 1
                    continue
                timestamp_ms = max(last_ms + 1, round(index * 1000 / fps))
                last_ms = timestamp_ms
                index += 1
                found, body = tracker.detect(bgr, timestamp_ms)
                frames.append(frame_features(found, body))
    finally:
        capture.release()
    if not frames:
        raise ValueError("В видео нет доступных кадров")
    LOG.info("Извлечено %d кадров из %s", len(frames), path.name)
    return np.stack(frames)
