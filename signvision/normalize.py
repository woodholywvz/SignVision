"""Turn MediaPipe landmarks into translation/scale normalized temporal features."""
from __future__ import annotations

import numpy as np

POSE_IDS = (11, 12, 13, 14, 15, 16, 23, 24)
HAND_POINTS = 21
HAND_FEATURES = 1 + HAND_POINTS * 3 * 2
FRAME_FEATURES = HAND_FEATURES * 2 + len(POSE_IDS) * 3 + 6
EPS = 1e-5


def _points(landmarks, count: int) -> np.ndarray | None:
    if landmarks is None or len(landmarks) < count:
        return None
    points = np.asarray([[p.x, p.y, p.z] for p in landmarks[:count]], dtype=np.float32)
    return points if np.isfinite(points).all() else None


def frame_features(hands: dict[str, object], pose: object | None) -> np.ndarray:
    """Global wrist positions + local finger geometry, both hand masks, upper body.

    The body origin is the shoulder midpoint and the scale is shoulder width.
    When pose is absent, a hand-based origin/scale keeps the sample usable.
    """
    pose_points = _points(pose, 33)
    hand_points = {side: _points(hands.get(side), HAND_POINTS) for side in ("Left", "Right")}
    if pose_points is not None:
        origin = (pose_points[11] + pose_points[12]) / 2
        scale = max(float(np.linalg.norm(pose_points[11, :2] - pose_points[12, :2])), 0.05)
    else:
        visible = [h for h in hand_points.values() if h is not None]
        if visible:
            origin = np.mean([h[0] for h in visible], axis=0)
            scale = max(float(np.linalg.norm(visible[0][0, :2] - visible[-1][0, :2])),
                        float(np.linalg.norm(visible[0][0, :2] - visible[0][9, :2])) * 3, 0.05)
        else:
            origin = np.zeros(3, dtype=np.float32)
            scale = 1.0
    parts: list[np.ndarray] = []
    wrists = []
    for side in ("Left", "Right"):
        hand = hand_points[side]
        if hand is None:
            parts.append(np.zeros(HAND_FEATURES, dtype=np.float32))
            wrists.append(np.zeros(3, dtype=np.float32))
            continue
        global_points = (hand - origin) / scale
        # Hand z is wrist-relative; pose z is hip-relative and cannot be subtracted from it.
        global_points[:, 2] = (hand[:, 2] - hand[0, 2]) / scale
        palm_scale = max(float(np.linalg.norm(hand[0, :2] - hand[9, :2])), EPS)
        local_points = (hand - hand[0]) / palm_scale
        parts.append(np.concatenate(([1.0], global_points.ravel(), local_points.ravel())).astype(np.float32))
        wrists.append(global_points[0])
    body = ((pose_points[list(POSE_IDS)] - origin) / scale).ravel() if pose_points is not None else np.zeros(len(POSE_IDS) * 3)
    parts.extend((body.astype(np.float32), np.concatenate(wrists).astype(np.float32)))
    return np.concatenate(parts)


def hand_present(frame: np.ndarray) -> bool:
    return bool(frame[0] or frame[HAND_FEATURES])


def resample_sequence(frames: list[np.ndarray] | np.ndarray, target: int = 32) -> np.ndarray:
    sequence = np.asarray(frames, dtype=np.float32)
    if sequence.ndim != 2 or sequence.shape[0] == 0 or sequence.shape[1] != FRAME_FEATURES:
        raise ValueError("Нужна непустая последовательность ключевых точек")
    if target < 2 or not np.isfinite(sequence).all():
        raise ValueError("Неверная последовательность или длина")
    old_x = np.linspace(0, 1, len(sequence))
    new_x = np.linspace(0, 1, target)
    result = np.stack([np.interp(new_x, old_x, sequence[:, i]) for i in range(sequence.shape[1])], axis=1)
    # Keep visibility masks discrete; absent hands must not appear by interpolation.
    nearest = np.rint(new_x * (len(sequence) - 1)).astype(int)
    for mask_index in (0, HAND_FEATURES):
        result[:, mask_index] = sequence[nearest, mask_index]
    # A missing hand cannot acquire interpolated finger coordinates.
    for mask_index in (0, HAND_FEATURES):
        missing = result[:, mask_index] == 0
        result[missing, mask_index + 1:mask_index + HAND_FEATURES] = 0
    return result.astype(np.float32)
