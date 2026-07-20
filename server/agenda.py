"""The user's personal agenda: the day's tasks, cutting across projects.

It is not a deliverable and it does not belong to a project — it lives in
`runtime/agenda.json` and shows up on the home page. A task may concern no project at
all ("call HR"), one project, or several at once.

Voice dictation goes through here: the audio is transcribed by faster-whisper locally
(server/transcription.py), and Haiku turns the raw text into separate items. The model
proposes, the user confirms: nothing is ever written to the agenda without review.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

import jsonschema

from .config import ROOT, RUNTIME_DIR

AGENDA_FILE = "agenda.json"
SCHEMA = ROOT / "schemas" / "agenda.schema.json"


def _path() -> Path:
    return RUNTIME_DIR / AGENDA_FILE


def _empty() -> dict:
    return {"meta": {"date": date.today().isoformat()}, "items": []}


def load() -> dict:
    f = _path()
    if not f.is_file():
        return _empty()
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # An unreadable agenda must not stop the app from opening: we start from an
        # empty one, and the broken file stays there for whoever wants to salvage it.
        return _empty()


def save(data: dict) -> None:
    """Validates and writes. Raises jsonschema.ValidationError if the data is off."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    jsonschema.validate(instance=data, schema=schema)
    _check(data)
    f = _path()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _check(data: dict) -> None:
    """Rules that cannot be expressed in the schema."""
    ids = [v["id"] for v in data.get("items", [])]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise jsonschema.ValidationError(f"duplicate ids: {', '.join(sorted(dupes))}")


def next_id(items: list) -> str:
    numbers = [int(m.group(1)) for v in items
               if (m := re.match(r"^A(\d+)$", v.get("id", "")))]
    return f"A{max(numbers, default=0) + 1}"


# --- time bands: this is how the agenda actually gets read ---

def band(item: dict, today: date | None = None) -> str:
    """Which group on the home page this item lands in."""
    today = today or date.today()
    if item.get("status") == "done":
        return "done"
    due = item.get("due")
    if not due:
        return "undated"
    try:
        day = date.fromisoformat(due)
    except ValueError:
        # The schema only checks the YYYY-MM-DD pattern, not that the date actually
        # exists: "2026-13-45" passes save() and would otherwise blow up every load()
        # that follows, leaving the whole agenda unusable until someone edits the JSON
        # by hand. An invalid date is not lost — dictation._clean already discards these
        # before they are ever written — so treating it as "no date" here is the same
        # call, just defended a second time for whatever reaches this file another way.
        return "undated"
    if day < today:
        return "overdue"
    if day == today:
        return "today"
    if day == today + timedelta(days=1):
        return "tomorrow"
    # Up to the Sunday of the current week: beyond that, it is "later".
    if day <= today + timedelta(days=6 - today.weekday()):
        return "this_week"
    return "later"


def group(data: dict, today: date | None = None) -> dict:
    """Items by band, in the order they get read."""
    bands = {k: [] for k in
             ("overdue", "today", "tomorrow", "this_week", "later", "undated", "done")}
    for item in data.get("items", []):
        bands[band(item, today)].append(item)
    for name, items in bands.items():
        # Within a band: nearest dates first, then time of day, then priority.
        # Time outranks priority because a day reads top to bottom the way it is
        # lived: a 9am task sits above a 5pm one even when the 5pm one is urgent.
        # Items with no time sink to the end of their day.
        weight = {"high": 0, "medium": 1, "low": 2}
        items.sort(key=lambda v: (v.get("due") or "9999-12-31",
                                  v.get("time") or "99:99",
                                  weight.get(v.get("priority"), 1)))
    return bands
