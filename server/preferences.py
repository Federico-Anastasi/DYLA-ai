"""Preferences that belong to the person using Dyla, not to the machine or the model.

There is one so far — the language the agent answers in — and it lives here rather than
in models.json because that file describes which GGUF runs and how much context it gets:
a preference about how Dyla talks to you does not become a property of the engine just
because there was already a file to put it in.

Left unset, nothing is imposed and the agent answers in whatever language you wrote in.
That is the right default: Dyla should speak the user's language, and on most machines
it already does without being told.
"""
from __future__ import annotations

import json

from .config import RUNTIME_DIR

STATE_FILE = RUNTIME_DIR / "preferences.json"


def _state() -> dict:
    if not STATE_FILE.is_file():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # A corrupt preferences file must not stop the app from starting: the worst it
        # can cost is falling back to the defaults, which are what most people run with.
        return {}


def _save(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def language() -> str | None:
    """The language the agent must answer in, or None to follow the conversation."""
    value = (_state().get("language") or "").strip()
    return value or None


def set_language(value: str | None) -> str | None:
    """Sets it, or clears it when given nothing. Free text on purpose: picking which
    languages exist is not a decision this project gets to make for its users."""
    state = _state()
    cleaned = (value or "").strip()
    if cleaned:
        state["language"] = cleaned
    else:
        state.pop("language", None)
    _save(state)
    return cleaned or None


def language_instruction() -> str:
    """The line appended to the system prompt, empty when the user has not chosen."""
    chosen = language()
    return f"\n\n## Language\nAlways answer in {chosen}, whatever language the user writes in.\n" if chosen else ""


# A small map of the languages someone is likely to actually type, not an attempt at
# covering all ~100 Whisper knows: language() is deliberately free text (see above), but
# faster-whisper's `language=` parameter only accepts its own short ISO 639-1 codes, and
# passing it "Italian" verbatim would not do what the two-letter code does.
_WHISPER_CODES = {
    "italian": "it", "italiano": "it",
    "english": "en", "inglese": "en",
    "french": "fr", "francese": "fr",
    "german": "de", "tedesco": "de",
    "spanish": "es", "spagnolo": "es",
    "portuguese": "pt", "portoghese": "pt",
    "dutch": "nl", "olandese": "nl",
}


def whisper_language() -> str | None:
    """The language preference as a code faster-whisper understands, or None to let it
    detect the language from the audio.

    Transcription used to hard-code "en" regardless of this preference (or of what was
    actually said): every dictation and every meeting recording was transcribed as
    English. If nothing is chosen, or the chosen text is not one we can map to a code, the
    honest answer is "let Whisper decide" — not silently forcing English.
    """
    chosen = language()
    if not chosen:
        return None
    key = chosen.strip().lower()
    if len(key) == 2 and key.isalpha():
        return key
    return _WHISPER_CODES.get(key)
