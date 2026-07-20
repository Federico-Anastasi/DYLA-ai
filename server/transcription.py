"""Local speech transcription (faster-whisper on CPU).

Why local and not a service: dictated notes and meetings name clients, projects and
people. Sending that audio off to an external service is not a call we get to make on
the user's behalf, and it fits the rest of the tool (local-first).

Why faster-whisper and not openai-whisper: same model quality, but several times
faster on CPU thanks to CTranslate2 and int8 quantization.

## Two profiles, not one

The two use cases have opposite economics, so they do not share a model:

- **note** (agenda): a few seconds of speech, with someone waiting for the answer.
  `small` is enough, and it stays resident in memory because dictation is frequent.
- **meeting**: half an hour or more of audio, processed in a background job nobody is
  watching. Here waiting costs almost nothing and errors cost a lot: mangled acronyms
  and surnames end up in the brief, where they can no longer be told apart from what
  was actually said. So `large-v3` — which, however, does NOT stay resident: 3 GB of
  RAM parked for something that happens once per meeting is not worth holding.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

COMPUTE_TYPE = "int8"  # quantized: on CPU it is the only sensible setting
THREADS = 8


@dataclass(frozen=True)
class Profile:
    model: str
    resident: bool
    description: str


PROFILES = {
    # "base" gets proper nouns wrong (and in a note the proper nouns are the content),
    # "medium" doubles the time with no gain you would notice on a few seconds of audio.
    "note": Profile("small", True, "agenda voice notes"),
    # On a meeting the difference between medium and large-v3 is not "understanding the
    # words" but what happens on the uncertain parts: Whisper never admits it did not
    # catch something, it embroiders the most likely word. large-v3 embroiders far less.
    "meeting": Profile("large-v3", False, "meeting recordings"),
}

DEFAULT_PROFILE = "note"

# One model per name. Resident profiles stay here between calls, the others are
# dropped at the end of the job by `unload`.
_models: dict = {}
# Loading is not thread-safe and costs seconds: two parallel requests would load two
# copies of the same model into memory.
_lock = threading.Lock()


class TranscriptionUnavailable(RuntimeError):
    """faster-whisper is not installed, or the model cannot be downloaded."""


def _profile(name: str) -> Profile:
    try:
        return PROFILES[name]
    except KeyError:
        raise ValueError(f"unknown transcription profile: '{name}'") from None


def _load(profile_name: str = DEFAULT_PROFILE):
    p = _profile(profile_name)
    with _lock:
        if p.model in _models:
            return _models[p.model]
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise TranscriptionUnavailable(
                "faster-whisper is not installed: pip install -r requirements.txt") from e
        try:
            model = WhisperModel(p.model, device="cpu",
                                 compute_type=COMPUTE_TYPE, cpu_threads=THREADS)
        except Exception as e:
            # Typically: first run with no network, so the model does not download.
            # large-v3 weighs ~3 GB: the first meeting pays for the download.
            raise TranscriptionUnavailable(
                f"model '{p.model}' unavailable: {e}") from e
        _models[p.model] = model
        return model


def unload(profile_name: str) -> None:
    """Drops a non-resident profile's model from memory. Resident profiles stay:
    that is the whole point of them."""
    p = _profile(profile_name)
    if p.resident:
        return
    with _lock:
        _models.pop(p.model, None)


def ready(profile_name: str = DEFAULT_PROFILE) -> bool:
    """True if that profile's model is already in memory (the next transcription
    starts right away, without paying for the load)."""
    return _profile(profile_name).model in _models


def preload() -> None:
    """Loads the resident models in the background. Without this, the first dictation
    of the day pays ~8 seconds of waiting out of nowhere."""
    for name, p in PROFILES.items():
        if not p.resident:
            continue
        try:
            _load(name)
        except TranscriptionUnavailable:
            pass  # the endpoint reports the problem when the user actually tries


def _segments(path, language: str, profile_name: str):
    """(segment iterator, duration in seconds). The iterator is lazy: transcription
    happens as it is consumed, and that is where progress gets measured."""
    model = _load(profile_name)
    segments, info = model.transcribe(
        str(path),
        language=language,
        # The VAD strips silence before transcription: speech is half pauses, and
        # without the filter Whisper embroiders hallucinations over them.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    return segments, float(getattr(info, "duration", 0.0) or 0.0)


def transcribe(path, language: str | None = None, profile: str = DEFAULT_PROFILE) -> str:
    """The speech in the audio file, on one line. Empty string if there is no voice.

    `language` is a Whisper language code (e.g. "it", "en"), or None to let Whisper
    detect it from the audio itself — the right default when nobody has actually said
    which language to expect. Callers wire this to the user's language preference (see
    server/preferences.py); it used to be hard-coded to "en" here, which meant every
    dictation and every meeting was transcribed as English regardless of what was
    actually spoken.
    """
    segments, _duration = _segments(path, language, profile)
    return " ".join(s.text.strip() for s in segments).strip()


def _mmss(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def transcribe_with_timestamps(path, language: str | None = None, profile: str = "meeting",
                               progress=None, interrupted=None) -> str:
    """Long transcription, one line per segment, with the timestamp up front.

    The timestamp is not a flourish: over an hour of meeting it is the only way back
    to the audio when a sentence does not add up, and without the original audio a
    doubtful transcription cannot be checked at all.

    `progress(fraction)` is called as it goes (0.0-1.0), `interrupted()` is polled
    between one segment and the next so the job can stop on request.
    """
    segments, duration = _segments(path, language, profile)
    lines: list[str] = []
    for s in segments:
        if interrupted is not None and interrupted():
            break
        text = s.text.strip()
        if text:
            lines.append(f"[{_mmss(s.start)}] {text}")
        if progress is not None and duration > 0:
            progress(min(1.0, float(s.end) / duration))
    if progress is not None:
        progress(1.0)
    return "\n".join(lines)
