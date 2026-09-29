import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import signvision.web as web
from signvision.tracking import LandmarkTracker, MAX_FRAME_BYTES


def test_tracking_reuses_session_and_closes_on_disconnect(monkeypatch):
    instances = []

    class FakeTracker:
        def __init__(self):
            self.closed = False
            self.frames = 0
            instances.append(self)

        def track_jpeg(self, data):
            self.frames += 1
            return {"type": "landmarks", "hands": [], "pose": [], "inference_ms": 1}

        def close(self):
            self.closed = True

    monkeypatch.setattr(web, "LandmarkTracker", FakeTracker)
    with TestClient(web.app) as client:
        with client.websocket_connect("/api/track") as socket:
            assert socket.receive_json() == {"type": "ready"}
            for _ in range(3):
                socket.send_bytes(b"frame")
                result = socket.receive_json()
                assert result["hands"] == [] and result["pose"] == []
        assert len(instances) == 1
        assert instances[0].frames == 3
        assert instances[0].closed


def test_missing_models_has_actionable_error(monkeypatch):
    def missing():
        raise FileNotFoundError()

    monkeypatch.setattr(web, "LandmarkTracker", missing)
    with TestClient(web.app).websocket_connect("/api/track") as socket:
        assert socket.receive_json() == {"type": "error", "code": "missing_models"}


def test_rejects_cross_origin_camera_connection():
    with pytest.raises(WebSocketDisconnect) as error:
        with TestClient(web.app).websocket_connect("/api/track", headers={"Origin": "https://unrelated.example"}):
            pass
    assert error.value.code == 1008


def test_empty_and_corrupt_frames_are_rejected():
    tracker = LandmarkTracker.__new__(LandmarkTracker)
    for data in (b"", b"not an image", b"x" * (MAX_FRAME_BYTES + 1)):
        with pytest.raises(ValueError, match="invalid_frame"):
            tracker.track_jpeg(data)


def test_decoded_frame_with_no_hands_returns_empty_arrays():
    tracker = LandmarkTracker.__new__(LandmarkTracker)
    tracker.detect = lambda frame: ({}, None)
    ok, jpeg = cv2.imencode(".jpg", np.zeros((120, 160, 3), dtype=np.uint8))
    assert ok
    result = tracker.track_jpeg(jpeg.tobytes())
    assert result["type"] == "landmarks"
    assert result["hands"] == [] and result["pose"] == []
