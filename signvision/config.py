from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


@dataclass(frozen=True)
class Phrase:
    id: str
    text: str
    en: str | None = None

    def localized(self, locale: str) -> str:
        return self.en if locale == "en" and self.en else self.text


@dataclass(frozen=True)
class Settings:
    phrases: tuple[Phrase, ...]
    neighbors: int
    max_distance: float
    min_margin: float
    min_frames: int
    max_frames: int
    target_frames: int
    sample_fps: int
    min_hand_ratio: float
    max_video_mb: int

    def phrase(self, phrase_id: str) -> Phrase:
        for phrase in self.phrases:
            if phrase.id == phrase_id:
                return phrase
        raise ValueError(f"Неизвестная фраза: {phrase_id}")


def load_settings(path: Path = ROOT / "config.yaml") -> Settings:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    phrases = tuple(Phrase(**item) for item in raw["phrases"])
    if not phrases or len({p.id for p in phrases}) != len(phrases):
        raise ValueError("Список фраз должен быть непустым, ID должны быть уникальны")
    if any(
        not ID_PATTERN.fullmatch(p.id)
        or not p.text.strip()
        or (p.en is not None and not p.en.strip())
        for p in phrases
    ):
        raise ValueError("Неверный ID или текст фразы")
    r = raw["recognition"]
    settings = Settings(phrases=phrases, **r)
    if not (
        1 <= settings.neighbors <= 20
        and 0 < settings.min_frames < settings.max_frames
        and settings.target_frames >= 2
        and settings.sample_fps >= 1
        and 0 <= settings.min_hand_ratio <= 1
        and settings.max_video_mb > 0
        and settings.max_distance > 0
        and settings.min_margin >= 0
    ):
        raise ValueError("Неверные параметры распознавания")
    return settings
