from fastapi.testclient import TestClient
import numpy as np

from signvision.normalize import FRAME_FEATURES
from signvision.web import app, message, prediction_payload, settings


def test_phrase_translation_and_fallback():
    phrase = settings.phrase("privet")
    assert phrase.localized("ru") == "Привет"
    assert phrase.localized("en") == "Hello"


def test_api_config_includes_both_phrase_labels():
    payload = TestClient(app).get("/api/config").json()
    assert all(phrase["text"] and phrase["en"] for phrase in payload["phrases"])


def test_api_errors_follow_accept_language():
    client = TestClient(app)
    files = {"video": ("wrong.txt", b"x", "text/plain")}
    response = client.post("/api/recognize", files=files, headers={"Accept-Language": "en-US,en;q=0.9"})
    assert response.status_code == 400
    assert response.json()["detail"].startswith("Upload a")
    response = client.post("/api/recognize", files=files, headers={"Accept-Language": "ru"})
    assert response.json()["detail"].startswith("Нужен")


def test_unknown_result_is_localized():
    sequence = np.zeros((8, FRAME_FEATURES), dtype=np.float32)
    result = prediction_payload(sequence, [], "en")
    assert result["text"] == "Unknown gesture"
    assert result["reason_code"] == "empty_dataset"
    assert result["reason"] == message("en", "empty_dataset")
