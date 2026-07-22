"""Sanity checks on the reference produced by generate_diagram_layout.py, the fixture
shared with web/src/components/Viewer/DiagramView.parity.test.ts (see that generator's
docstring for what the two invariants mean and why 'sequence' and swimlane workflows are
left out). This does not re-derive the invariants independently -- that would just
duplicate the generator's own logic -- it checks that regenerating produces a
self-consistent, non-empty, overlap-free reference, so a broken generator or a fixture
edit that quietly reintroduces the known 'cron'-shaped overlap (plans/diagram-quality-
improvements.md, point 2) fails here instead of only being noticed in the TS suite.
"""

import json
from pathlib import Path

from server.tests.fixtures import generate_diagram_layout as gen

FIXTURES = Path(__file__).parent / "fixtures"
DIAGRAM = json.loads((FIXTURES / "diagram.json").read_text(encoding="utf-8"))


def _regenerate() -> dict:
    diagrams_out: dict = {}
    skipped: dict = {}
    for diagram in DIAGRAM["diagrams"]:
        did, kind = diagram["id"], diagram["kind"]
        if kind == "sequence" or gen.de._has_lanes(diagram):
            skipped[did] = True
            continue
        diagrams_out[did] = {"order": gen._order_for(diagram), "overlaps": gen._overlaps_for(diagram)}
    return {"diagrams": diagrams_out, "skipped": skipped}


def test_fixture_has_at_least_one_architecture_and_one_dataflow_with_groups():
    kinds = {d["id"]: d["kind"] for d in DIAGRAM["diagrams"]}
    assert "architecture" in kinds.values()
    assert "dataflow" in kinds.values()
    for d in DIAGRAM["diagrams"]:
        if d["kind"] in ("architecture", "dataflow"):
            assert d.get("groups"), f"{d['id']} should declare groups[] for this fixture to be useful"


def test_sequence_and_swimlane_diagrams_are_skipped():
    result = _regenerate()
    assert "seq-dispense" in result["skipped"]
    assert "wf-appointment-visit" in result["skipped"]
    assert "seq-dispense" not in result["diagrams"]
    assert "wf-appointment-visit" not in result["diagrams"]


def test_every_compared_diagram_has_no_overlapping_top_level_group_boxes():
    result = _regenerate()
    assert result["diagrams"], "expected at least one diagram to actually be compared"
    for diagram_id, entry in result["diagrams"].items():
        assert entry["overlaps"] == [], (
            f"{diagram_id}: top-level group boxes overlap after layout -- "
            f"either a genuine layout bug or the fixture tripped the known "
            f"'cron'-shaped issue (plans/diagram-quality-improvements.md, point 2): {entry['overlaps']}"
        )


def test_order_covers_every_node_exactly_once_per_diagram():
    node_ids_by_diagram = {d["id"]: [n["id"] for n in d["nodes"]] for d in DIAGRAM["diagrams"]}
    result = _regenerate()
    for diagram_id, entry in result["diagrams"].items():
        ordered = [nid for ids in entry["order"].values() for nid in ids]
        assert sorted(ordered) == sorted(node_ids_by_diagram[diagram_id])


def test_expected_fixture_on_disk_matches_a_fresh_regeneration():
    expected_path = FIXTURES / "expected_diagram_layout.json"
    on_disk = json.loads(expected_path.read_text(encoding="utf-8"))
    regenerated = _regenerate()
    assert on_disk["diagrams"] == regenerated["diagrams"], (
        "expected_diagram_layout.json is stale -- rerun "
        "`python -m server.tests.fixtures.generate_diagram_layout`"
    )
