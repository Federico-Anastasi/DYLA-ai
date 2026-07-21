"""Exports diagram.json as a single self-contained HTML file: architecture, workflow,
dataflow and sequence diagrams, drawn as inline SVG with an automatic layout computed
in Python (see schemas/diagram.schema.json for the document shape).

Module style mirrors server/mockup_export.py and server/deck_export.py:
- one small function per concern (layout, shape, edge, chrome);
- CSS/JS inlined, zero external resources;
- colours/shapes are driven ONLY by CSS classes (c-actor, c-database, ...) reading
  CSS variables declared once in a :root block, never as inline styles on an
  element — so retheming is a one-block edit, not a search-and-replace.

Layout (kept deliberately simple — see the module's tests for what it guarantees,
not perfect graph drawing):
- 'architecture'/'dataflow'/'workflow': all three are layered LEFT-TO-RIGHT —
  a workflow reads the same direction as everything else, never top-to-bottom.
  The rank of a node is its longest-path distance from a source (a node with
  no incoming edges); cycles are broken by walking the edges in array order
  and skipping any edge that would close a cycle (a "back edge"), so the
  remaining graph is always a DAG before ranking. Nodes in the same rank are
  ordered by the barycenter of their already-placed predecessors (one pass,
  left to right) with a secondary key that keeps nodes of the same group
  adjacent.
- 'sequence': lifelines in nodes[] order, messages in edges[] order top to
  bottom; nodes[].pos is ignored (the ordering *is* the layout).
- a 'workflow' longer than SERPENTINE_RANK_THRESHOLD ranks folds into a
  serpentine of horizontal ROWS — row 0 left to right, row 1 right to left,
  row 2 left to right again, and so on — so a long, mostly-linear workflow
  stays a sane aspect ratio instead of one endless row. The row count is
  itself chosen "à la spartito" (like a musical score): the smallest count
  (never more than MAX_WRAP_FOLDS) whose actual width/height ratio drops
  under WRAP_ASPECT_TARGET (see _serpentine_plan). 'architecture'/'dataflow'
  never fold this way: every rank is always its own column. A 'workflow'
  that declares groups[] with at least one node carrying a group switches to
  swimlane mode instead (see _has_lanes / _lane_layout): one full-width
  horizontal lane per top-level group, stacked in groups[] order, flow left
  to right within each lane. A swimlane workflow whose ranks would otherwise
  run too wide folds the same "à la spartito" way, but vertically: into
  stacked "systems", each one a full, self-contained repeat of the lane
  stack (with labels) picking up the ranks where the previous system left
  off (see _lane_system_plan). Any edge whose two ends land in different
  systems — the ordinary continuation from one system to the next, or a
  back-edge/long skip that happens to cross a system boundary — is drawn as
  a pair of numbered off-page BPMN-style stub connectors instead of one
  curve spanning every system in between (see _render_system_stubs), so nothing
  ever has to bow across the whole stacked figure.
- nodes[].pos, when present, is used as-is (top-left of the box) instead of the
  computed slot; everything else lays out around it. A final normalize step only
  shifts the whole drawing if something ends up within a few pixels of the
  top/left edge — comfortably clear of a normal manually-positioned node, so it
  never silently moves a coordinate the user dragged into place.
- groups[] are drawn as the padded bounding box of their member nodes (and, for
  a group with children, of those children's own boxes too — processed
  child-first so a parent's box always encloses them). Because the rank layout
  places nodes by rank/order alone, a group whose members land in different
  ranks can still end up with a box wide enough to swallow an unrelated node
  or group placed in between; a post-layout pass (_resolve_collisions) treats
  every top-level group (and every ungrouped node) as a real obstacle and
  pushes any pair that still overlaps apart, leaving nested parent/child boxes
  alone. Edge routing is a plain bezier for forward edges and a wider bow
  underneath/beside the nodes for back/same-rank edges, and nodes are drawn
  last so they sit visually on top of any edge segment that happens to pass
  near them.
- node labels over ~18 characters wrap onto two lines (breaking on a space);
  past ~40 characters each line is also ellipsized and the full text moves to
  a <title> tooltip. desc stays a single ellipsized line. A sequence message
  label wider than the gap between its two lifelines is ellipsized the same
  way (see _wrap_label / _ellipsize / _edge_label).
- Every exported <svg> carries its OWN <style> (variables + rules), so the
  "Download SVG"/"Download PNG" buttons produce a file that renders correctly
  even opened on its own, outside this page.
"""
from __future__ import annotations

import html
from collections import deque

from .documents import load_doc
from .exports import DocNotFound

__all__ = ["diagram_html"]


def _require_diagram(project: str) -> dict:
    data = load_doc(project, "diagram")
    if data is None:
        raise DocNotFound(f"diagram.json not found for project '{project}'")
    return data


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


# ── layout constants (generous spacing per the brief: legibility over density) ──

MARGIN = 130          # clears up to 2 levels of nested group padding without ever
                       # triggering the normalize shift (see _rank_layout)
RANK_GAP = 190         # gap between ranks (columns) for architecture/dataflow
RANK_GAP_WORKFLOW = 70  # gap between ranks (columns) for workflows: just box + a
                       # little breathing room, not the generous architecture
                       # spacing — a 17-rank workflow at the wide gap ran to
                       # ~4500px along the flow axis
NODE_GAP = 36          # gap between nodes within the same rank
GROUP_EXTRA_GAP = 26   # extra gap inserted where two adjacent nodes in a rank
                       # belong to different groups, so the group boxes don't touch
GROUP_PAD = 20
GROUP_LABEL_H = 22
SMALL_BUFFER = 10      # normalize only kicks in this close to the top/left edge

# Workflows longer than this many ranks fold into a serpentine: each read in
# the opposite horizontal direction from its neighbour, so a long, mostly-
# linear workflow stays a sane aspect ratio instead of one endless row (see
# _serpentine_plan). architecture/dataflow diagrams never fold this way —
# every rank is always its own column.
SERPENTINE_RANK_THRESHOLD = 9
ROW_GAP = 220          # gap between serpentine rows

# "wrapping à la spartito" (musical score): shared by the non-lane row-
# serpentine (_serpentine_plan) and the swimlane "system" fold (see
# _lane_system_plan) — both pick the smallest fold count whose resulting
# width/height ratio drops under this target, never folding into more than
# MAX_WRAP_FOLDS rows/systems.
WRAP_ASPECT_TARGET = 1.9
MAX_WRAP_FOLDS = 4

# swimlane mode (workflow with groups[] and at least one grouped node — see
# _has_lanes / _lane_layout): one full-width horizontal lane per top-level
# group, flow left to right within a lane. A lane diagram whose ranks would
# otherwise run too wide folds into stacked "systems" — like a musical
# score: each system repeats the full lane stack (with labels) and picks up
# the ranks where the previous system left off (see _lane_system_plan);
# any edge crossing between two systems is drawn as a pair of numbered
# off-page BPMN-style stub connectors instead of one spaghetti curve (see
# _render_system_stubs).
LANE_BAND_W = 140      # left label band width, spans the full height of its lane
LANE_MIN_H = 120       # minimum lane height, even with a single small node in it
LANE_PAD_V = 20        # vertical padding inside a lane around its stacked nodes
LANE_RANK_GAP = 70     # gap between rank columns in swimlane mode
SYSTEM_GAP = 60        # vertical gap between stacked swimlane "systems"
STUB_LEN = 34          # off-page connector: length of the straight stub line
STUB_R = 11            # off-page connector: numbered-circle radius
STUB_RESERVE = STUB_LEN + STUB_R * 2 + 16  # extra width reserved at each
                       # system's left/right border for the stub + circle,
                       # whenever the diagram folds into more than one system

# node label wrapping (see _wrap_label): short labels stay one line, longer
# ones wrap onto two, and past a point each line is hard-truncated with an
# ellipsis (the full text still reaches the reader via a <title> tooltip).
LABEL_WRAP_CHARS = 18
LABEL_TRUNCATE_CHARS = 40
LABEL_LINE_MAX_CHARS = 20
LABEL_LINE_HEIGHT = 15

# post-layout collision resolution (see _resolve_collisions)
COLLISION_GAP = 16
COLLISION_MAX_ITERS = 200


CLASSES = ["actor", "frontend", "backend", "service", "database", "storage", "queue",
           "external", "security", "start", "end", "process", "decision", "document",
           "manual"]

# Node box size per semantic class — shapes that need more room (a diamond, an
# actor icon + label) get a bigger box; everything else shares one default.
_CLASS_SIZES = {
    "decision": (150, 110),
    "start": (120, 50), "end": (120, 50),
    "database": (150, 78), "storage": (150, 78),
    "document": (150, 74),
    "actor": (120, 92),
    "queue": (170, 74),
}
_DEFAULT_SIZE = (170, 64)


def _ellipsize(text: str, max_chars: int) -> str:
    """Hard-truncate to max_chars, replacing the tail with a single ellipsis
    character (never just cuts a word in half without signalling it)."""
    if max_chars <= 1 or len(text) <= max_chars:
        return text
    return text[: max(1, max_chars - 1)].rstrip() + "…"


def _wrap_label(label: str) -> tuple[list[str], bool]:
    """Node labels over LABEL_WRAP_CHARS wrap onto two lines, breaking on the
    space closest to the middle (never mid-word); over LABEL_TRUNCATE_CHARS
    each line is additionally hard-truncated with an ellipsis, and the caller
    is expected to add a <title> with the untouched original text. Returns
    (lines, was_truncated)."""
    if len(label) <= LABEL_WRAP_CHARS:
        return [label], False

    mid = len(label) // 2
    split = None
    for offset in range(mid + 1):
        for cand in (mid - offset, mid + offset):
            if 0 < cand < len(label) and label[cand] == " ":
                split = cand
                break
        if split is not None:
            break
    if split is None:
        split = mid  # no space anywhere: hard split, still two lines

    line1, line2 = label[:split].strip(), label[split:].strip()
    truncated = len(label) > LABEL_TRUNCATE_CHARS
    if truncated:
        line1 = _ellipsize(line1, LABEL_LINE_MAX_CHARS)
        line2 = _ellipsize(line2, LABEL_LINE_MAX_CHARS)
    return [line1, line2], truncated


def _node_size(node: dict) -> tuple[int, int]:
    w, h = _CLASS_SIZES.get(node.get("class"), _DEFAULT_SIZE)
    lines, _ = _wrap_label(str(node.get("label", "")))
    if len(lines) > 1:
        h += LABEL_LINE_HEIGHT + 4
    return w, h


# ═══════════════════════════════════════════════════════════════════════════
# graph: break cycles, rank, order within rank
# ═══════════════════════════════════════════════════════════════════════════

def _acyclic_adjacency(node_ids: list[str], edges: list[dict]) -> dict[str, list[str]]:
    """Adjacency of the graph with cycles removed: edges are accepted in array
    order, and an edge is dropped (a "back edge") the moment accepting it would
    close a cycle — i.e. when the target can already reach the source. A
    self-loop (from == to) is dropped the same way: it has no rank to compute."""
    adj: dict[str, list[str]] = {n: [] for n in node_ids}
    reach: dict[str, set[str]] = {n: set() for n in node_ids}
    for e in edges:
        u, v = e["from"], e["to"]
        if u == v or u not in reach or v not in reach:
            continue
        if u in reach[v]:
            continue  # v already reaches u: accepting u->v would close a cycle
        adj[u].append(v)
        gained = reach[v] | {v}
        for n in node_ids:
            if n == u or u in reach[n]:
                reach[n] |= gained
    return adj


def _longest_path_ranks(node_ids: list[str], adj: dict[str, list[str]]) -> dict[str, int]:
    """rank[v] = longest path from any source to v, computed on the (already
    acyclic) adjacency via Kahn's algorithm so every node is visited exactly
    once regardless of graph shape."""
    indeg = {n: 0 for n in node_ids}
    for u in node_ids:
        for v in adj[u]:
            indeg[v] += 1
    rank = {n: 0 for n in node_ids}
    queue = deque(n for n in node_ids if indeg[n] == 0)
    while queue:
        u = queue.popleft()
        for v in adj[u]:
            if rank[u] + 1 > rank[v]:
                rank[v] = rank[u] + 1
            indeg[v] -= 1
            if indeg[v] == 0:
                queue.append(v)
    return rank


def _order_within_ranks(nodes: list[dict], ranks: dict[str, int],
                         adj: dict[str, list[str]]) -> dict[int, list[str]]:
    """One barycenter pass: each rank (after the first) is sorted by the mean
    position of its predecessors in the already-ordered previous ranks, then by
    a per-group average of that same value so nodes sharing a group land next
    to each other instead of interleaved with the rest of the rank."""
    node_ids = [n["id"] for n in nodes]
    node_by_id = {n["id"]: n for n in nodes}
    max_rank = max(ranks.values(), default=0)
    by_rank: dict[int, list[str]] = {r: [] for r in range(max_rank + 1)}
    for nid in node_ids:
        by_rank[ranks[nid]].append(nid)

    preds: dict[str, list[str]] = {n: [] for n in node_ids}
    for u in node_ids:
        for v in adj[u]:
            preds[v].append(u)

    position = {nid: i for i, nid in enumerate(by_rank[0])}
    for r in range(1, max_rank + 1):
        row = by_rank[r]
        if not row:
            continue

        def barycenter(nid, _row=row):
            ps = [position[p] for p in preds[nid] if p in position]
            return sum(ps) / len(ps) if ps else float(_row.index(nid))

        bary = {nid: barycenter(nid) for nid in row}
        group_vals: dict[str | None, list[float]] = {}
        for nid in row:
            group_vals.setdefault(node_by_id[nid].get("group"), []).append(bary[nid])
        group_avg = {g: sum(v) / len(v) for g, v in group_vals.items()}

        row_sorted = sorted(
            row, key=lambda nid: (group_avg[node_by_id[nid].get("group")], bary[nid], row.index(nid))
        )
        by_rank[r] = row_sorted
        for i, nid in enumerate(row_sorted):
            position[nid] = i
    return by_rank


def _group_depths(groups: list[dict]) -> dict[str, int]:
    """Nesting depth of each group (0 = no parent, or a parent that does not
    resolve). A parent cycle (a group listing an ancestor of its own as its
    parent) is broken by treating it as depth 0 instead of recursing forever —
    malformed input degrades to a flat layout rather than a crash."""
    by_id = {g["id"]: g for g in groups}
    depths: dict[str, int] = {}

    def depth(gid: str, visited: frozenset) -> int:
        if gid in depths:
            return depths[gid]
        if gid in visited:
            return 0
        g = by_id.get(gid)
        parent = g.get("parent") if g else None
        d = 0 if not parent or parent not in by_id else 1 + depth(parent, visited | {gid})
        depths[gid] = d
        return d

    for g in groups:
        depth(g["id"], frozenset())
    return depths


def _group_boxes(groups: list[dict], node_boxes: dict[str, tuple[float, float, float, float]],
                  node_by_id: dict[str, dict]) -> dict[str, tuple[float, float, float, float]]:
    """Padded bounding box of every group's own nodes plus (already computed)
    child groups' boxes — processed deepest-first so a parent always encloses
    its children. An empty group (nothing placed in it) is skipped."""
    if not groups:
        return {}
    by_id = {g["id"]: g for g in groups}
    depths = _group_depths(groups)
    boxes: dict[str, tuple[float, float, float, float]] = {}

    for gid in sorted(by_id, key=lambda g: -depths[g]):
        xs1, ys1, xs2, ys2 = [], [], [], []
        for nid, node in node_by_id.items():
            if node.get("group") == gid and nid in node_boxes:
                x, y, w, h = node_boxes[nid]
                xs1.append(x); ys1.append(y); xs2.append(x + w); ys2.append(y + h)
        for cg in groups:
            if cg.get("parent") == gid and cg["id"] != gid and cg["id"] in boxes:
                x, y, w, h = boxes[cg["id"]]
                xs1.append(x); ys1.append(y); xs2.append(x + w); ys2.append(y + h)
        if not xs1:
            continue
        minx, miny, maxx, maxy = min(xs1), min(ys1), max(xs2), max(ys2)
        x = minx - GROUP_PAD
        y = miny - GROUP_PAD - GROUP_LABEL_H
        boxes[gid] = (x, y, (maxx - minx) + GROUP_PAD * 2, (maxy - miny) + GROUP_PAD * 2 + GROUP_LABEL_H)
    return boxes


def _serpentine_plan(total_ranks: int, col_extent: list[float], rank_cross_extent: list[float],
                      rank_gap: float) -> tuple[int, int]:
    """How a long workflow's ranks fold into rows, "à la spartito" (like a
    musical score): up to SERPENTINE_RANK_THRESHOLD ranks stay a single row
    (unchanged from before); beyond that, the smallest number of rows (never
    more than MAX_WRAP_FOLDS) whose resulting width/height ratio drops under
    WRAP_ASPECT_TARGET — measured on the actual per-rank extents so the
    choice reflects the real drawing, not just a rank count. Row 0 reads left
    to right, row 1 right to left, row 2 left to right again, and so on (see
    _rank_layout for how the alternating direction is applied)."""
    if total_ranks <= SERPENTINE_RANK_THRESHOLD:
        return 1, total_ranks

    def geometry(num_rows: int) -> tuple[float, float, int]:
        ranks_per_row = -(-total_ranks // num_rows)  # ceil division
        row_w = [0.0] * num_rows
        row_h = [0.0] * num_rows
        for r in range(total_ranks):
            rw = min(r // ranks_per_row, num_rows - 1)
            row_w[rw] += col_extent[r] + rank_gap
            row_h[rw] = max(row_h[rw], rank_cross_extent[r])
        width = (max(row_w) - rank_gap if row_w else 0.0) + MARGIN * 2
        height = sum(row_h) + ROW_GAP * (num_rows - 1) + MARGIN * 2
        return width, height, ranks_per_row

    best = (2, -(-total_ranks // 2))
    for num_rows in range(2, MAX_WRAP_FOLDS + 1):
        width, height, ranks_per_row = geometry(num_rows)
        best = (num_rows, ranks_per_row)
        if height > 0 and width / height < WRAP_ASPECT_TARGET:
            break
    return best


def _rank_layout(diagram: dict, workflow: bool):
    """Layered left-to-right layout shared by architecture, dataflow and
    (non-swimlane) workflow diagrams — the flow always reads left to right.
    `workflow` selects the tighter rank spacing used by workflows
    (RANK_GAP_WORKFLOW, vs. the more generous RANK_GAP for architecture/
    dataflow) and makes the diagram eligible for the row-serpentine fold past
    SERPENTINE_RANK_THRESHOLD ranks (see _serpentine_plan); architecture/
    dataflow diagrams never fold — every rank is always its own column.

    Returns (node_boxes, group_boxes, ranks, valid_edges, width, height).
    node_boxes/group_boxes map id -> (x, y, w, h), top-left plus size.
    """
    nodes = diagram["nodes"]
    node_by_id = {n["id"]: n for n in nodes}
    node_ids = [n["id"] for n in nodes]
    # Edges pointing at an id that does not exist are dropped here, once, so
    # every downstream step (ranking, ordering, drawing) can assume both ends
    # of every edge it sees are real nodes.
    valid_edges = [e for e in diagram.get("edges", []) if e["from"] in node_by_id and e["to"] in node_by_id]

    adj = _acyclic_adjacency(node_ids, valid_edges)
    ranks = _longest_path_ranks(node_ids, adj)
    by_rank = _order_within_ranks(nodes, ranks, adj)
    max_rank = max(ranks.values(), default=0)
    total_ranks = max_rank + 1

    sizes = {nid: _node_size(node_by_id[nid]) for nid in node_ids}

    rank_gap = RANK_GAP_WORKFLOW if workflow else RANK_GAP

    col_extent = []  # width (rank-axis extent), per rank
    for r in range(total_ranks):
        row = by_rank.get(r, [])
        col_extent.append(max((sizes[nid][0] for nid in row), default=_DEFAULT_SIZE[0]))

    # Cross-axis (vertical) placement of nodes within their own rank, measured
    # from 0 so it can be offset per-row below (the formula itself —
    # including the extra gap between different groups — is unchanged from
    # before row-folding existed). rank_cross_extent is the rank's total
    # vertical footprint, used to size each row's height.
    node_local_cross: dict[str, float] = {}
    rank_cross_extent = []
    for r in range(total_ranks):
        row = by_rank.get(r, [])
        cross = 0.0
        prev_group = None
        first = True
        for nid in row:
            w, h = sizes[nid]
            group = node_by_id[nid].get("group")
            if not first and group != prev_group:
                cross += GROUP_EXTRA_GAP
            first = False
            prev_group = group
            node_local_cross[nid] = cross
            cross += h + NODE_GAP
        rank_cross_extent.append(cross - NODE_GAP if row else 0.0)

    # architecture/dataflow diagrams never fold into rows — only long
    # workflows do (see _serpentine_plan), and the choice now looks at the
    # actual per-rank extents computed just above.
    num_rows, ranks_per_row = (
        _serpentine_plan(total_ranks, col_extent, rank_cross_extent, rank_gap)
        if workflow else (1, total_ranks)
    )
    row_of = {r: min(r // ranks_per_row, num_rows - 1) for r in range(total_ranks)}

    row_height = [0.0] * num_rows
    for r in range(total_ranks):
        row_height[row_of[r]] = max(row_height[row_of[r]], rank_cross_extent[r])
    row_base = [0.0] * num_rows
    acc = float(MARGIN)
    for row_idx in range(num_rows):
        row_base[row_idx] = acc
        acc += row_height[row_idx] + ROW_GAP

    # Rank-axis (horizontal) stacking, per row. Odd rows are read right-to-left
    # so the drawing reads as a serpentine: the transition edge from the last
    # rank of one row to the first rank of the next always lands at the SAME
    # end (right, then left, then right...) of both rows, where the turn is.
    col_start = [0.0] * total_ranks
    for row_idx in range(num_rows):
        ranks_here = [r for r in range(total_ranks) if row_of[r] == row_idx]
        if row_idx % 2 == 1:
            ranks_here = list(reversed(ranks_here))
        acc = float(MARGIN)
        for r in ranks_here:
            col_start[r] = acc
            acc += col_extent[r] + rank_gap

    node_boxes: dict[str, tuple[float, float, float, float]] = {}
    for r in range(total_ranks):
        for nid in by_rank.get(r, []):
            w, h = sizes[nid]
            local = node_local_cross[nid]
            x, y = col_start[r], row_base[row_of[r]] + local
            node_boxes[nid] = (x, y, w, h)

    # Manual positions win outright: the box keeps its class-driven size but
    # sits exactly where the user dragged it.
    for n in nodes:
        pos = n.get("pos")
        if pos:
            w, h = sizes[n["id"]]
            node_boxes[n["id"]] = (float(pos["x"]), float(pos["y"]), w, h)

    group_boxes = _group_boxes(diagram.get("groups") or [], node_boxes, node_by_id)
    node_boxes, group_boxes = _resolve_collisions(diagram.get("groups") or [], node_by_id, node_boxes)

    all_boxes = list(node_boxes.values()) + list(group_boxes.values())
    if all_boxes:
        min_x = min(b[0] for b in all_boxes)
        min_y = min(b[1] for b in all_boxes)
        shift_x = SMALL_BUFFER - min_x if min_x < SMALL_BUFFER else 0
        shift_y = SMALL_BUFFER - min_y if min_y < SMALL_BUFFER else 0
        if shift_x or shift_y:
            node_boxes = {k: (x + shift_x, y + shift_y, w, h) for k, (x, y, w, h) in node_boxes.items()}
            group_boxes = {k: (x + shift_x, y + shift_y, w, h) for k, (x, y, w, h) in group_boxes.items()}

    all_boxes = list(node_boxes.values()) + list(group_boxes.values())
    width = (max(x + w for x, y, w, h in all_boxes) + MARGIN) if all_boxes else 400
    height = (max(y + h for x, y, w, h in all_boxes) + MARGIN) if all_boxes else 300

    return node_boxes, group_boxes, ranks, valid_edges, width, height


# ── post-layout collision resolution: groups (and, generically, any node) as
# real obstacles, not just the rank grid's blind spots ──────────────────────

def _top_ancestor(gid: str, groups_by_id: dict) -> str:
    """Walks .parent up to the root, breaking a parent cycle by treating it as
    already-root (mirrors _group_depths's own cycle guard)."""
    seen = set()
    cur = gid
    while True:
        g = groups_by_id.get(cur)
        parent = g.get("parent") if g else None
        if not parent or parent not in groups_by_id or parent in seen or parent == cur:
            return cur
        seen.add(cur)
        cur = parent


def _box_contains(a: tuple, b: tuple, tol: float = 2.0) -> bool:
    """A contains B (with a small tolerance): legitimate parent/child nesting,
    never something the collision pass should try to pull apart."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (ax - tol <= bx and ay - tol <= by
            and ax + aw + tol >= bx + bw and ay + ah + tol >= by + bh)


def _box_overlap_extent(a: tuple, b: tuple) -> tuple[float, float]:
    """(overlap_x, overlap_y). Both positive means the two boxes truly
    intersect; a non-positive value on either axis means they don't."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ox = min(ax + aw, bx + bw) - max(ax, bx)
    oy = min(ay + ah, by + bh) - max(ay, by)
    return ox, oy


def _resolve_collisions(groups: list[dict], node_by_id: dict, node_boxes: dict):
    """The rank layout places nodes purely by rank/order; it has no idea how
    big a *group's* padded box ends up once its own members are scattered
    across ranks (a group whose members span ranks 0, 1 and 2 gets a box as
    wide as the whole diagram, which can then swallow an unrelated group or
    node placed in between). This scans every pair of top-level 'clusters' — a
    top-level group together with all its own nodes and any nested child
    groups, or a single ungrouped node — and, for any non-nested pair that
    truly overlaps, pushes the pair apart along whichever axis needs the
    least movement, repeating until nothing overlaps (or the iteration cap is
    hit). A node the user dragged to a manual `pos` is pinned: other clusters
    move out of its way, it never moves itself.
    """
    groups_by_id = {g["id"]: g for g in groups}

    cluster_of: dict[str, tuple] = {}
    for nid, node in node_by_id.items():
        grp = node.get("group")
        if grp and grp in groups_by_id:
            cluster_of[nid] = ("group", _top_ancestor(grp, groups_by_id))
        else:
            cluster_of[nid] = ("node", nid)

    members: dict[tuple, list[str]] = {}
    for nid, key in cluster_of.items():
        members.setdefault(key, []).append(nid)
    pinned = {key: any(node_by_id[nid].get("pos") for nid in nids) for key, nids in members.items()}

    if len(members) < 2:
        return node_boxes, _group_boxes(groups, node_boxes, node_by_id)

    group_boxes: dict[str, tuple] = {}
    keys = list(members.keys())
    for _ in range(COLLISION_MAX_ITERS):
        group_boxes = _group_boxes(groups, node_boxes, node_by_id)

        def cluster_box(key, _gb=group_boxes):
            kind, kid = key
            return _gb.get(kid) if kind == "group" else node_boxes.get(kid)

        moved_any = False
        for i in range(len(keys)):
            a_box = cluster_box(keys[i])
            if a_box is None:
                continue
            for j in range(i + 1, len(keys)):
                b_box = cluster_box(keys[j])
                if b_box is None:
                    continue
                if _box_contains(a_box, b_box) or _box_contains(b_box, a_box):
                    continue
                ox, oy = _box_overlap_extent(a_box, b_box)
                if ox <= 0 or oy <= 0:
                    continue  # not actually overlapping

                a_pinned, b_pinned = pinned[keys[i]], pinned[keys[j]]
                if a_pinned and b_pinned:
                    continue  # both dragged into place: nothing safe to move

                ax, ay, aw, ah = a_box
                bx, by, bw, bh = b_box
                acx, acy = ax + aw / 2, ay + ah / 2
                bcx, bcy = bx + bw / 2, by + bh / 2
                axis_x = ox < oy  # push along whichever axis needs less movement

                if a_pinned:
                    share_a, share_b = 0.0, (ox if axis_x else oy) + COLLISION_GAP
                elif b_pinned:
                    share_a, share_b = (ox if axis_x else oy) + COLLISION_GAP, 0.0
                else:
                    half = ((ox if axis_x else oy) + COLLISION_GAP) / 2
                    share_a, share_b = half, half

                if axis_x:
                    sign = 1.0 if bcx >= acx else -1.0
                    dx_a, dy_a = -share_a * sign, 0.0
                    dx_b, dy_b = share_b * sign, 0.0
                else:
                    sign = 1.0 if bcy >= acy else -1.0
                    dx_a, dy_a = 0.0, -share_a * sign
                    dx_b, dy_b = 0.0, share_b * sign

                for nid in members[keys[i]]:
                    if nid in node_boxes and not node_by_id[nid].get("pos"):
                        x, y, w, h = node_boxes[nid]
                        node_boxes[nid] = (x + dx_a, y + dy_a, w, h)
                for nid in members[keys[j]]:
                    if nid in node_boxes and not node_by_id[nid].get("pos"):
                        x, y, w, h = node_boxes[nid]
                        node_boxes[nid] = (x + dx_b, y + dy_b, w, h)
                moved_any = True

        if not moved_any:
            break

    return node_boxes, _group_boxes(groups, node_boxes, node_by_id)


def _sequence_layout(diagram: dict):
    """Lifelines in nodes[] order (left to right), messages in edges[] order
    (top to bottom). pos is ignored — the array order IS the layout."""
    nodes = diagram["nodes"]
    node_by_id = {n["id"]: n for n in nodes}
    node_ids = [n["id"] for n in nodes]
    valid_edges = [e for e in diagram.get("edges", []) if e["from"] in node_by_id and e["to"] in node_by_id]

    lifeline_gap = 210
    box_w, box_h = 150, 50
    top = 40
    msg_gap = 56
    margin_l = 60

    positions = {nid: margin_l + i * lifeline_gap for i, nid in enumerate(node_ids)}

    messages = []
    y = top + box_h + 60
    for e in valid_edges:
        messages.append({"from": e["from"], "to": e["to"], "label": e.get("label"),
                          "style": e.get("style", "solid"), "y": y})
        y += msg_gap

    width = margin_l * 2 + max(0, len(node_ids) - 1) * lifeline_gap + box_w
    height = y + 40
    return positions, messages, width, height, box_w, box_h, top


# ═══════════════════════════════════════════════════════════════════════════
# swimlane layout: workflow diagrams that declare groups[] with at least one
# grouped node switch from the plain/serpentine rank layout above to one
# full-width horizontal lane per top-level group.
# ═══════════════════════════════════════════════════════════════════════════

def _has_lanes(diagram: dict) -> bool:
    """Swimlane mode activates only for a 'workflow' that declares groups[]
    AND has at least one node carrying a group — every other case (including
    a workflow with groups[] but no grouped node) keeps the plain/serpentine
    rank layout exactly as before."""
    if diagram.get("kind") != "workflow":
        return False
    if not diagram.get("groups"):
        return False
    return any(n.get("group") for n in diagram.get("nodes", []))


def _top_level_groups(groups: list[dict]) -> list[dict]:
    """groups[] filtered to top-level entries (no parent, or a parent that
    does not resolve), in their original array order — this IS the lane
    order (see the module docstring). A nested/child group never gets its
    own lane; its nodes flatten into their top-level ancestor's lane (see
    _top_ancestor, reused from the collision-resolution pass above)."""
    by_id = {g["id"]: g for g in groups}
    return [g for g in groups if not g.get("parent") or g["parent"] not in by_id]


_OTHER_LANE = "__other__"


def _lane_system_plan(total_ranks: int, col_width: list[float], system_h: float) -> tuple[int, int]:
    """How a swimlane workflow's ranks fold into stacked "systems" — "à la
    spartito" (like a musical score): every system repeats the full lane
    stack (with labels — see _lane_layout) and picks up the ranks where the
    previous system left off. Picks the smallest number of systems (never
    more than MAX_WRAP_FOLDS) whose resulting width/height ratio drops under
    WRAP_ASPECT_TARGET; a single system (the common case, short lanes) lays
    out exactly as before. `system_h` is one system's own full vertical
    extent (top margin + the lane stack + bottom margin), constant across
    every system since the lane stack is always the same shape."""
    if total_ranks <= 0:
        return 1, max(total_ranks, 1)

    def system_width(num_systems: int, ranks_per_system: int) -> float:
        widest = 0.0
        for s in range(num_systems):
            r0, r1 = s * ranks_per_system, min(total_ranks, (s + 1) * ranks_per_system)
            if r0 >= r1:
                continue
            cols = col_width[r0:r1]
            widest = max(widest, sum(cols) + LANE_RANK_GAP * max(0, len(cols) - 1))
        extra = STUB_RESERVE if num_systems > 1 else 0.0
        return MARGIN + LANE_BAND_W + widest + MARGIN + extra

    best = (1, total_ranks)
    for num_systems in range(1, MAX_WRAP_FOLDS + 1):
        ranks_per_system = -(-total_ranks // num_systems)
        width = system_width(num_systems, ranks_per_system)
        height = num_systems * system_h + (num_systems - 1) * SYSTEM_GAP
        best = (num_systems, ranks_per_system)
        if height > 0 and width / height < WRAP_ASPECT_TARGET:
            break
    return best


def _lane_layout(diagram: dict):
    """Left-to-right rank layout with one full-width horizontal lane per
    top-level group: rank = longest-path distance from a source (same
    DAG/cycle-breaking as _rank_layout), x = column for that rank within its
    own "system" (see below), y = centre of the node's lane. Nodes sharing a
    rank AND a lane stack vertically inside it; the lane grows to fit them
    (minimum LANE_MIN_H). Nested (child) groups flatten into their top-level
    ancestor's lane; a node with no resolvable group falls into a trailing
    "Other" lane, added only when at least one such node exists. A node with
    a manual pos is placed exactly there, outside any lane's control.

    A lane diagram whose ranks would otherwise run too wide folds into
    stacked "systems", like a musical score (see _lane_system_plan): each
    system is a full, self-contained copy of the lane stack (with labels),
    picking up the ranks where the previous system stopped. Every edge whose
    two ends land in different systems is left out of the normal edge list
    the caller draws — the caller (see _diagram_svg / _render_system_stubs)
    instead draws it as a pair of numbered off-page BPMN-style stubs.

    Returns (node_boxes, lanes, ranks, valid_edges, width, height, system_meta).
    lanes is [(label, y, height), ...] in the drawn (top to bottom) order,
    one full set per system. system_meta is a dict with:
      - "rank_system": {rank: system_index}
      - "left_x" / "right_x": x anchors for entry/exit off-page stubs
    used by the renderer to tell a same-system edge from a cross-system one.
    """
    nodes = diagram["nodes"]
    node_by_id = {n["id"]: n for n in nodes}
    node_ids = [n["id"] for n in nodes]
    valid_edges = [e for e in diagram.get("edges", []) if e["from"] in node_by_id and e["to"] in node_by_id]

    adj = _acyclic_adjacency(node_ids, valid_edges)
    ranks = _longest_path_ranks(node_ids, adj)
    max_rank = max(ranks.values(), default=0)
    total_ranks = max_rank + 1

    groups = diagram.get("groups") or []
    groups_by_id = {g["id"]: g for g in groups}
    lane_groups = _top_level_groups(groups)
    lane_ids = [g["id"] for g in lane_groups]
    lane_label = {g["id"]: g["label"] for g in lane_groups}

    def lane_of_node(n: dict) -> str:
        grp = n.get("group")
        if grp and grp in groups_by_id:
            top = _top_ancestor(grp, groups_by_id)
            if top in lane_label:
                return top
        return _OTHER_LANE

    node_lane = {nid: lane_of_node(node_by_id[nid]) for nid in node_ids}
    has_other = any(lane == _OTHER_LANE for lane in node_lane.values())
    lane_order = list(lane_ids) + ([_OTHER_LANE] if has_other else [])

    sizes = {nid: _node_size(node_by_id[nid]) for nid in node_ids}

    # Rank columns: every lane shares the same column grid, stepped by
    # LANE_RANK_GAP, each column as wide as its widest node across every lane
    # — this is what keeps the flow reading as straight left-to-right columns
    # instead of a per-lane offset.
    by_rank: dict[int, list[str]] = {r: [] for r in range(total_ranks)}
    for nid in node_ids:
        by_rank[ranks[nid]].append(nid)
    col_width = [max((sizes[nid][0] for nid in by_rank.get(r, [])), default=_DEFAULT_SIZE[0])
                 for r in range(total_ranks)]

    # How tall each lane must be: the tallest per-rank node stack it has to
    # hold (a lane can hold several nodes at the same rank; they stack
    # vertically and the lane grows to fit). Computed once, over every rank —
    # every system repeats the exact same lane stack, like a musical score's
    # staff height never changes from one system to the next.
    by_lane_rank: dict[tuple[str, int], list[str]] = {}
    for nid in node_ids:
        by_lane_rank.setdefault((node_lane[nid], ranks[nid]), []).append(nid)

    lane_content_h: dict[str, float] = {}
    for lane in lane_order:
        tallest = 0.0
        for r in range(total_ranks):
            row = by_lane_rank.get((lane, r), [])
            if not row:
                continue
            h = sum(sizes[nid][1] for nid in row) + NODE_GAP * (len(row) - 1)
            tallest = max(tallest, h)
        lane_content_h[lane] = tallest

    lane_height = {lane: max(LANE_MIN_H, lane_content_h[lane] + LANE_PAD_V * 2) for lane in lane_order}
    lane_stack_h = sum(lane_height[lane] for lane in lane_order) if lane_order else 0.0
    system_h = MARGIN + lane_stack_h + MARGIN

    num_systems, ranks_per_system = (
        _lane_system_plan(total_ranks, col_width, system_h) if total_ranks else (1, 1)
    )
    rank_system = {r: min(r // ranks_per_system, num_systems - 1) for r in range(total_ranks)}

    # Rank-axis columns, reset per system: each system is its own fresh copy
    # of the grid, starting at the same x every time (MARGIN + LANE_BAND_W),
    # so a wide workflow reads as S repeated staffs rather than one endless
    # row squeezed to fit.
    system_ranks: dict[int, list[int]] = {}
    for r in range(total_ranks):
        system_ranks.setdefault(rank_system[r], []).append(r)
    col_x = [0.0] * total_ranks
    for s, rs in system_ranks.items():
        acc = float(MARGIN + LANE_BAND_W)
        for r in rs:
            col_x[r] = acc
            acc += col_width[r] + LANE_RANK_GAP

    # y offset of each system's own top: systems stack vertically with
    # SYSTEM_GAP of daylight between them, exactly like the gap between two
    # systems on a printed score.
    system_y0 = [s * (system_h + SYSTEM_GAP) for s in range(num_systems)]

    lane_y0_local: dict[str, float] = {}
    acc = float(MARGIN)
    for lane in lane_order:
        lane_y0_local[lane] = acc
        acc += lane_height[lane]

    node_boxes: dict[str, tuple[float, float, float, float]] = {}
    for lane in lane_order:
        for s in range(num_systems):
            lane_center = system_y0[s] + lane_y0_local[lane] + lane_height[lane] / 2
            for r in system_ranks.get(s, []):
                row = by_lane_rank.get((lane, r), [])
                if not row:
                    continue
                total_h = sum(sizes[nid][1] for nid in row) + NODE_GAP * (len(row) - 1)
                y = lane_center - total_h / 2
                for nid in row:
                    w, h = sizes[nid]
                    node_boxes[nid] = (col_x[r], y, w, h)
                    y += h + NODE_GAP

    # Manual positions win outright, exactly like the rank layout: the lane
    # (and the system it belongs to) never re-cages a node the user dragged
    # out of it — pos wins, full stop, whatever system its rank would have
    # put it in.
    for n in nodes:
        pos = n.get("pos")
        if pos:
            w, h = sizes[n["id"]]
            node_boxes[n["id"]] = (float(pos["x"]), float(pos["y"]), w, h)

    lanes = [
        (lane_label.get(lane, "Other"), system_y0[s] + lane_y0_local[lane], lane_height[lane])
        for s in range(num_systems)
        for lane in lane_order
    ]

    grid_right = (max(col_x[r] + col_width[r] for r in range(total_ranks))
                  if total_ranks else float(MARGIN + LANE_BAND_W))
    left_x = float(LANE_BAND_W)
    right_x = grid_right + STUB_LEN if num_systems > 1 else grid_right

    content_right = right_x + (STUB_R + 16 if num_systems > 1 else 0.0) + MARGIN
    content_bottom = (system_y0[-1] + system_h) if num_systems else 300.0

    if node_boxes:
        width = max(content_right, max(x + w for x, y, w, h in node_boxes.values()) + MARGIN)
        height = max(content_bottom, max(y + h for x, y, w, h in node_boxes.values()) + MARGIN)
    else:
        width = content_right
        height = content_bottom

    system_meta = {"rank_system": rank_system, "num_systems": num_systems,
                   "left_x": left_x, "right_x": right_x}

    return node_boxes, lanes, ranks, valid_edges, width, height, system_meta


# ═══════════════════════════════════════════════════════════════════════════
# shapes and rendering
# ═══════════════════════════════════════════════════════════════════════════

def _shape_svg(cls: str, x: float, y: float, w: float, h: float) -> str:
    if cls == "decision":
        cx, cy = x + w / 2, y + h / 2
        pts = f"{cx},{y} {x + w},{cy} {cx},{y + h} {x},{cy}"
        return f'<polygon class="node-shape" points="{pts}"/>'
    if cls in ("start", "end"):
        r = h / 2
        return f'<rect class="node-shape" x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}"/>'
    if cls in ("database", "storage"):
        rx, ry = w / 2, h * 0.16
        top_y, bottom_y = y + ry, y + h - ry
        d = (f"M {x},{top_y} A {rx},{ry} 0 0 1 {x + w},{top_y} "
             f"L {x + w},{bottom_y} A {rx},{ry} 0 0 1 {x},{bottom_y} Z")
        rim = f'<ellipse class="node-shape-rim" cx="{x + w / 2}" cy="{top_y}" rx="{rx}" ry="{ry}"/>'
        return f'<path class="node-shape" d="{d}"/>{rim}'
    if cls == "document":
        fold = 18
        d = f"M {x},{y} L {x + w - fold},{y} L {x + w},{y + fold} L {x + w},{y + h} L {x},{y + h} Z"
        fold_d = f"M {x + w - fold},{y} L {x + w - fold},{y + fold} L {x + w},{y + fold}"
        return f'<path class="node-shape" d="{d}"/><path class="node-shape-fold" d="{fold_d}"/>'
    if cls == "actor":
        cx = x + w / 2
        head_r = 9
        head_cy = y + 16
        body_top = head_cy + head_r
        body_bottom = body_top + 18
        arm_y = body_top + 6
        return (
            f'<rect class="node-shape" x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>'
            f'<circle class="node-icon" cx="{cx}" cy="{head_cy}" r="{head_r}"/>'
            f'<line class="node-icon" x1="{cx}" y1="{body_top}" x2="{cx}" y2="{body_bottom}"/>'
            f'<line class="node-icon" x1="{cx - 12}" y1="{arm_y}" x2="{cx + 12}" y2="{arm_y}"/>'
            f'<line class="node-icon" x1="{cx}" y1="{body_bottom}" x2="{cx - 10}" y2="{body_bottom + 16}"/>'
            f'<line class="node-icon" x1="{cx}" y1="{body_bottom}" x2="{cx + 10}" y2="{body_bottom + 16}"/>'
        )
    if cls == "queue":
        inset = 12
        return (
            f'<rect class="node-shape" x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>'
            f'<line class="node-icon" x1="{x + inset}" y1="{y + 6}" x2="{x + inset}" y2="{y + h - 6}"/>'
            f'<line class="node-icon" x1="{x + w - inset}" y1="{y + 6}" x2="{x + w - inset}" y2="{y + h - 6}"/>'
        )
    return f'<rect class="node-shape" x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>'


def _render_node(node: dict, x: float, y: float, w: float, h: float) -> str:
    cls = node["class"]
    raw_label = str(node.get("label", ""))
    lines, truncated = _wrap_label(raw_label)
    multiline = len(lines) > 1
    desc = node.get("desc")
    shape = _shape_svg(cls, x, y, w, h)
    cx = x + w / 2
    half_line = LABEL_LINE_HEIGHT / 2 if multiline else 0

    if cls == "actor":
        label_y0, desc_y = y + h - 22 - (LABEL_LINE_HEIGHT if multiline else 0), y + h - 8
    elif desc:
        label_y0, desc_y = y + h / 2 - 4 - half_line, y + h / 2 + 14 + (LABEL_LINE_HEIGHT if multiline else 0)
    else:
        label_y0, desc_y = y + h / 2 + 5 - half_line, None

    parts = [
        f'<text class="node-label" x="{cx}" y="{label_y0 + i * LABEL_LINE_HEIGHT}" text-anchor="middle">{_esc(line)}</text>'
        for i, line in enumerate(lines)
    ]
    if truncated:
        parts.append(f"<title>{_esc(raw_label)}</title>")
    if desc:
        desc_text = _ellipsize(str(desc), max(6, int((w - 16) / 6.2)))
        parts.append(f'<text class="node-desc" x="{cx}" y="{desc_y}" text-anchor="middle">{_esc(desc_text)}</text>')
    return f'<g class="node c-{cls}">{shape}{"".join(parts)}</g>'


def _render_group(group: dict, x: float, y: float, w: float, h: float) -> str:
    label = _esc(group["label"])
    return (f'<g class="group-box"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>'
            f'<text class="group-label" x="{x + 12}" y="{y + 18}">{label}</text></g>')


def _render_lanes(lanes: list[tuple[str, float, float]], width: float, lanes_per_system: int = 0) -> str:
    """One full-width horizontal band per swimlane, alternating a very light
    background via a CSS class (never an inline colour), a border between
    consecutive lanes, a horizontal label in the left LANE_BAND_W band, and a
    vertical rule separating that label band from the diagram area.
    `lanes` may hold several systems' worth of bands back to back (see
    _lane_layout: each system repeats the full lane stack with its own
    labels); `lanes_per_system` — the number of lane bands one system holds
    — is what tells this function where one system's stack ends and the
    next begins, so the alternating shading and the vertical label-band rule
    each restart per system instead of running through the SYSTEM_GAP
    between them."""
    if not lanes:
        return ""
    per_system = lanes_per_system or len(lanes)
    parts = []
    for i, (label, y, h) in enumerate(lanes):
        alt_cls = " lane-band-alt" if (i % per_system) % 2 == 1 else ""
        parts.append(f'<rect class="lane-band{alt_cls}" x="0" y="{y}" width="{width}" height="{h}"/>')
        parts.append(f'<line class="lane-border" x1="0" y1="{y}" x2="{width}" y2="{y}"/>')
        parts.append(f'<text class="lane-label" x="16" y="{y + h / 2 + 4}">{_esc(label)}</text>')
    for s in range(0, len(lanes), per_system):
        system_lanes = lanes[s:s + per_system]
        if not system_lanes:
            continue
        top = system_lanes[0][1]
        bottom = system_lanes[-1][1] + system_lanes[-1][2]
        parts.append(f'<line class="lane-border" x1="{LANE_BAND_W}" y1="{top}" x2="{LANE_BAND_W}" y2="{bottom}"/>')
    return "".join(parts)


def _edge_label(mx: float, my: float, label: str | None, anchor: str = "middle",
                 max_width: float | None = None) -> str:
    """max_width, when given, is the space actually available for the label
    (e.g. the gap between two sequence lifelines): a label that would not fit
    is ellipsized and the untouched text moves to a <title> tooltip instead."""
    if not label:
        return ""
    display = label
    truncated = False
    if max_width is not None:
        max_chars = max(3, int(max_width / 6.2))
        if len(label) > max_chars:
            display = _ellipsize(label, max_chars)
            truncated = True
    elabel = _esc(display)
    approx_w = max(20, len(display) * 6.2)
    lx = mx - approx_w / 2 if anchor == "middle" else mx
    title = f"<title>{_esc(label)}</title>" if truncated else ""
    return (f'<g class="edge-label-g">'
            f'<rect class="edge-label-bg" x="{lx}" y="{my - 9}" width="{approx_w}" height="16" rx="3"/>'
            f'<text class="edge-label" x="{mx}" y="{my + 3}" text-anchor="{anchor}">{elabel}</text>{title}'
            f'</g>')


def _render_edges_rank(valid_edges: list[dict], node_boxes: dict, ranks: dict) -> str:
    """Edge rendering shared by architecture/dataflow, non-swimlane workflow
    and swimlane workflow diagrams — all of them lay out left to right now,
    so there is only one routing scheme: a forward edge (rank increases) is a
    plain bezier from the right edge of its source to the left edge of its
    target; a back/same-rank edge bows below both nodes instead, and passes
    freely between rows/lanes."""
    parts = []
    for i, e in enumerate(valid_edges):
        u, v = e["from"], e["to"]
        if u not in node_boxes or v not in node_boxes:
            continue  # defensive: should not happen, valid_edges is already filtered
        x1, y1, w1, h1 = node_boxes[u]
        x2, y2, w2, h2 = node_boxes[v]
        forward = ranks.get(v, 0) > ranks.get(u, 0)

        if forward:
            sx, sy = x1 + w1, y1 + h1 / 2
            tx, ty = x2, y2 + h2 / 2
            dx = (tx - sx) * 0.5
            path = f"M {sx} {sy} C {sx + dx} {sy}, {tx - dx} {ty}, {tx} {ty}"
            mx, my = (sx + tx) / 2, (sy + ty) / 2
        else:
            sx, sy = x1 + w1 / 2, y1 + h1
            tx, ty = x2 + w2 / 2, y2 + h2
            bow = 50 + 20 * (i % 3)
            midy = max(sy, ty) + bow
            path = f"M {sx} {sy} C {sx} {midy}, {tx} {midy}, {tx} {ty}"
            mx, my = (sx + tx) / 2, midy

        dash_cls = " edge-dashed" if e.get("style") == "dashed" else ""
        parts.append(f'<path class="edge{dash_cls}" d="{path}" marker-end="url(#arrow)"/>')
        parts.append(_edge_label(mx, my, e.get("label")))
    return "".join(parts)


def _split_cross_system_edges(valid_edges: list[dict], ranks: dict, system_meta: dict) -> tuple[list, list]:
    """Splits a swimlane's edges into (same-system, cross-system): an edge
    whose two ends land in different "systems" (see _lane_layout) can't be
    drawn as one curve without cutting across the SYSTEM_GAP and every lane
    label band in between — it is drawn as a pair of off-page stubs instead
    (see _render_system_stubs). With a single system every edge is
    same-system, so this is a no-op and the diagram renders exactly as
    before."""
    rank_system = system_meta["rank_system"]
    if system_meta.get("num_systems", 1) <= 1:
        return valid_edges, []
    same, cross = [], []
    for e in valid_edges:
        u, v = e["from"], e["to"]
        su = rank_system.get(ranks.get(u, 0), 0)
        sv = rank_system.get(ranks.get(v, 0), 0)
        (cross if su != sv else same).append(e)
    return same, cross


def _off_page_stub(x1: float, y1: float, x2: float, y2: float, num: int, title_text: str) -> str:
    """One half of a cross-system edge: a short straight connector from
    (x1, y1) to (x2, y2), the far end landing in a small numbered circle —
    an off-page (BPMN-style) connector. The matching other half, drawn
    elsewhere, carries the same number; the <title> names the node at the
    OTHER end (the one this stub doesn't touch), so a reader hovering either
    half learns where the flow actually goes."""
    return (
        f'<g class="off-page-stub">'
        f'<path class="edge" d="M {x1} {y1} L {x2} {y2}" marker-end="url(#arrow)"/>'
        f'<circle class="stub-circle" cx="{x2}" cy="{y2}" r="{STUB_R}"/>'
        f'<text class="stub-num" x="{x2}" y="{y2 + 4}" text-anchor="middle">{num}</text>'
        f'<title>{_esc(title_text)}</title>'
        f'</g>'
    )


def _render_system_stubs(cross_edges: list[dict], node_boxes: dict, node_by_id: dict,
                          system_meta: dict) -> str:
    """Renders every cross-system edge (see _split_cross_system_edges) as a
    pair of numbered off-page stubs instead of a single curve spanning the
    whole figure: one stub exits the right border of the source's own
    system next to the source node, the other enters the left border of the
    target's system next to the target node, both sharing the same number —
    the exact technique used for the ordinary "continue on the next system"
    case AND for any other cross-system jump (a back-edge, a long skip),
    so nothing ever has to bow across several stacked systems."""
    if not cross_edges:
        return ""
    left_x, right_x = system_meta["left_x"], system_meta["right_x"]
    parts = []
    for i, e in enumerate(cross_edges, start=1):
        u, v = e["from"], e["to"]
        if u not in node_boxes or v not in node_boxes:
            continue
        ux, uy, uw, uh = node_boxes[u]
        vx, vy, vw, vh = node_boxes[v]
        u_label = str(node_by_id.get(u, {}).get("label", u))
        v_label = str(node_by_id.get(v, {}).get("label", v))
        exit_y = uy + uh / 2
        entry_y = vy + vh / 2
        parts.append(_off_page_stub(ux + uw, exit_y, right_x, exit_y, i, f"to: {v_label}"))
        parts.append(_off_page_stub(left_x, entry_y, vx, entry_y, i, f"from: {u_label}"))
    return "".join(parts)


def _render_sequence(diagram: dict) -> tuple[str, int, int]:
    positions, messages, width, height, box_w, box_h, top = _sequence_layout(diagram)
    parts = []

    for n in diagram["nodes"]:
        nid = n["id"]
        if nid not in positions:
            continue
        x = positions[nid]
        cx = x + box_w / 2
        cls = n["class"]
        shape = _shape_svg(cls, x, top, box_w, box_h)
        label = _esc(n["label"])
        parts.append(
            f'<g class="node c-{cls}">{shape}'
            f'<text class="node-label" x="{cx}" y="{top + box_h / 2 + 5}" text-anchor="middle">{label}</text></g>'
        )
        parts.append(f'<line class="lifeline" x1="{cx}" y1="{top + box_h}" x2="{cx}" y2="{height - 20}"/>')

    for e in messages:
        u, v = e["from"], e["to"]
        if u not in positions or v not in positions:
            continue
        y = e["y"]
        cx1, cx2 = positions[u] + box_w / 2, positions[v] + box_w / 2
        dash_cls = " edge-dashed" if e["style"] == "dashed" else ""
        if u == v:
            loop_w = 46
            path = f"M {cx1} {y} C {cx1 + loop_w} {y}, {cx1 + loop_w} {y + 22}, {cx1} {y + 22}"
            parts.append(f'<path class="edge{dash_cls}" d="{path}" marker-end="url(#arrow)"/>')
            parts.append(_edge_label(cx1 + loop_w + 6, y + 14, e.get("label"), anchor="start"))
        else:
            parts.append(f'<path class="edge{dash_cls}" d="M {cx1} {y} L {cx2} {y}" marker-end="url(#arrow)"/>')
            available = max(0.0, abs(cx2 - cx1) - 16)
            parts.append(_edge_label((cx1 + cx2) / 2, y - 8, e.get("label"), max_width=available))

    return "".join(parts), width, height


def _diagram_svg(diagram: dict) -> str:
    kind = diagram["kind"]
    if kind == "sequence":
        body, width, height = _render_sequence(diagram)
    elif _has_lanes(diagram):
        node_boxes, lanes, ranks, valid_edges, width, height, system_meta = _lane_layout(diagram)
        node_by_id = {n["id"]: n for n in diagram["nodes"]}
        num_systems = system_meta.get("num_systems", 1)
        lanes_per_system = len(lanes) // num_systems if num_systems else len(lanes)
        same_edges, cross_edges = _split_cross_system_edges(valid_edges, ranks, system_meta)
        parts = [_render_lanes(lanes, width, lanes_per_system)]
        parts.append(_render_edges_rank(same_edges, node_boxes, ranks))
        parts.append(_render_system_stubs(cross_edges, node_boxes, node_by_id, system_meta))
        # Nodes are drawn last: whatever an edge's curve passes near, the node
        # box on top of it is what stays readable.
        for n in diagram["nodes"]:
            if n["id"] in node_boxes:
                parts.append(_render_node(n, *node_boxes[n["id"]]))
        body = "".join(parts)
    else:
        node_boxes, group_boxes, ranks, valid_edges, width, height = _rank_layout(diagram, kind == "workflow")
        groups = diagram.get("groups") or []
        depths = _group_depths(groups)
        parts = []
        # Shallowest (outermost) group first, so a nested child's box is drawn on
        # top of its parent's rather than being painted over by it.
        for g in sorted(groups, key=lambda g: depths.get(g["id"], 0)):
            if g["id"] in group_boxes:
                parts.append(_render_group(g, *group_boxes[g["id"]]))
        parts.append(_render_edges_rank(valid_edges, node_boxes, ranks))
        # Nodes are drawn last: whatever an edge's curve passes near, the node
        # box on top of it is what stays readable.
        for n in diagram["nodes"]:
            if n["id"] in node_boxes:
                parts.append(_render_node(n, *node_boxes[n["id"]]))
        body = "".join(parts)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" class="diagram-svg" data-diagram-id="{_esc(diagram["id"])}">'
        f'<defs>'
        f'<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" '
        f'orient="auto-start-reverse"><path class="edge-arrow" d="M 0 1 L 10 5 L 0 9 z"/></marker>'
        f'<style>{_shared_diagram_css()}</style>'
        f'</defs>{body}</svg>'
    )


# ═══════════════════════════════════════════════════════════════════════════
# theme: CSS variables per semantic class, light + dark, never inline colours
# ═══════════════════════════════════════════════════════════════════════════

_LIGHT_VARS = {
    "--diagram-bg": "#f8fafc", "--canvas-bg": "#ffffff", "--text": "#0f172a",
    "--muted-text": "#64748b", "--border": "#cbd5e1",
    "--edge-color": "#64748b", "--edge-label-bg": "#ffffff",
    "--group-fill": "rgba(100,116,139,0.07)", "--group-border": "#94a3b8", "--group-label": "#475569",
    "--lane-alt-bg": "rgba(100,116,139,0.045)", "--lane-border": "#e2e8f0", "--lane-label": "#475569",
    "--c-actor-fill": "#ede9fe", "--c-actor-stroke": "#7c3aed", "--c-actor-text": "#3b0764",
    "--c-frontend-fill": "#dbeafe", "--c-frontend-stroke": "#2563eb", "--c-frontend-text": "#1e3a5f",
    "--c-backend-fill": "#dcfce7", "--c-backend-stroke": "#16a34a", "--c-backend-text": "#14532d",
    "--c-service-fill": "#fef9c3", "--c-service-stroke": "#ca8a04", "--c-service-text": "#713f12",
    "--c-database-fill": "#e0e7ff", "--c-database-stroke": "#4338ca", "--c-database-text": "#312e81",
    "--c-storage-fill": "#ccfbf1", "--c-storage-stroke": "#0d9488", "--c-storage-text": "#134e4a",
    "--c-queue-fill": "#ffedd5", "--c-queue-stroke": "#c2410c", "--c-queue-text": "#7c2d12",
    "--c-external-fill": "#f1f5f9", "--c-external-stroke": "#64748b", "--c-external-text": "#334155",
    "--c-security-fill": "#fee2e2", "--c-security-stroke": "#dc2626", "--c-security-text": "#7f1d1d",
    "--c-start-fill": "#dcfce7", "--c-start-stroke": "#16a34a", "--c-start-text": "#14532d",
    "--c-end-fill": "#fee2e2", "--c-end-stroke": "#dc2626", "--c-end-text": "#7f1d1d",
    "--c-process-fill": "#f8fafc", "--c-process-stroke": "#334155", "--c-process-text": "#1e293b",
    "--c-decision-fill": "#fef3c7", "--c-decision-stroke": "#d97706", "--c-decision-text": "#78350f",
    "--c-document-fill": "#f8fafc", "--c-document-stroke": "#475569", "--c-document-text": "#1e293b",
    "--c-manual-fill": "#f5f5f4", "--c-manual-stroke": "#78716c", "--c-manual-text": "#292524",
}

_DARK_VARS = {
    "--diagram-bg": "#0f1115", "--canvas-bg": "#161a20", "--text": "#e6e8eb",
    "--muted-text": "#94a3b8", "--border": "#334155",
    "--edge-color": "#94a3b8", "--edge-label-bg": "#161a20",
    "--group-fill": "rgba(148,163,184,0.08)", "--group-border": "#475569", "--group-label": "#cbd5e1",
    "--lane-alt-bg": "rgba(148,163,184,0.06)", "--lane-border": "#242b36", "--lane-label": "#cbd5e1",
    "--c-actor-fill": "#2e1065", "--c-actor-stroke": "#a78bfa", "--c-actor-text": "#ede9fe",
    "--c-frontend-fill": "#1e3a5f", "--c-frontend-stroke": "#60a5fa", "--c-frontend-text": "#dbeafe",
    "--c-backend-fill": "#14532d", "--c-backend-stroke": "#4ade80", "--c-backend-text": "#dcfce7",
    "--c-service-fill": "#713f12", "--c-service-stroke": "#facc15", "--c-service-text": "#fef9c3",
    "--c-database-fill": "#312e81", "--c-database-stroke": "#818cf8", "--c-database-text": "#e0e7ff",
    "--c-storage-fill": "#134e4a", "--c-storage-stroke": "#2dd4bf", "--c-storage-text": "#ccfbf1",
    "--c-queue-fill": "#7c2d12", "--c-queue-stroke": "#fb923c", "--c-queue-text": "#ffedd5",
    "--c-external-fill": "#1e293b", "--c-external-stroke": "#94a3b8", "--c-external-text": "#e2e8f0",
    "--c-security-fill": "#7f1d1d", "--c-security-stroke": "#f87171", "--c-security-text": "#fee2e2",
    "--c-start-fill": "#14532d", "--c-start-stroke": "#4ade80", "--c-start-text": "#dcfce7",
    "--c-end-fill": "#7f1d1d", "--c-end-stroke": "#f87171", "--c-end-text": "#fee2e2",
    "--c-process-fill": "#1e293b", "--c-process-stroke": "#94a3b8", "--c-process-text": "#e2e8f0",
    "--c-decision-fill": "#78350f", "--c-decision-stroke": "#fbbf24", "--c-decision-text": "#fef3c7",
    "--c-document-fill": "#1e293b", "--c-document-stroke": "#94a3b8", "--c-document-text": "#e2e8f0",
    "--c-manual-fill": "#292524", "--c-manual-stroke": "#a8a29e", "--c-manual-text": "#f5f5f4",
}


def _vars_block(vars_dict: dict, selector: str = ":root") -> str:
    body = "".join(f"{k}:{v};" for k, v in vars_dict.items())
    return f"{selector}{{{body}}}"


def _shape_css_rules() -> str:
    rules = []
    for c in CLASSES:
        rules.append(f'.c-{c} .node-shape{{fill:var(--c-{c}-fill);stroke:var(--c-{c}-stroke);stroke-width:1.6;}}')
        rules.append(f'.c-{c} .node-shape-rim{{fill:none;stroke:var(--c-{c}-stroke);opacity:.7;}}')
        rules.append(f'.c-{c} .node-shape-fold{{fill:var(--canvas-bg);stroke:var(--c-{c}-stroke);stroke-width:1.3;}}')
        rules.append(f'.c-{c} .node-icon{{stroke:var(--c-{c}-stroke);fill:none;stroke-width:1.6;stroke-linecap:round;}}')
        rules.append(f'.c-{c} .node-label{{fill:var(--c-{c}-text);}}')
        rules.append(f'.c-{c} .node-desc{{fill:var(--c-{c}-text);opacity:.75;}}')
    return "".join(rules)


def _generic_svg_rules() -> str:
    return (
        "svg.diagram-svg{background:var(--canvas-bg);}"
        ".group-box rect{fill:var(--group-fill);stroke:var(--group-border);stroke-width:1.4;stroke-dasharray:6 4;}"
        ".group-box text{fill:var(--group-label);font:600 12px system-ui,Arial,sans-serif;}"
        ".lane-band{fill:transparent;}"
        ".lane-band-alt{fill:var(--lane-alt-bg);}"
        ".lane-border{stroke:var(--lane-border);stroke-width:1;}"
        ".lane-label{fill:var(--lane-label);font:600 12px system-ui,Arial,sans-serif;}"
        ".edge{fill:none;stroke:var(--edge-color);stroke-width:1.7;}"
        ".edge-dashed{stroke-dasharray:7 5;}"
        ".edge-arrow{fill:var(--edge-color);}"
        ".edge-label-bg{fill:var(--edge-label-bg);opacity:.94;}"
        ".edge-label{fill:var(--muted-text);font:11px system-ui,Arial,sans-serif;}"
        ".node-label{font:600 12.5px system-ui,Arial,sans-serif;}"
        ".node-desc{font:10px system-ui,Arial,sans-serif;}"
        ".lifeline{stroke:var(--border);stroke-width:1.4;stroke-dasharray:4 4;}"
        ".stub-circle{fill:var(--canvas-bg);stroke:var(--edge-color);stroke-width:1.6;}"
        ".stub-num{font:700 10px system-ui,Arial,sans-serif;fill:var(--edge-color);}"
    )


def _shared_diagram_css() -> str:
    """Variables + rules every <svg> embeds in its own <defs><style>, so a
    downloaded SVG/PNG renders correctly even outside this page (see the
    module docstring)."""
    return (
        _vars_block(_LIGHT_VARS)
        + f"@media (prefers-color-scheme: dark){{{_vars_block(_DARK_VARS)}}}"
        + _generic_svg_rules()
        + _shape_css_rules()
    )


_CHROME_CSS = """
html,body{margin:0;padding:0;background:var(--diagram-bg);color:var(--text);
  font-family:system-ui,"Segoe UI",Arial,sans-serif;}
.page-wrap{max-width:1400px;margin:0 auto;padding:20px;}
.top-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  margin-bottom:16px;flex-wrap:wrap;}
.doc-title{font-size:20px;font-weight:700;margin:0;}
.theme-toggle{border:1px solid var(--border);background:var(--canvas-bg);color:var(--text);
  border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;}
.diagram-nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;}
.diagram-nav button{border:1px solid var(--border);background:var(--canvas-bg);color:var(--text);
  border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;text-align:left;line-height:1.3;}
.diagram-nav button.active{border-color:var(--edge-color);box-shadow:0 0 0 1px var(--edge-color) inset;
  font-weight:600;}
.diagram-nav .kind-tag{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;
  opacity:.6;margin-top:2px;}
.diagram-section{display:none;}
.diagram-section.active{display:block;}
.diagram-head{margin-bottom:10px;}
.diagram-head h2{margin:0 0 4px;font-size:17px;}
.diagram-notes{margin:0 0 10px;color:var(--muted-text);font-size:13px;max-width:70ch;}
.diagram-toolbar{display:flex;gap:8px;margin-bottom:10px;}
.diagram-toolbar button{border:1px solid var(--border);background:var(--canvas-bg);color:var(--text);
  border-radius:6px;padding:5px 11px;font-size:12px;cursor:pointer;}
.diagram-canvas-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px;
  background:var(--canvas-bg);}
"""


def _page_css() -> str:
    return (
        _shared_diagram_css()
        + _vars_block(_DARK_VARS, ":root[data-theme='dark']")
        + _vars_block(_LIGHT_VARS, ":root[data-theme='light']")
        + _CHROME_CSS
    )


def _page_js() -> str:
    return """
(function () {
  var STORAGE_KEY = 'dyla-diagram-theme';
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  if (saved === 'dark' || saved === 'light') { root.setAttribute('data-theme', saved); }

  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.getAttribute('data-theme');
      if (!current) {
        current = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    });
  }

  function serialize(svg) {
    var clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadSvg(svg, name) {
    var text = serialize(svg);
    downloadBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), name + '.svg');
  }

  function downloadPng(svg, name) {
    var scale = 2;
    var w = parseFloat(svg.getAttribute('width')) || svg.viewBox.baseVal.width;
    var h = parseFloat(svg.getAttribute('height')) || svg.viewBox.baseVal.height;
    var text = serialize(svg);
    var url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      var ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (blob) { downloadBlob(blob, name + '.png'); });
    };
    img.src = url;
  }

  document.addEventListener('click', function (e) {
    var navBtn = e.target.closest('[data-goto]');
    if (navBtn) {
      var id = navBtn.getAttribute('data-goto');
      document.querySelectorAll('.diagram-section').forEach(function (s) {
        s.classList.toggle('active', s.getAttribute('data-diagram') === id);
      });
      document.querySelectorAll('.diagram-nav button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-goto') === id);
      });
      return;
    }
    var expBtn = e.target.closest('[data-export]');
    if (expBtn) {
      var kind = expBtn.getAttribute('data-export');
      var target = expBtn.getAttribute('data-target');
      var svg = document.querySelector('svg[data-diagram-id="' + target + '"]');
      if (!svg) { return; }
      if (kind === 'svg') { downloadSvg(svg, target); } else { downloadPng(svg, target); }
    }
  });
})();
"""


# ═══════════════════════════════════════════════════════════════════════════
# full document
# ═══════════════════════════════════════════════════════════════════════════

def diagram_html(project: str) -> str:
    data = _require_diagram(project)
    meta = data["meta"]
    diagrams = data["diagrams"]

    nav_html = ""
    if len(diagrams) > 1:
        buttons = []
        for i, d in enumerate(diagrams):
            cls = "nav-btn active" if i == 0 else "nav-btn"
            buttons.append(
                f'<button type="button" class="{cls}" data-goto="{_esc(d["id"])}">'
                f'{_esc(d["title"])}<span class="kind-tag">{_esc(d["kind"])}</span></button>'
            )
        nav_html = f'<nav class="diagram-nav">{"".join(buttons)}</nav>'

    sections = []
    for i, d in enumerate(diagrams):
        svg = _diagram_svg(d)
        notes_html = f'<p class="diagram-notes">{_esc(d["notes"])}</p>' if d.get("notes") else ""
        active = " active" if i == 0 else ""
        sections.append(
            f'<section class="diagram-section{active}" data-diagram="{_esc(d["id"])}">'
            f'<div class="diagram-head"><h2>{_esc(d["title"])}</h2>{notes_html}</div>'
            f'<div class="diagram-toolbar">'
            f'<button type="button" data-export="svg" data-target="{_esc(d["id"])}">SVG</button>'
            f'<button type="button" data-export="png" data-target="{_esc(d["id"])}">PNG</button>'
            f'</div>'
            f'<div class="diagram-canvas-wrap">{svg}</div>'
            f'</section>'
        )

    title = _esc(meta.get("title", "Diagrams"))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>{_page_css()}</style>
</head>
<body>
<div class="page-wrap">
  <div class="top-bar">
    <h1 class="doc-title">{title}</h1>
    <button type="button" class="theme-toggle" id="theme-toggle">Toggle theme</button>
  </div>
  {nav_html}
  {"".join(sections)}
</div>
<script>{_page_js()}</script>
</body>
</html>"""
