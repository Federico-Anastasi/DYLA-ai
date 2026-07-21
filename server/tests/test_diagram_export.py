"""Tests for the technical-diagrams HTML export (server/diagram_export.py).

Fixture pattern taken from test_exports.py / test_mockup_export.py: `load_doc` is
monkeypatched in the module under test, not on the filesystem.

Run with `python -m pytest server/tests`.
"""
import json
import re
from pathlib import Path

import jsonschema
import pytest

from server import diagram_export
from server.diagram_export import diagram_html

SCHEMA = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "schemas" / "diagram.schema.json")
    .read_text(encoding="utf-8")
)


def _validate(doc: dict) -> None:
    jsonschema.validate(instance=doc, schema=SCHEMA)


# --- helper: pull every box (rect or polygon) out of a rendered <svg> and ------
# --- flag any pair that overlaps without one legitimately containing the other

def _boxes_from_svg(svg: str) -> list[tuple[float, float, float, float]]:
    """Every <rect> (group boxes, and node shapes for rect-based classes:
    process/start/end/actor/frontend/backend/service/external/security/manual/
    queue) plus every <polygon> (decision diamonds), each reduced to its
    (x, y, w, h) bounding box. path-based shapes (database/storage/document)
    are not picked up — fixtures in this file stick to rect/polygon classes
    so the overlap check below sees every box that matters."""
    boxes = []
    for tag in re.findall(r"<rect\b[^>]*/>", svg):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', tag))
        if {"x", "y", "width", "height"} <= attrs.keys():
            boxes.append((float(attrs["x"]), float(attrs["y"]),
                          float(attrs["width"]), float(attrs["height"])))
    for tag in re.findall(r"<polygon\b[^>]*/>", svg):
        m = re.search(r'points="([^"]*)"', tag)
        if not m:
            continue
        pts = [p.split(",") for p in m.group(1).split()]
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        boxes.append((min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)))
    return boxes


def _contains(a: tuple, b: tuple, tol: float = 2.0) -> bool:
    """A contains B (within tol): legitimate parent/child nesting."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (ax - tol <= bx and ay - tol <= by
            and ax + aw + tol >= bx + bw and ay + ah + tol >= by + bh)


def _overlaps(a: tuple, b: tuple, margin: float = 4.0) -> bool:
    """True if the two boxes intersect by more than `margin` on both axes."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = min(ax + aw, bx + bw) - max(ax, bx)
    iy = min(ay + ah, by + bh) - max(ay, by)
    return ix > margin and iy > margin


def _non_nested_overlaps(boxes: list[tuple]) -> list[tuple[int, int]]:
    bad = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            if _contains(a, b) or _contains(b, a):
                continue
            if _overlaps(a, b):
                bad.append((i, j))
    return bad


@pytest.fixture
def patch_doc(monkeypatch):
    """Makes load_doc('t', 'diagram') resolve to the given document, without
    touching the filesystem."""

    def _patch(doc: dict):
        monkeypatch.setattr(diagram_export, "load_doc",
                             lambda project, name: doc if project == "t" else None)

    return _patch


# --- fixture: one diagram of each kind ----------------------------------------

def _architecture_diagram() -> dict:
    """Two nested groups, one node with a manual position (outside any group, so
    its coordinates cannot be moved by the normalize step around the groups)."""
    return {
        "id": "arch-overview", "kind": "architecture", "title": "System overview",
        "notes": "High-level view of the booking platform.",
        "groups": [
            {"id": "net", "label": "Company network"},
            {"id": "dmz", "label": "DMZ", "parent": "net"},
        ],
        "nodes": [
            {"id": "web", "label": "Web app", "class": "frontend", "group": "dmz"},
            {"id": "api", "label": "Booking API", "class": "backend", "group": "dmz",
             "desc": "Node.js 20"},
            {"id": "db", "label": "Bookings DB", "class": "database", "group": "net"},
            {"id": "crm", "label": 'Partner CRM <VIP> & "gold"', "class": "external"},
            {"id": "legacy-db", "label": "Legacy archive", "class": "process",
             "pos": {"x": 900, "y": 260}},
        ],
        "edges": [
            {"from": "web", "to": "api", "label": "REST/JSON"},
            {"from": "api", "to": "db", "label": "SQL"},
            {"from": "api", "to": "crm", "label": "sync", "style": "dashed"},
            {"from": "api", "to": "ghost", "label": "dangling"},  # unknown target
        ],
    }


def _workflow_diagram() -> dict:
    """A decision node with a yes/no branch, plus a back edge (retry) that would
    otherwise create a cycle."""
    return {
        "id": "wf-triage", "kind": "workflow", "title": "Reception triage",
        "nodes": [
            {"id": "start", "label": "Patient arrives", "class": "start"},
            {"id": "check", "label": "Urgent?", "class": "decision"},
            {"id": "fast", "label": "Fast track", "class": "process"},
            {"id": "queue", "label": "Wait queue", "class": "process"},
            {"id": "retry", "label": "Re-triage", "class": "manual"},
            {"id": "end", "label": "Seen by nurse", "class": "end"},
        ],
        "edges": [
            {"from": "start", "to": "check"},
            {"from": "check", "to": "fast", "label": "yes"},
            {"from": "check", "to": "queue", "label": "no"},
            {"from": "queue", "to": "retry"},
            {"from": "retry", "to": "check"},  # back edge: would close a cycle
            {"from": "fast", "to": "end"},
            {"from": "queue", "to": "end"},
        ],
    }


def _dataflow_diagram() -> dict:
    return {
        "id": "df-privacy", "kind": "dataflow", "title": "Personal data flow",
        "nodes": [
            {"id": "patient", "label": "Patient", "class": "actor"},
            {"id": "portal", "label": "Booking portal", "class": "frontend"},
            {"id": "vault", "label": "Data vault", "class": "storage"},
        ],
        "edges": [
            {"from": "patient", "to": "portal", "label": "personal data"},
            {"from": "portal", "to": "vault", "label": "encrypted at rest", "style": "dashed"},
        ],
    }


def _sequence_diagram() -> dict:
    return {
        "id": "seq-booking", "kind": "sequence", "title": "Booking confirmation",
        "nodes": [
            {"id": "user", "label": "User", "class": "actor"},
            {"id": "api", "label": "API", "class": "backend"},
            {"id": "email", "label": "Email service", "class": "external"},
        ],
        "edges": [
            {"from": "user", "to": "api", "label": "POST /bookings"},
            {"from": "api", "to": "email", "label": "send confirmation", "style": "dashed"},
            {"from": "email", "to": "user", "label": "email delivered", "style": "dashed"},
        ],
    }


def _full_doc(diagrams: list[dict]) -> dict:
    return {
        "meta": {"project": "t", "title": "Booking Platform — diagrams", "date": "2026-07-20",
                 "status": "draft"},
        "diagrams": diagrams,
    }


ALL_KINDS_DOC = _full_doc(
    [_architecture_diagram(), _workflow_diagram(), _dataflow_diagram(), _sequence_diagram()]
)


def test_fixture_validates_against_the_schema():
    _validate(ALL_KINDS_DOC)


# --- content: labels, edge labels, semantic classes ---------------------------

def test_node_and_edge_labels_are_in_the_output(patch_doc):
    patch_doc(ALL_KINDS_DOC)
    out = diagram_html("t")
    assert "Web app" in out
    assert "Booking API" in out
    assert "REST/JSON" in out
    assert "Fast track" in out
    assert "yes" in out and "no" in out
    assert "Data vault" in out
    assert "POST /bookings" in out


def test_semantic_classes_are_present(patch_doc):
    patch_doc(ALL_KINDS_DOC)
    out = diagram_html("t")
    for cls in ("c-frontend", "c-backend", "c-database", "c-external", "c-storage",
                "c-start", "c-end", "c-decision", "c-process", "c-manual", "c-actor"):
        assert f'"node {cls}"' in out, f"missing class {cls}"


def test_manual_position_is_preserved_in_the_svg(patch_doc):
    """legacy-db carries pos {x: 900, y: 260} and sits outside any group, so
    nothing in the normalize step (which only shifts the drawing when
    something is within a few pixels of the top/left edge) should touch it."""
    patch_doc(ALL_KINDS_DOC)
    out = diagram_html("t")
    assert 'x="900.0"' in out
    assert 'y="260.0"' in out


def test_single_diagram_has_no_nav_bar(patch_doc):
    patch_doc(_full_doc([_dataflow_diagram()]))
    out = diagram_html("t")
    assert "<nav" not in out


def test_multiple_diagrams_have_a_nav_bar_with_titles_and_kinds(patch_doc):
    patch_doc(ALL_KINDS_DOC)
    out = diagram_html("t")
    assert "<nav" in out
    assert "System overview" in out
    assert "architecture" in out
    assert "sequence" in out


# --- escaping ------------------------------------------------------------------

def test_special_characters_in_labels_are_escaped(patch_doc):
    """The label is 26 chars, so it wraps onto two lines (see _wrap_label) and
    the escaped text is split across two <text> elements rather than sitting
    in the document as one contiguous string — check each line instead."""
    patch_doc(ALL_KINDS_DOC)
    out = diagram_html("t")
    assert "Partner CRM" in out
    assert "&lt;VIP&gt; &amp; &quot;gold&quot;" in out
    assert "<VIP> & \"gold\"" not in out


# --- robustness: dangling edge reference must not crash the export ------------

def test_edge_to_an_unknown_node_does_not_crash(patch_doc):
    """The architecture fixture has an edge api -> ghost, and 'ghost' is not a
    node: it must be silently skipped rather than taking the export down."""
    patch_doc(ALL_KINDS_DOC)
    out = diagram_html("t")
    assert "dangling" not in out  # the label of the skipped edge never renders
    assert "ghost" not in out


def test_diagram_html_doc_not_found():
    with pytest.raises(diagram_export.DocNotFound):
        diagram_html("nonexistent_project_xyz_pytest")


# --- back edges (cycle breaking) must not blow up the layout -------------------

def test_a_back_edge_does_not_crash_the_layout(patch_doc):
    """workflow fixture has retry -> check, which closes a cycle with
    check -> queue -> retry; it must be drawn (not dropped from the output)
    even though it is excluded from the rank computation."""
    patch_doc(_full_doc([_workflow_diagram()]))
    out = diagram_html("t")
    assert "Re-triage" in out


# --- groups ---------------------------------------------------------------

def test_group_labels_are_rendered(patch_doc):
    patch_doc(_full_doc([_architecture_diagram()]))
    out = diagram_html("t")
    assert "Company network" in out
    assert "DMZ" in out
    assert "group-box" in out


# --- regression fixtures for 3 measured layout defects (larkfield-vet export) --
# projects/ is gitignored, so these fixtures reproduce the same pathological
# shapes directly rather than depending on that project's diagram.json.

def _long_linear_workflow() -> dict:
    """18 nodes (16 non-decision + 2 decision), almost linear with two
    quick branch/merge detours — the same shape as the real project's
    wf-appointment-visit (17-ish nodes, 2 decisions, 430x4752px before the
    fix). 16 ranks, so it exercises the serpentine fold (> SERPENTINE_RANK_
    THRESHOLD ranks)."""
    nodes = [{"id": "start", "label": "Visit starts", "class": "start"}]
    for i in range(1, 5):
        nodes.append({"id": f"p{i}", "label": f"Step {i}", "class": "process"})
    nodes.append({"id": "dec1", "label": "Needs vet review?", "class": "decision"})
    nodes.append({"id": "b1a", "label": "Vet review", "class": "process"})
    nodes.append({"id": "b1b", "label": "Nurse review", "class": "process"})
    for i in range(6, 10):
        nodes.append({"id": f"p{i}", "label": f"Step {i}", "class": "process"})
    nodes.append({"id": "dec2", "label": "Needs follow-up?", "class": "decision"})
    nodes.append({"id": "b2a", "label": "Book follow-up", "class": "process"})
    nodes.append({"id": "b2b", "label": "Close visit", "class": "process"})
    nodes.append({"id": "p11", "label": "Step 11", "class": "process"})
    nodes.append({"id": "p12", "label": "Step 12", "class": "process"})
    nodes.append({"id": "end", "label": "Visit ends", "class": "end"})
    edges = [
        {"from": "start", "to": "p1"}, {"from": "p1", "to": "p2"},
        {"from": "p2", "to": "p3"}, {"from": "p3", "to": "p4"},
        {"from": "p4", "to": "dec1"},
        {"from": "dec1", "to": "b1a", "label": "yes"},
        {"from": "dec1", "to": "b1b", "label": "no"},
        {"from": "b1a", "to": "p6"}, {"from": "b1b", "to": "p6"},
        {"from": "p6", "to": "p7"}, {"from": "p7", "to": "p8"}, {"from": "p8", "to": "p9"},
        {"from": "p9", "to": "dec2"},
        {"from": "dec2", "to": "b2a", "label": "yes"},
        {"from": "dec2", "to": "b2b", "label": "no"},
        {"from": "b2a", "to": "p11"}, {"from": "b2b", "to": "p11"},
        {"from": "p11", "to": "p12"}, {"from": "p12", "to": "end"},
    ]
    return {"id": "wf-long", "kind": "workflow", "title": "Long linear workflow",
            "nodes": nodes, "edges": edges}


def _four_group_architecture() -> dict:
    """4 flat (non-nested) groups, 9 nodes, with the exact rank/group pattern
    measured on the real arch-overview: three actors + a 'cron' source all at
    rank 0, a hub at rank 1, and the rest (including a group whose only other
    members are two ranks away) at rank 2 — the combination that made the
    'g-cloud' group's box span every rank and swallow 'g-3rd-party'. Classes
    are rect-based (not database/storage, which draw as <path>) so the SVG
    rect/polygon parser in _boxes_from_svg sees every node."""
    return {
        "id": "arch-4groups", "kind": "architecture", "title": "4-group architecture",
        "groups": [
            {"id": "g-main-site", "label": "Main site"},
            {"id": "g-2nd-site", "label": "Second site"},
            {"id": "g-cloud", "label": "Cloud host"},
            {"id": "g-3rd-party", "label": "Third parties"},
        ],
        "nodes": [
            {"id": "reception-tablet", "label": "Reception tablet", "class": "actor", "group": "g-main-site"},
            {"id": "vet-tablet", "label": "Vet tablet", "class": "actor", "group": "g-main-site"},
            {"id": "site2-tablet", "label": "Second site tablet", "class": "actor", "group": "g-2nd-site"},
            {"id": "cron", "label": "Cron scheduler", "class": "service", "group": "g-cloud"},
            {"id": "api", "label": "API", "class": "backend", "group": "g-cloud"},
            {"id": "db-svc", "label": "DB service", "class": "process", "group": "g-cloud"},
            {"id": "storage-svc", "label": "Storage service", "class": "process", "group": "g-cloud"},
            {"id": "xero", "label": "Xero", "class": "external", "group": "g-3rd-party"},
            {"id": "email-sms", "label": "Email/SMS", "class": "external", "group": "g-3rd-party"},
        ],
        "edges": [
            {"from": "reception-tablet", "to": "api"},
            {"from": "vet-tablet", "to": "api"},
            {"from": "site2-tablet", "to": "api"},
            {"from": "cron", "to": "api"},
            {"from": "api", "to": "db-svc"},
            {"from": "api", "to": "storage-svc"},
            {"from": "api", "to": "xero"},
            {"from": "api", "to": "email-sms"},
        ],
    }


def _long_label_diagram() -> dict:
    return {
        "id": "arch-long-label", "kind": "architecture", "title": "Long label",
        "nodes": [
            {"id": "svc", "class": "backend",
             "label": "Central booking and invoicing service for all sites"},
        ],
        "edges": [],
    }


def test_long_linear_workflow_stays_a_sane_aspect_ratio_with_no_overlaps(patch_doc):
    """Workflows lay out left-to-right now (never top-to-bottom): a near-linear
    workflow of 16 ranks used to blow out to 430x4752px under the old TB
    layout. It must now fold into a row-serpentine (2 rows here) that keeps
    the canvas contained in width (well under what one single, unfolded row
    of 16 ranks would need, north of ~4000px) while staying a reasonable
    height (more than one row's worth, comfortably under a couple of
    thousand px), with zero overlapping (non-nested) boxes."""
    patch_doc(_full_doc([_long_linear_workflow()]))
    out = diagram_html("t")
    svg = re.search(r'<svg[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"', out)
    width, height = float(svg.group(1)), float(svg.group(2))
    assert width < 2500, f"workflow canvas too wide: {width}"
    assert 400 <= height < 1200, f"workflow canvas height not a sane row-serpentine: {height}"
    boxes = _boxes_from_svg(out)
    assert len(boxes) >= 18  # every node landed a box
    assert _non_nested_overlaps(boxes) == []


def test_four_group_architecture_has_no_overlapping_groups(patch_doc):
    """Defect #2: the rank layout ignores a group's own footprint, so a group
    whose members straddle several ranks (like g-cloud here) used to swallow
    an unrelated group (g-3rd-party). After _resolve_collisions, no pair of
    non-nested boxes (nodes or groups) may overlap by more than a hairline."""
    patch_doc(_full_doc([_four_group_architecture()]))
    out = diagram_html("t")
    boxes = _boxes_from_svg(out)
    bad = _non_nested_overlaps(boxes)
    assert bad == [], f"{len(bad)} overlapping non-nested box pair(s): {bad}"


def test_long_node_label_wraps_and_carries_a_title(patch_doc):
    """Defect #3: labels never wrapped and could run past their box. A label
    over ~40 chars must wrap onto (at least) two <text> lines and carry a
    <title> with the untouched full text for a hover tooltip."""
    patch_doc(_full_doc([_long_label_diagram()]))
    out = diagram_html("t")
    assert out.count('<text class="node-label"') >= 2
    assert "<title>Central booking and invoicing service for all sites</title>" in out


# --- swimlanes: workflow + groups[] + at least one grouped node ---------------

def _lane_workflow_diagram() -> dict:
    """3 top-level groups (reception/clinical/system), 10 nodes, a decision
    branch that merges back, and a fan-out/fan-in at the system lane — a
    small but representative swimlane workflow."""
    return {
        "id": "wf-lanes", "kind": "workflow", "title": "Visit with departments",
        "groups": [
            {"id": "reception", "label": "Reception"},
            {"id": "clinical", "label": "Clinical"},
            {"id": "system", "label": "System"},
        ],
        "nodes": [
            {"id": "arrive", "label": "Patient arrives", "class": "start", "group": "reception"},
            {"id": "checkin", "label": "Check-in", "class": "process", "group": "reception"},
            {"id": "triage", "label": "Urgent?", "class": "decision", "group": "clinical"},
            {"id": "fasttrack", "label": "Fast track", "class": "process", "group": "clinical"},
            {"id": "queue", "label": "Wait queue", "class": "process", "group": "clinical"},
            {"id": "exam", "label": "Exam", "class": "process", "group": "clinical"},
            {"id": "record", "label": "Update record", "class": "process", "group": "system"},
            {"id": "billing", "label": "Billing", "class": "process", "group": "system"},
            {"id": "notify", "label": "Notify GP", "class": "process", "group": "system"},
            {"id": "discharge", "label": "Discharge", "class": "end", "group": "reception"},
        ],
        "edges": [
            {"from": "arrive", "to": "checkin"},
            {"from": "checkin", "to": "triage"},
            {"from": "triage", "to": "fasttrack", "label": "yes"},
            {"from": "triage", "to": "queue", "label": "no"},
            {"from": "fasttrack", "to": "exam"},
            {"from": "queue", "to": "exam"},
            {"from": "exam", "to": "record"},
            {"from": "record", "to": "billing"},
            {"from": "record", "to": "notify"},
            {"from": "billing", "to": "discharge"},
            {"from": "notify", "to": "discharge"},
        ],
    }


def test_lane_mode_activates_only_for_workflow_with_groups_and_a_grouped_node():
    diagram = _lane_workflow_diagram()
    assert diagram_export._has_lanes(diagram)

    # a workflow that declares groups[] but never references one from a node
    # stays in the plain/serpentine layout, unchanged.
    ungrouped = _workflow_diagram()
    ungrouped["groups"] = [{"id": "g1", "label": "G1"}]
    assert not diagram_export._has_lanes(ungrouped)

    # architecture/dataflow never switch to lane mode even with groups+group
    arch = _architecture_diagram()
    assert diagram_export._has_lanes(arch) is False  # kind != "workflow"


def test_workflow_without_groups_keeps_the_plain_serpentine_layout(patch_doc):
    """(c) Requirement: a workflow with no groups[] must render exactly as
    before — no lane bands anywhere in the output."""
    assert not diagram_export._has_lanes(_workflow_diagram())
    assert not diagram_export._has_lanes(_long_linear_workflow())
    patch_doc(_full_doc([_workflow_diagram(), _long_linear_workflow()]))
    out = diagram_html("t")
    # the shared <style> always defines the .lane-* CSS rules (cheap, unused
    # weight); what must never appear is an actual rendered lane element.
    assert '<rect class="lane-band' not in out
    assert '<text class="lane-label' not in out


def test_three_lanes_in_group_order_and_every_node_inside_its_own_lane(patch_doc):
    """(a) 3 groups (reception/clinical/system) and 10 nodes: 3 lane bands in
    the order groups[] declares them, each node's box sitting within the
    y-range of its own group's lane, and every lane label present."""
    diagram = _lane_workflow_diagram()
    node_boxes, lanes, ranks, valid_edges, width, height = diagram_export._lane_layout(diagram)

    assert [label for label, _y, _h in lanes] == ["Reception", "Clinical", "System"]

    node_by_id = {n["id"]: n for n in diagram["nodes"]}
    lane_range = {label: (y, y + h) for label, y, h in lanes}
    group_label = {"reception": "Reception", "clinical": "Clinical", "system": "System"}
    for nid, (x, y, w, h) in node_boxes.items():
        grp = node_by_id[nid]["group"]
        lo, hi = lane_range[group_label[grp]]
        assert lo - 0.01 <= y and y + h <= hi + 0.01, f"{nid} escaped its {grp} lane"

    patch_doc(_full_doc([diagram]))
    out = diagram_html("t")
    assert out.count('class="lane-band"') + out.count('class="lane-band lane-band-alt"') == 3
    for label in ("Reception", "Clinical", "System"):
        assert label in out
    # order in the document follows groups[] order
    assert out.index("Reception") < out.index("Clinical") < out.index("System")


def test_orphan_node_without_group_gets_a_trailing_other_lane(patch_doc):
    """(b) A node with no (resolvable) group falls into a trailing "Other"
    lane, added only because such a node exists."""
    diagram = _lane_workflow_diagram()
    diagram["nodes"].append({"id": "audit", "label": "External audit log", "class": "external"})
    diagram["edges"].append({"from": "record", "to": "audit"})

    node_boxes, lanes, ranks, valid_edges, width, height = diagram_export._lane_layout(diagram)
    assert [label for label, _y, _h in lanes][-1] == "Other"

    other_label, other_y, other_h = lanes[-1]
    ox, oy, ow, oh = node_boxes["audit"]
    assert other_y - 0.01 <= oy and oy + oh <= other_y + other_h + 0.01

    patch_doc(_full_doc([diagram]))
    out = diagram_html("t")
    assert "Other" in out

    # a diagram with no orphan node at all gets no "Other" lane
    clean_boxes, clean_lanes, *_ = diagram_export._lane_layout(_lane_workflow_diagram())
    assert "Other" not in [label for label, _y, _h in clean_lanes]


def test_manual_pos_escapes_its_lane(patch_doc):
    """(d) A node dragged to a manual pos is placed exactly there, even when
    that position falls outside its own lane's computed y-range — the lane
    never re-cages it."""
    diagram = _lane_workflow_diagram()
    diagram["nodes"][0]["pos"] = {"x": 5.0, "y": 5.0}  # 'arrive' is in "Reception"

    node_boxes, lanes, *_ = diagram_export._lane_layout(diagram)
    x, y, w, h = node_boxes["arrive"]
    assert (x, y) == (5.0, 5.0)
    reception_y, reception_h = lanes[0][1], lanes[0][2]
    assert not (reception_y <= y <= reception_y + reception_h - h), (
        "test fixture did not actually place the node outside its lane — adjust pos"
    )

    patch_doc(_full_doc([diagram]))
    out = diagram_html("t")
    assert 'x="5.0"' in out
    assert 'y="5.0"' in out


def test_sequence_message_label_wider_than_the_lifeline_gap_is_ellipsized(patch_doc):
    """Defect #3 also covers sequence arcs: a message label that would not fit
    between its two lifelines is ellipsized, with the full text moved to a
    <title> tooltip instead of overflowing past the neighbouring lifeline."""
    long_label = "A very long confirmation message that will not fit between these two lifelines"
    doc = _full_doc([{
        "id": "seq-long", "kind": "sequence", "title": "Long sequence label",
        "nodes": [
            {"id": "user", "label": "User", "class": "actor"},
            {"id": "api", "label": "API", "class": "backend"},
        ],
        "edges": [{"from": "user", "to": "api", "label": long_label}],
    }])
    patch_doc(doc)
    out = diagram_html("t")
    assert f"<title>{long_label}</title>" in out  # full text still reachable on hover
    visible_text = re.search(r'<text class="edge-label"[^>]*>([^<]*)</text>', out).group(1)
    assert visible_text != long_label
    assert len(visible_text) < len(long_label)
