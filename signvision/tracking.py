"""Reusable MediaPipe tracker for video clips and live camera sessions."""
from contextlib import ExitStack
from pathlib import Path
import time

import cv2
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MAX_FRAME_BYTES = 1024 * 1024


class LandmarkTracker:
    def __init__(self):
        import mediapipe as mp

        paths = [MODEL_DIR / "hand_landmarker.task", MODEL_DIR / "pose_landmarker_lite.task"]
        if not all(path.is_file() for path in paths):
            raise FileNotFoundError("Run python -m signvision.models to download MediaPipe models")
        self.mp = mp
        self.stack = ExitStack()
        self.last_timestamp = -1
        self.started = time.monotonic()
        vision = mp.tasks.vision
        try:
            self.hands = self.stack.enter_context(vision.HandLandmarker.create_from_options(
                vision.HandLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(paths[0])),
                                             running_mode=vision.RunningMode.VIDEO, num_hands=2)))
            self.pose = self.stack.enter_context(vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(paths[1])),
                                             running_mode=vision.RunningMode.VIDEO, num_poses=1)))
        except Exception:
            self.close()
            raise

    def detect(self, bgr: np.ndarray, timestamp_ms: int | None = None):
        timestamp_ms = timestamp_ms if timestamp_ms is not None else round((time.monotonic() - self.started) * 1000)
        timestamp_ms = max(self.last_timestamp + 1, timestamp_ms)
        self.last_timestamp = timestamp_ms
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        hand_result = self.hands.detect_for_video(image, timestamp_ms)
        pose_result = self.pose.detect_for_video(image, timestamp_ms)
        hands = {}
        for landmarks, categories in zip(hand_result.hand_landmarks, hand_result.handedness):
            if categories and categories[0].category_name in ("Left", "Right"):
                hands[categories[0].category_name] = landmarks
        return hands, pose_result.pose_landmarks[0] if pose_result.pose_landmarks else None

    def track_jpeg(self, data: bytes) -> dict:
        if not data or len(data) > MAX_FRAME_BYTES:
            raise ValueError("invalid_frame")
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("invalid_frame")
        height, width = frame.shape[:2]
        if max(height, width) > 1280:
            factor = 1280 / max(height, width)
            frame = cv2.resize(frame, (round(width * factor), round(height * factor)))
        started = time.perf_counter()
        hands, pose = self.detect(frame)
        return {
            "type": "landmarks",
            "hands": [{"side": side, "points": [[p.x, p.y, p.z] for p in points]} for side, points in hands.items()],
            "pose": [[p.x, p.y, p.z, p.visibility if p.visibility is not None else 1.0] for p in pose] if pose else [],
            "inference_ms": round((time.perf_counter() - started) * 1000),
        }

    def close(self):
        self.stack.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
