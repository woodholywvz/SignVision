"""Weighted DTW and k-nearest-neighbor classification of gesture sequences."""
from __future__ import annotations

from dataclasses import dataclass
import numpy as np

from .normalize import FRAME_FEATURES, HAND_FEATURES, resample_sequence


@dataclass(frozen=True)
class Prediction:
    phrase_id: str | None
    distance: float | None
    margin: float | None
    reason: str


def frame_distance(a: np.ndarray, b: np.ndarray) -> float:
    costs = []
    for offset in (0, HAND_FEATURES):
        present_a, present_b = a[offset] > 0.5, b[offset] > 0.5
        if present_a != present_b:
            costs.append(1.0)
        elif present_a:
            # Global coordinates retain wrist position; local coordinates retain finger shape.
            start = offset + 1
            global_error = np.mean(np.abs(a[start:start + 63] - b[start:start + 63]))
            local_error = np.mean(np.abs(a[start + 63:start + 126] - b[start + 63:start + 126]))
            costs.append(float(0.55 * global_error + 0.45 * local_error))
    body_start = HAND_FEATURES * 2
    body_error = float(np.mean(np.abs(a[body_start:body_start + 24] - b[body_start:body_start + 24])))
    wrists_error = float(np.mean(np.abs(a[-6:] - b[-6:])))
    return float((sum(costs) + 0.25 * body_error + 0.35 * wrists_error) / (len(costs) + 0.6))


def dtw_distance(a: np.ndarray, b: np.ndarray, radius: int | None = None) -> float:
    """Normalized DTW with a Sakoe-Chiba band; velocities preserve motion direction."""
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    if a.ndim != 2 or b.ndim != 2 or a.shape[1:] != (FRAME_FEATURES,) or b.shape[1:] != (FRAME_FEATURES,) or not len(a) or not len(b):
        raise ValueError("Неверная форма последовательности")
    if not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError("Последовательность содержит NaN/Inf")
    radius = radius if radius is not None else max(4, max(len(a), len(b)) // 4)
    radius = max(radius, abs(len(a) - len(b)))
    va = np.diff(a, axis=0, prepend=a[:1])
    vb = np.diff(b, axis=0, prepend=b[:1])
    previous = np.full(len(b) + 1, np.inf)
    previous[0] = 0
    for i in range(1, len(a) + 1):
        current = np.full(len(b) + 1, np.inf)
        center = i * len(b) / len(a)
        for j in range(max(1, int(center - radius)), min(len(b), int(center + radius) + 1) + 1):
            movement = float(np.mean(np.abs(va[i - 1, -6:] - vb[j - 1, -6:])))
            cost = frame_distance(a[i - 1], b[j - 1]) + 0.3 * movement
            current[j] = cost + min(previous[j], current[j - 1], previous[j - 1])
        previous = current
    return float(previous[-1] / max(len(a), len(b)))


def classify(sequence: np.ndarray, samples: list[tuple[str, np.ndarray]], *, neighbors: int,
             max_distance: float, min_margin: float) -> Prediction:
    if not samples:
        return Prediction(None, None, None, "Датасет пуст")
    query = resample_sequence(sequence, 32)
    ranked = sorted((dtw_distance(query, resample_sequence(data, 32)), label) for label, data in samples)
    nearest = ranked[:max(1, neighbors)]
    votes: dict[str, list[float]] = {}
    for distance, label in nearest:
        votes.setdefault(label, []).append(distance)
    winner = min(votes, key=lambda label: (-len(votes[label]), np.mean(votes[label])))
    best = min(distance for distance, label in ranked if label == winner)
    other = min((distance for distance, label in ranked if label != winner), default=None)
    margin = None if other is None else other - best
    if best > max_distance:
        return Prediction(None, best, margin, "Слишком далеко от известных жестов")
    if margin is not None and margin < min_margin:
        return Prediction(None, best, margin, "Недостаточный отрыв от других фраз")
    return Prediction(winner, best, margin, "Распознано")
