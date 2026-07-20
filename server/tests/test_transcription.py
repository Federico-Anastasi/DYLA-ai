"""Tests for server/transcription.py's language default.

faster-whisper itself never runs here (it is slow and needs a downloaded model): what is
guarded is the contract between transcribe()/transcribe_with_timestamps() and
model.transcribe() — specifically, what language gets passed when the caller does not
name one.

Run with: python -m pytest server/tests/test_transcription.py
"""
from server import transcription


class _FakeSegment:
    def __init__(self, text, start=0.0, end=1.0):
        self.text = text
        self.start = start
        self.end = end


class _FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, path, language=None, vad_filter=True, vad_parameters=None):
        self.calls.append(language)
        return [_FakeSegment("hello")], type("Info", (), {"duration": 1.0})()


def test_transcribe_defaults_to_none_letting_whisper_detect(monkeypatch):
    """It used to default to "en": every dictation was transcribed as English regardless
    of what was actually said, unless a caller happened to override it."""
    fake = _FakeModel()
    monkeypatch.setattr(transcription, "_load", lambda profile_name="note": fake)
    transcription.transcribe("fake/path")
    assert fake.calls == [None]


def test_transcribe_with_timestamps_also_defaults_to_none(monkeypatch):
    fake = _FakeModel()
    monkeypatch.setattr(transcription, "_load", lambda profile_name="meeting": fake)
    transcription.transcribe_with_timestamps("fake/path")
    assert fake.calls == [None]


def test_an_explicit_language_still_wins(monkeypatch):
    fake = _FakeModel()
    monkeypatch.setattr(transcription, "_load", lambda profile_name="note": fake)
    transcription.transcribe("fake/path", language="it")
    assert fake.calls == ["it"]
