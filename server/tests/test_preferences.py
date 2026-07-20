"""The language Dyla answers in.

The default matters more than the setting: left alone, nothing is imposed and the agent
replies in whatever language it was written to. That is what someone gets on a clean
machine, and it is the behaviour the setting exists to override, not to enable.

Run: python -m pytest server/tests/test_preferences.py
"""
import pytest

from server import preferences


@pytest.fixture(autouse=True)
def state_file(tmp_path, monkeypatch):
    monkeypatch.setattr(preferences, "STATE_FILE", tmp_path / "preferences.json")


def test_nothing_is_imposed_by_default():
    assert preferences.language() is None
    assert preferences.language_instruction() == ""


def test_a_chosen_language_reaches_the_system_prompt():
    preferences.set_language("Italian")
    assert preferences.language() == "Italian"
    assert "Italian" in preferences.language_instruction()


def test_clearing_it_goes_back_to_following_the_user():
    preferences.set_language("French")
    preferences.set_language("")
    assert preferences.language() is None
    assert preferences.language_instruction() == ""


def test_whitespace_is_not_a_language():
    """Otherwise a stray space in the field silently pins the agent to nothing at all."""
    preferences.set_language("   ")
    assert preferences.language() is None


def test_the_setting_survives_a_restart():
    preferences.set_language("Português")
    assert preferences.language() == "Português"


def test_a_corrupt_file_falls_back_to_the_default(tmp_path):
    """Preferences are not worth refusing to start over."""
    preferences.STATE_FILE.write_text("{not json", encoding="utf-8")
    assert preferences.language() is None


# --- whisper_language(): the same preference, translated for faster-whisper -----------

def test_whisper_language_is_none_with_no_preference():
    """Transcription used to hard-code "en": with nothing chosen, the honest behaviour
    is to let Whisper detect the language, not to silently force English."""
    assert preferences.whisper_language() is None


def test_whisper_language_maps_a_common_language_name_to_its_code():
    preferences.set_language("Italian")
    assert preferences.whisper_language() == "it"
    preferences.set_language("italiano")
    assert preferences.whisper_language() == "it"


def test_whisper_language_passes_through_a_two_letter_code_as_is():
    preferences.set_language("de")
    assert preferences.whisper_language() == "de"


def test_whisper_language_gives_up_gracefully_on_an_unmapped_name():
    """Free text that is not one of the languages we know how to map must not be handed
    to faster-whisper as a bogus code — None (auto-detect) is the safe fallback."""
    preferences.set_language("Klingon")
    assert preferences.whisper_language() is None
