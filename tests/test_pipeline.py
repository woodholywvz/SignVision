from dataclasses import dataclass

import numpy as np
import pytest

from signvision.classifier import classify, dtw_distance
from signvision.normalize import (
    FRAME_FEATURES,
    HAND_FEATURES,
    frame_features,
    hand_present,
    resample_sequence,
)


@dataclass
class Landmark:
    x: float
    y: float
    z: float = 0.0


def hand(shift_x=0.0, shift_y=0.0):
    return [Landmark(0.3 + shift_x + i * 0.005, 0.4 + shift_y + i * 0.004) for i in range(21)]


def pose(shift_x=0.0, shift_y=0.0):
    points = [Landmark(0.5 + shift_x, 0.5 + shift_y) for _ in range(33)]
    points[11] = Landmark(0.4 + shift_x, 0.4 + shift_y)
    points[12] = Landmark(0.6 + shift_x, 0.4 + shift_y)
    return points


def test_absent_hands_are_masked_and_finite():
    frame = frame_features({}, None)
    assert frame.shape == (FRAME_FEATURES,)
    assert np.isfinite(frame).all()
    assert not hand_present(frame)
    assert not frame[0] and not frame[HAND_FEATURES]


def test_translation_and_scale_normalization():
    a = frame_features({"Left": hand()}, pose())
    b = frame_features({"Left": hand(0.1, 0.2)}, pose(0.1, 0.2))
    np.testing.assert_allclose(a, b, atol=1e-5)
    assert hand_present(a)


def test_hand_depth_does_not_depend_on_pose_depth():
    fingers = hand()
    for index, point in enumerate(fingers):
        point.z = index * 0.01
    body = pose()
    for point in body:
        point.z = 0.8
    result = frame_features({"Left": fingers}, body)
    assert result[3] == 0
    assert result[-6 + 2] == 0


def test_variable_length_resampling_and_missing_hand():
    visible = frame_features({"Left": hand()}, pose())
    missing = frame_features({}, pose())
    for count in (1, 8, 17, 96):
        result = resample_sequence([visible] * count, target=32)
        assert result.shape == (32, FRAME_FEATURES)
        np.testing.assert_allclose(result[0], visible)
    mixed = resample_sequence([visible, missing], target=32)
    assert set(np.unique(mixed[:, 0])) == {0, 1}
    assert np.all(mixed[mixed[:, 0] == 0, 1:HAND_FEATURES] == 0)


def test_dtw_handles_length_change_and_unknown():
    original = np.stack([frame_features({"Left": hand(i * 0.01)}, pose()) for i in range(12)])
    stretched = resample_sequence(original, 20)
    assert dtw_distance(resample_sequence(original), resample_sequence(stretched)) < 0.1
    result = classify(original, [("hello", stretched)], neighbors=1, max_distance=0.2, min_margin=0)
    assert result.phrase_id == "hello"
    unknown = classify(
        np.zeros_like(original),
        [("hello", stretched)],
        neighbors=1,
        max_distance=0.01,
        min_margin=0,
    )
    assert unknown.phrase_id is None


def test_invalid_empty_sequence():
    with pytest.raises(ValueError):
        resample_sequence([])


def test_more_examples_of_wrong_phrase_do_not_outvote_exact_match():
    exact = np.stack([frame_features({"Left": hand(i * 0.01)}, pose()) for i in range(12)])
    other = np.stack([frame_features({"Left": hand(0.12 + i * 0.01)}, pose()) for i in range(12)])
    result = classify(
        exact,
        [("correct", exact), ("other", other), ("other", other)],
        neighbors=3,
        max_distance=0.30,
        min_margin=0.05,
    )
    assert result.phrase_id == "correct"
