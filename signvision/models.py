"""Download official MediaPipe Tasks model bundles for first setup."""
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parent.parent / "models"
BASE = "https://storage.googleapis.com/mediapipe-models"
MODELS = {
    "hand_landmarker.task": f"{BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "pose_landmarker_lite.task": f"{BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
}


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, url in MODELS.items():
        destination = ROOT / name
        if destination.exists():
            print(f"Уже есть: {destination}")
            continue
        temporary = destination.with_suffix(".download")
        try:
            print(f"Загрузка {name}...")
            urlretrieve(url, temporary)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
