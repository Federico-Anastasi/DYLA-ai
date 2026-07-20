"""Semantic validation of the living documents (server/documents.py).

These are the rules JSON Schema cannot express, and they are the ones that matter: a
document that satisfies the schema but breaks one of these is a document that looks fine
and is quietly wrong — an estimate whose totals do not add up, or a plan that schedules
the same item twice.
"""
import pytest
from jsonschema import ValidationError

from server import documents


def _estimate(task_days: float, dev_task_days: list[float]) -> dict:
    return {
        "meta": {"project": "t", "title": "E", "date": "2026-07-19", "contingency_pct": 15},
        "epics": [{
            "id": "E1", "name": "1. Epic",
            "tasks": [{
                "id": "E1.T1", "task": "Task", "days": task_days, "description": "",
                "dev_tasks": [
                    {"id": f"E1.T1.D{i}", "dev_task": f"Dev {i}", "description": "",
                     "days": d, "layer": 1}
                    for i, d in enumerate(dev_task_days, 1)
                ],
            }],
        }],
    }


def _timeline(team: list, lanes: list | None = None) -> dict:
    doc = {
        "meta": {"project": "t", "date": "2026-07-19"},
        "start_date": "2026-09-07",
        "team": team,
    }
    if lanes is not None:
        doc["lanes"] = lanes
    return doc


# --- estimate: the hierarchy adds up from the bottom ---------------------------

def test_a_task_must_equal_the_sum_of_its_dev_tasks():
    documents._check_dev_tasks_sums(_estimate(3.0, [1.25, 1.75]))  # adds up: no raise
    with pytest.raises(ValidationError, match="E1.T1"):
        documents._check_dev_tasks_sums(_estimate(3.0, [1.0, 1.0]))


def test_a_task_without_dev_tasks_keeps_its_own_estimate():
    """Before the breakdown is done, task.days is the directly estimated value: it must
    not be compared against an empty sum and flagged as inconsistent."""
    documents._check_dev_tasks_sums(_estimate(3.0, []))


def test_floating_point_noise_does_not_fail_the_sum():
    documents._check_dev_tasks_sums(_estimate(0.3, [0.1, 0.1, 0.1]))


# --- timeline: the plan has to be a plan ---------------------------------------

def test_duplicate_developer_ids_are_rejected():
    with pytest.raises(ValidationError, match="duplicate"):
        documents._check_timeline_refs(_timeline(
            [{"id": "d1", "name": "Alice"}, {"id": "d1", "name": "Bruno"}]))


def test_a_lane_must_belong_to_someone_on_the_team():
    with pytest.raises(ValidationError, match="not part of the team"):
        documents._check_timeline_refs(_timeline(
            [{"id": "d1", "name": "Alice"}],
            [{"dev": "ghost", "items": ["E1.T1.D1"]}]))


def test_an_item_cannot_sit_in_two_lanes():
    """An item in two lanes would be planned twice, and the totals would silently count
    the work of one person as the work of two."""
    with pytest.raises(ValidationError, match="more than one lane"):
        documents._check_timeline_refs(_timeline(
            [{"id": "d1", "name": "Alice"}, {"id": "d2", "name": "Bruno"}],
            [{"dev": "d1", "items": ["E1.T1.D1"]}, {"dev": "d2", "items": ["E1.T1.D1"]}]))


def test_a_leave_range_must_not_end_before_it_starts():
    """A backwards range never matches any day, so the developer would silently be
    treated as available through their whole holiday."""
    with pytest.raises(ValidationError, match="leave for 'd1'"):
        documents._check_timeline_refs(_timeline([
            {"id": "d1", "name": "Alice",
             "leave": [{"from": "2026-09-16", "to": "2026-09-14"}]},
        ]))


def test_a_well_formed_leave_range_passes():
    documents._check_timeline_refs(_timeline([
        {"id": "d1", "name": "Alice",
         "leave": [{"from": "2026-09-14", "to": "2026-09-16"}]},
    ]))


# --- the other documents --------------------------------------------------------

def test_a_requirement_must_point_at_a_chapter_that_exists():
    doc = {
        "meta": {"project": "t", "title": "B", "date": "2026-07-19"},
        "chapters": [{"id": "C1", "title": "Context", "body": "text"}],
        "requirements": [{"id": "R1", "title": "R", "description": "d", "chapter": "C9"}],
    }
    with pytest.raises(ValidationError, match="C9"):
        documents._check_brief(doc)


def test_an_answered_question_must_carry_its_answer():
    """A question marked answered with nothing written down is a lost question, and not
    losing them is the only reason the queue exists."""
    doc = {
        "meta": {"project": "t", "date": "2026-07-19"},
        "questions": [{"id": "Q1", "question": "Which rooms?", "status": "answered"}],
    }
    with pytest.raises(ValidationError, match="Q1"):
        documents._check_questions(doc)


def test_test_plan_steps_must_be_numbered_from_one_without_gaps():
    doc = {
        "meta": {"project": "t", "title": "TP", "date": "2026-07-19"},
        "cases": [{"id": "TC1", "title": "C", "epic": "E1",
                   "steps": [{"n": 1, "action": "a"}, {"n": 3, "action": "b"}]}],
    }
    with pytest.raises(ValidationError, match="TC1"):
        documents._check_test_plan(doc)


def test_a_slide_layout_must_have_the_content_it_needs():
    """Otherwise the slide comes out empty in the export, and you only find out by
    opening the pptx."""
    doc = {
        "meta": {"project": "t", "title": "D", "client": "Acme",
                 "date": "2026-07-19", "type": "status"},
        "slides": [{"id": "S1", "layout": "table", "title": "No table here"}],
    }
    with pytest.raises(ValidationError, match="table"):
        documents._check_deck(doc)


# --- a document left half-written -------------------------------------------------

def test_a_truncated_document_says_what_happened(tmp_path, monkeypatch):
    """The agent writes these files itself, and a turn that stops during a long write
    leaves a truncated one behind — we watched it happen on a 57 KB estimate. Letting the
    raw JSON error escape tells the reader nothing, while a previous version sits in
    .versions/ one restore away."""
    monkeypatch.setattr(documents, "PROJECTS_DIR", tmp_path)
    d = tmp_path / "demo"
    d.mkdir()
    (d / "estimate.json").write_text('{"meta": {"title": "half a fi', encoding="utf-8")

    with pytest.raises(documents.DocumentUnreadable) as e:
        documents.load_doc("demo", "estimate")

    assert "estimate.json" in str(e.value)
    assert "restore" in str(e.value).lower(), "the message has to say what to do"


def test_a_missing_document_is_still_just_missing(tmp_path, monkeypatch):
    """Not there and not readable are different situations and must not be conflated:
    one is the normal state of a project that has not got there yet."""
    monkeypatch.setattr(documents, "PROJECTS_DIR", tmp_path)
    (tmp_path / "demo").mkdir()
    assert documents.load_doc("demo", "estimate") is None
