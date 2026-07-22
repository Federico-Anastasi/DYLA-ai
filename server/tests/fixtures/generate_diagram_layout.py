"""Regenerates expected_diagram_layout.json, the reference for the parity test between
the two diagram layout engines (server/diagram_export.py and
web/src/components/Viewer/DiagramView.tsx).

    python -m server.tests.fixtures.generate_diagram_layout

Re-run it whenever either layout engine changes, or whenever diagram.json in this
folder changes. The two engines use deliberately different spacing constants (compact
screen vs. printable export -- see the module docstrings), so this does NOT compare
absolute coordinates. It compares two topological invariants that MUST agree regardless
of the constants:

  1. "order": the sequence of node ids within each rank, after the barycenter + group
     ordering pass (_order_within_ranks / orderWithinRanks).
  2. "overlaps": which pairs of TOP-LEVEL group boxes truly overlap (positive extent on
     both axes) once the full layout -- including collision resolution -- has run. For
     a well-formed diagram this must be the empty list on both engines.

Scope note -- what this deliberately does NOT cover yet:
  - 'sequence' diagrams: a fixed lifeline/message layout with no ranks, no groups, no
    auto-layout at all (see _sequence_layout / the `seq` block in DiagramView.tsx).
    There is nothing here to compare.
  - 'workflow' diagrams that declare groups[] with at least one grouped node: BOTH
    engines switch to swimlane mode (_lane_layout / computeSwimlaneLayout), a distinct
    pipeline with its own ordering (lane + rank, not barycenter) and its own box shape
    (full-width lane bands, not per-group padded boxes) -- _order_within_ranks and
    _group_boxes are never called for these. Extending this parity test to swimlanes is
    future work (see plans/diagram-quality-improvements.md, point 1); for now those
    diagrams stay in the fixture (so `_has_lanes` itself has something to exercise) but
    are left out of expected_diagram_layout.json.

The inputs are the synthetic fixture next to this file, NOT a project under projects/:
a public checkout has no projects, and a parity test that silently skips because its
input is missing is a parity test that is not being run. The same file is what
web/src/components/Viewer/DiagramView.parity.test.ts reads.
"""

import json
from pathlib import Path

from server import diagram_export as de

HERE = Path(__file__).parent
DIAGRAM = HERE / "diagram.json"
OUT = HERE / "expected_diagram_layout.json"


def _order_for(diagram: dict) -> dict[str, list[str]]:
    """Rank -> ordered node ids, via the SAME functions production uses
    (_acyclic_adjacency, _longest_path_ranks, _order_within_ranks) -- not a
    re-derivation from box positions, which would risk tautologically agreeing
    with whatever the layout produced instead of checking the ordering itself."""
    nodes = diagram["nodes"]
    node_ids = [n["id"] for n in nodes]
    node_by_id = {n["id"]: n for n in nodes}
    valid_edges = [e for e in diagram.get("edges", []) if e["from"] in node_by_id and e["to"] in node_by_id]
    adj = de._acyclic_adjacency(node_ids, valid_edges)
    ranks = de._longest_path_ranks(node_ids, adj)
    by_rank = de._order_within_ranks(nodes, ranks, adj)
    return {str(r): ids for r, ids in sorted(by_rank.items())}


def _overlaps_for(diagram: dict) -> list[list[str]]:
    """Pairs of top-level group ids whose padded boxes truly overlap (positive
    extent on both axes) after the full rank layout, INCLUDING collision
    resolution -- exactly what a user sees on screen/in the export. Sorted so
    the fixture is stable across runs regardless of dict/set iteration order."""
    node_boxes, group_boxes, ranks, valid_edges, width, height = de._rank_layout(
        diagram, workflow=diagram["kind"] == "workflow"
    )
    top_level = de._top_level_groups(diagram.get("groups") or [])
    ids = [g["id"] for g in top_level if g["id"] in group_boxes]

    bad: list[list[str]] = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            ox, oy = de._box_overlap_extent(group_boxes[ids[i]], group_boxes[ids[j]])
            if ox > 0 and oy > 0:
                bad.append(sorted([ids[i], ids[j]]))
    bad.sort()
    return bad


def main() -> None:
    doc = json.loads(DIAGRAM.read_text(encoding="utf-8"))
    diagrams_out: dict[str, dict] = {}
    skipped: dict[str, str] = {}

    for diagram in doc["diagrams"]:
        did, kind = diagram["id"], diagram["kind"]
        if kind == "sequence":
            skipped[did] = "sequence layout: fixed lifelines/messages, no ranks or groups"
            continue
        if de._has_lanes(diagram):
            skipped[did] = "swimlane workflow: different pipeline, not covered by this test yet"
            continue
        diagrams_out[did] = {
            "order": _order_for(diagram),
            "overlaps": _overlaps_for(diagram),
        }

    OUT.write_text(
        json.dumps({"diagrams": diagrams_out, "skipped": skipped}, indent=1),
        encoding="utf-8",
    )
    # ASCII only: the Windows console runs on cp1252 and cannot print arrows or em dashes.
    total_overlaps = sum(len(d["overlaps"]) for d in diagrams_out.values())
    print(f"{len(diagrams_out)} diagrams compared, {len(skipped)} skipped, "
          f"{total_overlaps} overlapping group-box pairs")


if __name__ == "__main__":
    main()
