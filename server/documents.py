"""Living documents: estimate.json, data_model.json, mockup.json.

These JSON files are the source of truth for the structured deliverables. The
skills read and write them (validated against schemas/*.schema.json); the
xlsx/drawio/html exports are generated on demand by the backend (see
server/exports.py and server/mockup_export.py).

estimate.json also carries the dev task breakdown (epics[].tasks[].dev_tasks[]) —
there is no separate dev_tasks.json anymore. On top of JSON Schema validation,
save_doc applies a semantic check specific to "estimate": for every task with a
non-empty dev_tasks list, task.days must equal the sum of dev_tasks[].days (the
hierarchy adds up from the bottom).
"""
import json
from functools import lru_cache
from pathlib import Path

import jsonschema

from .config import PROJECTS_DIR, ROOT
from .versioning import snapshot

DOC_NAMES = {"estimate", "data_model", "mockup", "timeline",
             # The brief we write ourselves (only projects with source
             # "discovery"), the queue of open questions to the client, the
             # people involved, the test plan and the slide deck.
             "brief", "questions", "people", "test_plan", "deck"}

SCHEMAS_DIR = ROOT / "schemas"


@lru_cache(maxsize=None)
def _load_schema(doc: str) -> dict:
    f = SCHEMAS_DIR / f"{doc}.schema.json"
    return json.loads(f.read_text(encoding="utf-8"))


def _doc_path(project: str, doc: str) -> Path:
    return PROJECTS_DIR / project / f"{doc}.json"


class DocumentUnreadable(ValueError):
    """The file is there but is not valid JSON — half-written, or interrupted."""


def load_doc(project: str, doc: str) -> dict | None:
    """Load the document JSON, or None if it does not exist.

    A file that exists but does not parse is a different situation from a missing one,
    and it happens for a real reason: the agent writes these documents itself, and a turn
    that stops in the middle of a long write leaves a truncated file behind. Letting the
    JSON error escape as an unexplained failure tells the reader nothing about what to do
    — while a previous version is sitting in `.versions/`, one restore away.
    """
    f = _doc_path(project, doc)
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise DocumentUnreadable(
            f"{doc}.json is not readable ({e.msg}, line {e.lineno}). It was probably left "
            f"half-written by an interrupted turn — restore the previous version from the "
            f"document's history.") from e


def _check_dev_tasks_sums(data: dict) -> None:
    """Semantic validation of estimate.json that JSON Schema cannot express: for
    every task with a non-empty 'dev_tasks' list, 'days' must equal the sum of
    dev_tasks[].days (0.001 tolerance for floating point rounding).

    Raises jsonschema.ValidationError — the same type the schema validation
    raises, so callers (see server/main.py::put_doc) handle both uniformly —
    with a message naming the inconsistent task id.
    """
    for epic in data.get("epics", []):
        for task in epic.get("tasks", []):
            dev_tasks = task.get("dev_tasks") or []
            if not dev_tasks:
                continue
            total = sum(dt["days"] for dt in dev_tasks)
            if abs(task["days"] - total) > 0.001:
                raise jsonschema.ValidationError(
                    f"task '{task['id']}': days ({task['days']}) does not match the sum "
                    f"of its dev tasks ({total}) — the hierarchy adds up from the bottom"
                )


def _check_timeline_refs(data: dict) -> None:
    """Semantic validation of timeline.json that JSON Schema cannot express:
    developer ids must be unique, every lane must point at an existing developer,
    no item may be assigned to two lanes, and every leave range must have
    'from' <= 'to'.

    Dates compare correctly as plain strings: the schema constrains them to
    YYYY-MM-DD, which sorts lexicographically.
    """
    ids = [d["id"] for d in data.get("team", [])]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise jsonschema.ValidationError(
            f"team: duplicate developer ids ({', '.join(sorted(duplicates))})"
        )

    for dev in data.get("team", []):
        for period in dev.get("leave") or []:
            if period["from"] > period["to"]:
                raise jsonschema.ValidationError(
                    f"leave for '{dev['id']}': 'from' ({period['from']}) is later "
                    f"than 'to' ({period['to']})"
                )

    known = set(ids)
    seen: set[str] = set()
    for lane in data.get("lanes") or []:
        if lane["dev"] not in known:
            raise jsonschema.ValidationError(
                f"lane of '{lane['dev']}': developer is not part of the team"
            )
        # An item sitting in two lanes would be planned twice: that is not a plan.
        for item in lane["items"]:
            if item in seen:
                raise jsonschema.ValidationError(
                    f"item '{item}' appears in more than one lane"
                )
            seen.add(item)


def _check_unique_ids(items: list, label: str) -> None:
    ids = [x.get("id") for x in items]
    dupes = {i for i in ids if i and ids.count(i) > 1}
    if dupes:
        raise jsonschema.ValidationError(
            f"{label}: duplicate ids ({', '.join(sorted(dupes))})")


def _check_brief(data: dict) -> None:
    """Chapters must have unique ids and requirements must point at chapters that
    exist: a requirement hanging off a missing chapter is not traceable, which is
    the only reason the field is there in the first place."""
    chapters = data.get("chapters", [])
    _check_unique_ids(chapters, "chapters")
    known = {c.get("id") for c in chapters}
    _check_unique_ids(data.get("requirements", []), "requirements")
    for req in data.get("requirements", []):
        ref = req.get("chapter")
        if ref and ref not in known:
            raise jsonschema.ValidationError(
                f"requirement '{req.get('id')}': chapter '{ref}' does not exist")


def _check_questions(data: dict) -> None:
    """A question marked 'answered' or 'closed' with no answer written down is a
    lost question — and not losing them is exactly what the queue is for."""
    questions = data.get("questions", [])
    _check_unique_ids(questions, "questions")
    for q in questions:
        if q.get("status") in ("answered", "closed") and not (q.get("answer") or "").strip():
            raise jsonschema.ValidationError(
                f"question '{q.get('id')}': status '{q.get('status')}' but no answer text")


def _check_people(data: dict) -> None:
    _check_unique_ids(data.get("people", []), "people")


def _check_test_plan(data: dict) -> None:
    """Steps must be numbered consecutively from 1: the tester follows them in
    order, and a numbering with gaps or repeats makes the case ambiguous."""
    cases = data.get("cases", [])
    _check_unique_ids(cases, "cases")
    for case in cases:
        numbers = [s.get("n") for s in case.get("steps", [])]
        if numbers != list(range(1, len(numbers) + 1)):
            raise jsonschema.ValidationError(
                f"case '{case.get('id')}': steps must be numbered from 1 with no gaps "
                f"(found: {numbers})")


# Every layout needs its own content: without it the slide comes out empty in the
# export, and you only find out by opening the pptx.
_LAYOUT_REQUIRES = {"list": "bullets", "table": "table", "kpi": "kpi",
                    "timeline": "milestones", "text": "text", "image": "image"}


def _check_deck(data: dict) -> None:
    slides = data.get("slides", [])
    _check_unique_ids(slides, "slides")
    for s in slides:
        field = _LAYOUT_REQUIRES.get(s.get("layout"))
        if field and not s.get(field):
            raise jsonschema.ValidationError(
                f"slide '{s.get('id')}': layout '{s.get('layout')}' requires the field '{field}'")


# Semantic validation per document, on top of JSON Schema. Every function raises
# jsonschema.ValidationError, so server/main.py::put_doc maps them all to 422
# without having to tell the error types apart.
VALIDATORS = {
    "estimate": _check_dev_tasks_sums,
    "timeline": _check_timeline_refs,
    "brief": _check_brief,
    "questions": _check_questions,
    "people": _check_people,
    "test_plan": _check_test_plan,
    "deck": _check_deck,
}


def save_doc(project: str, doc: str, data: dict) -> None:
    """Validate `data` against the document schema, version the existing file (if
    any) and write the new content.

    Raises jsonschema.ValidationError if `data` does not match the schema or
    fails the document's semantic validation (see VALIDATORS).
    """
    schema = _load_schema(doc)
    jsonschema.validate(instance=data, schema=schema)
    validator = VALIDATORS.get(doc)
    if validator:
        validator(data)

    snapshot(project)  # version the current file (if any) before overwriting it

    f = _doc_path(project, doc)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
