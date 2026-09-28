"""Versioned landmark samples. Videos are processed, then discarded."""
from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4
import numpy as np

from .normalize import FRAME_FEATURES


class Dataset:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, phrase_id: str, sequence: np.ndarray, source: str = "camera") -> str:
        sample_id = uuid4().hex
        path = self.root / f"{sample_id}.npz"
        metadata = {"version": 1, "phrase_id": phrase_id, "source": source}
        np.savez_compressed(path, sequence=sequence.astype(np.float32), metadata=json.dumps(metadata, ensure_ascii=False))
        return sample_id

    def load(self, valid_ids: set[str]) -> list[tuple[str, np.ndarray]]:
        samples = []
        for path in self.root.glob("*.npz"):
            try:
                with np.load(path, allow_pickle=False) as item:
                    metadata = json.loads(str(item["metadata"]))
                    sequence = item["sequence"]
                if metadata.get("version") != 1 or metadata.get("phrase_id") not in valid_ids:
                    continue
                if sequence.ndim != 2 or sequence.shape[1] != FRAME_FEATURES or not np.isfinite(sequence).all():
                    continue
                samples.append((metadata["phrase_id"], sequence))
            except (ValueError, KeyError, OSError, json.JSONDecodeError):
                continue
        return samples

    def counts(self, valid_ids: set[str]) -> dict[str, int]:
        counts = {phrase_id: 0 for phrase_id in valid_ids}
        for label, _ in self.load(valid_ids):
            counts[label] += 1
        return counts
