"""Personal agenda: time bands, CRUD and turning dictated speech into items.

The bands are how the agenda actually gets read ("what do I have to do today"), so they
are the part worth guarding: a mistake there breaks nothing loudly, it just quietly
hides an overdue task.

Run with: python -m pytest server/tests/test_agenda.py
"""
from datetime import date

import jsonschema
import pytest
from fastapi.testclient import TestClient

from server import agenda, dictation, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Agenda on a temporary file: the tests must never touch the real one."""
    monkeypatch.setattr(agenda, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(main, "PROJECTS_DIR", tmp_path / "projects")
    (tmp_path / "projects").mkdir()
    return TestClient(main.app)


# --- bands ---

# A Wednesday: the current week runs out on Sunday the 26th.
TODAY = date(2026, 7, 22)


@pytest.mark.parametrize("due,expected", [
    ("2026-07-20", "overdue"),
    ("2026-07-22", "today"),
    ("2026-07-23", "tomorrow"),
    ("2026-07-26", "this_week"),   # Sunday: last day of the current week
    ("2026-07-27", "later"),       # the Monday after
    (None, "undated"),
])
def test_band(due, expected):
    item = {"id": "A1", "text": "x", "status": "open"}
    if due:
        item["due"] = due
    assert agenda.band(item, TODAY) == expected


def test_an_invalid_due_date_does_not_break_the_bands():
    """The schema only checks the YYYY-MM-DD pattern, not that the date exists:
    "2026-13-45" passes save() and used to blow up every band()/group() call after
    that — the whole agenda became unreadable until the JSON was fixed by hand."""
    item = {"id": "A1", "text": "x", "status": "open", "due": "2026-13-45"}
    assert agenda.band(item, TODAY) == "undated"


def test_a_done_item_leaves_the_time_bands():
    """Even one that was overdue: once it is done it must stop showing up among the
    things to do, otherwise the backlog never empties."""
    item = {"id": "A1", "text": "x", "status": "done", "due": "2026-01-01"}
    assert agenda.band(item, TODAY) == "done"


def test_group_sorts_by_date_then_priority():
    data = {"meta": {"date": "2026-07-22"}, "items": [
        {"id": "A1", "text": "medium, today", "status": "open", "due": "2026-07-22"},
        {"id": "A2", "text": "high, today", "status": "open", "due": "2026-07-22",
         "priority": "high"},
    ]}
    today = agenda.group(data, TODAY)["today"]
    assert [v["id"] for v in today] == ["A2", "A1"]


def test_group_sorts_the_day_by_time():
    """Within a day, time outranks priority: a day reads top to bottom the way it is
    lived, and 9am comes before 5pm even when the 5pm thing is the urgent one."""
    data = {"meta": {"date": "2026-07-22"}, "items": [
        {"id": "A1", "text": "urgent but late", "status": "open",
         "due": "2026-07-22", "time": "17:00", "priority": "high"},
        {"id": "A2", "text": "first thing", "status": "open",
         "due": "2026-07-22", "time": "09:00"},
        {"id": "A3", "text": "no time", "status": "open", "due": "2026-07-22"},
    ]}
    today = agenda.group(data, TODAY)["today"]
    # Items with no time sink to the end of the day rather than competing with those
    # that have one.
    assert [v["id"] for v in today] == ["A2", "A1", "A3"]


def test_next_id_carries_on_from_the_highest():
    items = [{"id": "A1"}, {"id": "A7"}, {"id": "A3"}]
    assert agenda.next_id(items) == "A8"
    assert agenda.next_id([]) == "A1"


def test_duplicate_ids_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(agenda, "RUNTIME_DIR", tmp_path)
    data = {"meta": {"date": "2026-07-22"}, "items": [
        {"id": "A1", "text": "a", "status": "open"},
        {"id": "A1", "text": "b", "status": "open"},
    ]}
    with pytest.raises(jsonschema.ValidationError):
        agenda.save(data)


def test_an_unreadable_agenda_does_not_block_startup(tmp_path, monkeypatch):
    """A corrupt file must degrade to an empty agenda, not stop the app being used."""
    monkeypatch.setattr(agenda, "RUNTIME_DIR", tmp_path)
    (tmp_path / "agenda.json").write_text("{not json", encoding="utf-8")
    assert agenda.load()["items"] == []


# --- API ---

def test_lifecycle_of_an_item(client):
    r = client.post("/api/agenda/items", json=[{"text": "call Rossi", "priority": "high"}])
    assert r.status_code == 201
    (vid,) = r.json()["added"]

    item = client.patch(f"/api/agenda/items/{vid}", json={"due": "2026-12-01"}).json()
    assert item["due"] == "2026-12-01"

    # The completion date is set by the backend: it is a fact, not a field the UI sends.
    done = client.patch(f"/api/agenda/items/{vid}", json={"status": "done"}).json()
    assert done["completed"]

    # Reopening an item must clear the completion date, not leave it behind.
    reopened = client.patch(f"/api/agenda/items/{vid}", json={"status": "open"}).json()
    assert "completed" not in reopened

    assert client.delete(f"/api/agenda/items/{vid}").status_code == 200
    assert client.delete(f"/api/agenda/items/{vid}").status_code == 404


def test_null_removes_an_optional_field(client):
    """This is how a date gets taken off an item: without it, the item would stay
    scheduled forever."""
    (vid,) = client.post("/api/agenda/items",
                         json=[{"text": "x", "due": "2026-12-01"}]).json()["added"]
    assert "due" not in client.patch(f"/api/agenda/items/{vid}", json={"due": None}).json()


def test_an_item_with_no_text_is_rejected(client):
    assert client.post("/api/agenda/items", json=[{"text": "   "}]).status_code == 400


def test_projects_may_be_several_or_free_text(client):
    """A task can span several projects, or name one that has not been opened yet."""
    (vid,) = client.post("/api/agenda/items", json=[
        {"text": "joint meeting", "projects": ["booking-portal", "work-not-opened-yet"]},
    ]).json()["added"]
    item = next(v for v in client.get("/api/agenda").json()["items"] if v["id"] == vid)
    assert item["projects"] == ["booking-portal", "work-not-opened-yet"]


def test_the_agenda_exposes_the_bands(client):
    client.post("/api/agenda/items", json=[{"text": "no date"}])
    buckets = client.get("/api/agenda").json()["buckets"]
    assert len(buckets["undated"]) == 1
    assert buckets["today"] == []


def test_parsing_empty_text_invents_nothing(client):
    r = client.post("/api/agenda/parse", json={"text": "   "})
    assert r.json()["items"] == []
    assert r.json()["reason"]


def test_dictation_uses_the_language_preference_not_a_hard_coded_english(client, monkeypatch):
    """Transcription used to hard-code language="en": every dictation was transcribed as
    English no matter what the user's language preference said, or what was actually
    spoken."""
    captured = {}

    def fake_transcribe(path, language=None, profile="note"):
        captured["language"] = language
        return "ciao"
    monkeypatch.setattr(main.transcription, "transcribe", fake_transcribe)
    monkeypatch.setattr(main.preferences, "whisper_language", lambda: "it")
    async def fake_structure(*a, **k):
        return []
    monkeypatch.setattr(main.dictation_mod, "structure", fake_structure)

    r = client.post("/api/agenda/dictation",
                    files={"audio": ("note.webm", b"fake-audio", "audio/webm")})
    assert r.status_code == 200
    assert captured["language"] == "it"


def test_two_dictations_do_not_share_the_same_temp_file(client, monkeypatch):
    """A fixed temp filename (".dictation{suffix}") meant two dictations in flight at
    once — two tabs, or a second request fired before the first finished writing —
    overwrote each other's audio mid-write."""
    seen_paths = []

    def fake_transcribe(path, language=None, profile="note"):
        seen_paths.append(str(path))
        return "x"
    monkeypatch.setattr(main.transcription, "transcribe", fake_transcribe)
    async def fake_structure(*a, **k):
        return []
    monkeypatch.setattr(main.dictation_mod, "structure", fake_structure)

    client.post("/api/agenda/dictation", files={"audio": ("a.webm", b"1", "audio/webm")})
    client.post("/api/agenda/dictation", files={"audio": ("b.webm", b"2", "audio/webm")})
    assert len(seen_paths) == 2
    assert seen_paths[0] != seen_paths[1]


def test_dictation_and_parse_are_two_separate_endpoints(client):
    """An UploadFile and a Body in the same signature would make FastAPI read the whole
    request as form-data, and the JSON would be ignored in silence: the text always
    arrived empty. This test guards the separation."""
    # /parse takes JSON and really does read it
    r = client.post("/api/agenda/parse", json={"text": "   "})
    assert r.status_code == 200
    # /dictation wants a file: without one it must refuse rather than answer "nothing"
    assert client.post("/api/agenda/dictation", json={"text": "x"}).status_code == 422


# --- turning speech into items (without calling the model) ---

def test_the_calendar_names_each_day_correctly():
    """The calendar exists because Haiku miscounts weekdays: if this mapping is wrong,
    the very error it was meant to prevent comes back."""
    cal = dictation._calendar(date(2026, 7, 22), days=3)
    lines = cal.splitlines()
    assert lines[0] == "- Wednesday 2026-07-22 (today)"
    assert lines[1] == "- Thursday 2026-07-23 (tomorrow)"
    assert lines[2] == "- Friday 2026-07-24"


def test_clean_discards_invalid_dates():
    """An item with no date beats an item with an invented one: the second lands in the
    wrong band and nobody notices."""
    items = dictation._clean([
        {"text": "fine", "due": "2026-07-23"},
        {"text": "impossible date", "due": "2026-02-31"},
        {"text": "date in words", "due": "Thursday"},
    ])
    assert [v.get("due") for v in items] == ["2026-07-23", None, None]


def test_clean_drops_items_with_no_text_and_unknown_fields():
    items = dictation._clean([
        {"text": "  "},
        {"not_an_item": True},
        {"text": "valid", "priority": "highest", "invented": "x"},
    ])
    assert len(items) == 1
    assert items[0]["text"] == "valid"
    assert "priority" not in items[0]  # "highest" is not an allowed value
    assert "invented" not in items[0]


def test_extract_json_tolerates_a_code_fence():
    """The model sometimes wraps the answer in ```json despite being told not to."""
    assert dictation._extract_json('```json\n[{"text": "x"}]\n```') == [{"text": "x"}]
    assert dictation._extract_json('here you go: [{"text": "x"}] hope that works') == [{"text": "x"}]
    assert dictation._extract_json("there is no array here at all") is None
