import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { useToastStore } from "../../store/toastStore";
import type {
  Diagram,
  DiagramDoc,
  DiagramEdge,
  DiagramGroup,
  DiagramKind,
  DiagramNode,
  DiagramNodeClass,
} from "../../types";
import { Icon } from "../icons";
import ConfirmButton from "./ConfirmButton";

// Native editor for diagram.json — architecture / workflow / dataflow / sequence diagrams
// (see schemas/diagram.schema.json). Same shared conventions as DataModelView: the JSON is
// the source of truth, saved via PUT like every other live document (useReloadableDoc for
// load/dirty/stale, structuredClone + mutate for edits, a "save" button that shows a 422 as
// plain text). Unlike the data model, this document does not have to exist yet — a project
// may want to draw its first diagram from a blank canvas, so a 404 gets its own empty state
// with a "New diagram" button instead of being treated as a hard error.
//
// One document holds several diagrams (diagrams[]), each on its own canvas, selected from a
// tab bar at the top — the same idea as MockupView's pages. "sequence" diagrams are laid out
// completely differently (fixed lifelines/messages, no dragging) from the other three kinds
// (free canvas with pan/zoom/drag, auto-layout for nodes with no "pos").

// ---------- geometry constants ----------

// All free-canvas kinds (architecture / dataflow / workflow) lay out left-to-right now —
// workflow no longer runs top-to-bottom. What sets workflow apart is a much more compact
// rank gap (box extent + a little breathing room, not generous LR spacing) and, past
// SERPENTINE_RANK_THRESHOLD ranks, folding into a serpentine of horizontal rows instead of
// one very wide diagram: row 0 left-to-right, row 1 right-to-left below it, and so on
// (3 rows past 20 ranks) — mirrors server/diagram_export.py's lane folding, transposed
// (that renderer folds a TB workflow into columns; ours folds an LR workflow into rows).
const RANK_GAP_ARCH = 90; // gap between ranks for architecture/dataflow (was a 230 fixed step
                          // regardless of node width — effectively 60-150px depending on the
                          // class in that rank; now an explicit, consistently tighter air gap)
const RANK_GAP_WORKFLOW = 70; // gap between ranks for workflow: box width + a little air
const NODE_GAP = 30; // gap between nodes sharing a rank (cross-axis packing)
const ROW_GAP = 70; // gap between serpentine rows (workflow only)
const SERPENTINE_RANK_THRESHOLD = 9; // beyond this many ranks a workflow folds into rows
const DEFAULT_SIZE = { w: 172, h: 58 }; // fallback extent for a rank with no nodes in it
const PADDING = 70;
const GROUP_PAD = 30; // base padding a group's box adds around its member nodes
const GROUP_LABEL_H = 24;

// ---------- swimlane constants (workflow with groups[] — see diagramUsesSwimlanes) ----------

const LANE_LABEL_W = 140; // left label band width, full lane height
const MIN_LANE_HEIGHT = 120;
const LANE_NODE_GAP = 20; // gap between nodes stacked in the same rank+lane cell
const LANE_INNER_PAD = 20; // vertical padding inside a lane around its stacked content
const OTHER_LANE_ID = "__other__"; // synthetic lane for nodes with no (resolved) group

// A wide swimlane workflow folds into a "score": S systems (pages) stacked vertically, each
// repeating the full lane stack from its own left margin, rank columns continuing from where
// the previous system stopped — same contract as server/diagram_export.py's PDF/HTML export,
// so the on-screen editor and the exported document agree on where a workflow breaks.
const SYSTEM_GAP = 60; // vertical air between two stacked systems
const MAX_SYSTEMS = 4; // never fold past this many systems, however wide the workflow is
const SWIMLANE_TARGET_ASPECT = 1.9; // pick the smallest S that brings width/height under this
const OFFPAGE_R = 9; // off-page connector circle radius (BPMN-style stub between systems)

const SEQ_HEADER_W = 150;
const SEQ_HEADER_H = 46;
const SEQ_GAP = 210; // spacing between lifelines
const SEQ_MSG_GAP = 56;
const SEQ_TOP = 60;

const NODE_CLASSES: DiagramNodeClass[] = [
  "actor", "frontend", "backend", "service", "database", "storage", "queue",
  "external", "security", "start", "end", "process", "decision", "document", "manual",
];

const CLASS_LABEL: Record<DiagramNodeClass, string> = {
  actor: "Actor", frontend: "Frontend", backend: "Backend", service: "Service",
  database: "Database", storage: "Storage", queue: "Queue", external: "External (third-party)",
  security: "Security", start: "Start", end: "End", process: "Process",
  decision: "Decision", document: "Document", manual: "Manual step",
};

const DIAGRAM_KINDS: DiagramKind[] = ["architecture", "workflow", "dataflow", "sequence"];
const KIND_LABEL: Record<DiagramKind, string> = {
  architecture: "Architecture", workflow: "Workflow", dataflow: "Dataflow", sequence: "Sequence",
};

function classColorVar(cls: DiagramNodeClass): string {
  return `var(--dg-${cls})`;
}

function nodeSize(cls: DiagramNodeClass): { w: number; h: number } {
  switch (cls) {
    case "decision": return { w: 140, h: 96 };
    case "start":
    case "end": return { w: 108, h: 44 };
    case "database": return { w: 128, h: 78 };
    case "actor": return { w: 76, h: 84 };
    case "document": return { w: 150, h: 66 };
    default: return { w: 172, h: 58 };
  }
}

// ---------- small pure helpers (ids, geometry) ----------

function slugify(s: string): string {
  return (
    s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item"
  );
}

function uniqueId(existing: string[], base: string): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`.toLowerCase())) n++;
  return `${base}_${n}`;
}

function toSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function toScreenPoint(svg: SVGSVGElement, x: number, y: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm);
  return { x: p.x, y: p.y };
}

type Rect = { x: number; y: number; w: number; h: number };

function computeBounds(items: Rect[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!items.length) return { minX: 0, minY: 0, maxX: 500, maxY: 320 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
  }
  return { minX, minY, maxX, maxY };
}

// The point on a rectangle's border in the direction of another point — used to anchor
// edges at the shape's edge instead of its centre (a bounding-box approximation, even for
// the shapes that aren't literally rectangles: good enough for a straight connector).
function borderPoint(box: Rect, towards: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = towards.x - cx, dy = towards.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = box.w / 2, hh = box.h / 2;
  const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// ---------- layout (free-canvas kinds: architecture / workflow / dataflow) ----------

type NodeBox = { node: DiagramNode; x: number; y: number; w: number; h: number };
type Override = { id: string; x: number; y: number } | null;

// Longest-path rank from the sources (nodes with no incoming edge get rank 0). Cycles are
// broken FIRST, the same way the Python renderer does it: edges are accepted in array
// order, and an edge whose target already reaches its source is a back edge and gets
// skipped. Without this, the relaxation below inflates ranks around every loop (a
// workflow's "no" branch back to an earlier step) until the iteration cap — measured
// live as a ~1100px hole of empty rank columns in the middle of the canvas.
function computeRanks(diagram: Diagram): Map<string, number> {
  const ids = diagram.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  const reaches = (from: string, target: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(adj.get(cur) ?? []));
    }
    return false;
  };
  const accepted: { from: string; to: string }[] = [];
  for (const e of diagram.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    if (reaches(e.to, e.from)) continue; // back edge: would close a cycle
    accepted.push({ from: e.from, to: e.to });
    adj.get(e.from)!.push(e.to);
  }
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let iter = 0; iter < ids.length + 1; iter++) {
    let changed = false;
    for (const e of accepted) {
      const r = (rank.get(e.from) ?? 0) + 1;
      if (r > (rank.get(e.to) ?? 0)) {
        rank.set(e.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

function byRankMap(diagram: Diagram, rank: Map<string, number>): Map<number, string[]> {
  const byRank = new Map<number, string[]>();
  diagram.nodes.forEach((n) => {
    const r = rank.get(n.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n.id);
  });
  return byRank;
}

// Every node gets its base position from node.pos (manual, wins outright) or the auto-layout
// map for the diagram's kind; the drag-in-progress override wins over both.
function buildBoxes(diagram: Diagram, autoPos: Map<string, { x: number; y: number }>, override: Override): NodeBox[] {
  return diagram.nodes.map((node) => {
    const size = nodeSize(node.class);
    const base = node.pos ?? autoPos.get(node.id) ?? { x: 0, y: 0 };
    const p = override && override.id === node.id ? { x: override.x, y: override.y } : base;
    return { node, x: p.x, y: p.y, w: size.w, h: size.h };
  });
}

// Left-to-right layered layout shared by architecture / dataflow / workflow. Workflow alone
// uses the compact rank gap and, past SERPENTINE_RANK_THRESHOLD ranks, folds into rows read
// as a serpentine (row 0 left-to-right, row 1 right-to-left beneath it, ...) instead of
// running the diagram arbitrarily wide.
function computeLayeredAutoPos(
  diagram: Diagram,
  rank: Map<string, number>,
  byRank: Map<number, string[]>,
): Map<string, { x: number; y: number }> {
  const nodesById = new Map(diagram.nodes.map((n) => [n.id, n]));
  const maxRank = Math.max(0, ...Array.from(rank.values()));
  const totalRanks = maxRank + 1;
  const isWorkflow = diagram.kind === "workflow";
  const rankGap = isWorkflow ? RANK_GAP_WORKFLOW : RANK_GAP_ARCH;
  const fold = isWorkflow && totalRanks > SERPENTINE_RANK_THRESHOLD;
  const numRows = !fold ? 1 : totalRanks > 20 ? 3 : 2;
  const ranksPerRow = !fold ? totalRanks : Math.ceil(totalRanks / numRows);
  const rowOf = (r: number) => Math.min(Math.floor(r / ranksPerRow), numRows - 1);

  // Extent along the rank axis (width) and, within each rank, nodes packed along the cross
  // axis (height) from 0 — the row's own footprint, used below to size that row's band.
  const colExtent: number[] = [];
  const rowExtentForRank: number[] = [];
  const nodeLocalCross = new Map<string, number>();
  for (let r = 0; r < totalRanks; r++) {
    const ids = byRank.get(r) ?? [];
    const widths = ids.map((id) => nodeSize(nodesById.get(id)!.class).w);
    colExtent.push(widths.length ? Math.max(...widths) : DEFAULT_SIZE.w);
    let cross = 0;
    ids.forEach((id, i) => {
      if (i > 0) cross += NODE_GAP;
      nodeLocalCross.set(id, cross);
      cross += nodeSize(nodesById.get(id)!.class).h;
    });
    rowExtentForRank.push(cross);
  }

  const rowHeight = new Array(numRows).fill(0);
  for (let r = 0; r < totalRanks; r++) rowHeight[rowOf(r)] = Math.max(rowHeight[rowOf(r)], rowExtentForRank[r]);
  const rowYBase = new Array(numRows).fill(0);
  { let acc = 0; for (let row = 0; row < numRows; row++) { rowYBase[row] = acc; acc += rowHeight[row] + ROW_GAP; } }

  // Rank-axis (x) placement, per row. Odd rows are read right-to-left so the drawing reads
  // as a serpentine — the transition edge from one row's last rank to the next row's first
  // rank always lands at the same (far) side, which is where the visual "turn" happens.
  const colStart = new Array(totalRanks).fill(0);
  for (let row = 0; row < numRows; row++) {
    let ranksHere: number[] = [];
    for (let r = 0; r < totalRanks; r++) if (rowOf(r) === row) ranksHere.push(r);
    if (row % 2 === 1) ranksHere = ranksHere.reverse();
    let acc = 0;
    for (const r of ranksHere) { colStart[r] = acc; acc += colExtent[r] + rankGap; }
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (let r = 0; r < totalRanks; r++) {
    for (const id of byRank.get(r) ?? []) {
      pos.set(id, { x: colStart[r], y: rowYBase[rowOf(r)] + (nodeLocalCross.get(id) ?? 0) });
    }
  }
  return pos;
}

// ---------- swimlane layout (workflow + groups[], Migliora 2 — see SKILL/task contract) ----------

// A group's top-level ancestor (walking .parent), or null if the id doesn't resolve to a
// group at all. Nested groups collapse to their top-level ancestor for lane purposes only —
// the node's own `group` field (possibly a nested child) is untouched.
function topLevelGroupId(groupId: string | undefined, groupsById: Map<string, DiagramGroup>): string | null {
  if (!groupId) return null;
  let cur = groupsById.get(groupId);
  if (!cur) return null;
  const seen = new Set<string>();
  while (cur.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = groupsById.get(cur.parent);
    if (!parent) break;
    cur = parent;
  }
  return cur.id;
}

// Swimlane mode activates only for a workflow diagram that has groups[] AND at least one
// node actually assigned to one — otherwise it's plain Migliora 1 layered/serpentine layout.
function diagramUsesSwimlanes(diagram: Diagram): boolean {
  return diagram.kind === "workflow" && !!diagram.groups?.length && diagram.nodes.some((n) => !!n.group);
}

function laneIdForNode(node: DiagramNode, groupsById: Map<string, DiagramGroup>): string {
  return topLevelGroupId(node.group, groupsById) ?? OTHER_LANE_ID;
}

type LaneBox = { id: string; label: string; y: number; h: number; index: number };
// One repeated "page" of the score: a contiguous run of ranks, stacked below the previous
// system. width is that system's own content width (LANE_LABEL_W + its ranks) — systems can
// differ slightly in width, same as a score's last line not needing to reach the margin.
type SystemBox = { index: number; yOffset: number; width: number; rankStart: number; rankEnd: number };
type SwimlaneLayout = {
  autoPos: Map<string, { x: number; y: number }>;
  lanes: LaneBox[];
  systems: SystemBox[];
  laneStackHeight: number; // height of ONE repeated lane stack (systems are this tall, + SYSTEM_GAP apart)
  rankSystem: number[]; // rankSystem[r] = which system rank r was folded into
};

// Splits `totalRanks` contiguous ranks into (up to) `s` chunks, each restarting its rank axis
// from 0 — the swimlane analogue of computeLayeredAutoPos's row-folding, except each chunk
// becomes a full repeated system rather than a bare row. Pure and cheap (a handful of ranks),
// so computeSwimlaneLayout below calls it once per candidate S to size the pick.
function splitIntoSystems(totalRanks: number, colExtent: number[], s: number) {
  const ranksPerSystem = Math.max(1, Math.ceil(totalRanks / s));
  const colStart = new Array(totalRanks).fill(0);
  const rankSystem = new Array(totalRanks).fill(0);
  const widths: number[] = [];
  let numSystems = 0;
  for (let sys = 0; sys * ranksPerSystem < totalRanks; sys++) {
    const rankStart = sys * ranksPerSystem;
    const rankEnd = Math.min(rankStart + ranksPerSystem, totalRanks);
    let acc = 0;
    for (let r = rankStart; r < rankEnd; r++) {
      rankSystem[r] = sys;
      colStart[r] = acc;
      acc += colExtent[r] + RANK_GAP_WORKFLOW;
    }
    widths.push(LANE_LABEL_W + Math.max(0, acc - RANK_GAP_WORKFLOW));
    numSystems++;
  }
  return { ranksPerSystem, numSystems, colStart, rankSystem, widths };
}

// Every top-level group is a full-width horizontal lane, stacked in groups[] order; nodes
// with no (resolved) group land in a synthetic "Other" lane at the bottom, added only if
// needed. Flow is left-to-right by rank, same rank axis as the plain layered layout — but
// past SWIMLANE_TARGET_ASPECT a serpentine row-fold would just make lanes wider without
// helping, so a swimlane workflow instead folds like sheet music: the smallest S (1..
// MAX_SYSTEMS) whose systems bring width/height under the target, each system repeating the
// whole lane stack (see the .dg-lane-system render) rather than one arbitrarily wide ribbon.
// A node's y is its lane's vertical centre within its system, and a lane grows (floor
// MIN_LANE_HEIGHT) to fit the tallest rank/lane cell once nodes sharing a rank+lane stack
// vertically. Edges whose endpoints land in different systems render as off-page connectors
// (see the edges block) instead of a line wrapping across the whole figure.
function computeSwimlaneLayout(
  diagram: Diagram,
  rank: Map<string, number>,
  byRank: Map<number, string[]>,
): SwimlaneLayout {
  const nodesById = new Map(diagram.nodes.map((n) => [n.id, n]));
  const groups = diagram.groups ?? [];
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const topLevel = groups.filter((g) => !g.parent);
  const usesOther = diagram.nodes.some((n) => laneIdForNode(n, groupsById) === OTHER_LANE_ID);
  const laneOrder = [...topLevel.map((g) => g.id), ...(usesOther ? [OTHER_LANE_ID] : [])];
  const laneIndex = new Map(laneOrder.map((id, i) => [id, i]));

  const maxRank = Math.max(0, ...Array.from(rank.values()));
  const totalRanks = maxRank + 1;

  // Rank-axis extent, independent of how ranks later get folded into systems.
  const colExtent: number[] = [];
  for (let r = 0; r < totalRanks; r++) {
    const ids = byRank.get(r) ?? [];
    const widths = ids.map((id) => nodeSize(nodesById.get(id)!.class).w);
    colExtent.push(widths.length ? Math.max(...widths) : DEFAULT_SIZE.w);
  }

  // Group nodes into (lane, rank) cells, in diagram.nodes order, to size each lane and to
  // centre each cell's stack within it.
  const cell = new Map<string, string[]>();
  diagram.nodes.forEach((n) => {
    const li = laneIndex.get(laneIdForNode(n, groupsById))!;
    const r = rank.get(n.id) ?? 0;
    const key = `${li}:${r}`;
    if (!cell.has(key)) cell.set(key, []);
    cell.get(key)!.push(n.id);
  });
  const stackHeight = (ids: string[]) =>
    ids.reduce((h, id, i) => h + (i > 0 ? LANE_NODE_GAP : 0) + nodeSize(nodesById.get(id)!.class).h, 0);

  const laneStackExtent = new Array(laneOrder.length).fill(0);
  for (const [key, ids] of cell) {
    const li = Number(key.split(":")[0]);
    laneStackExtent[li] = Math.max(laneStackExtent[li], stackHeight(ids));
  }
  const laneHeight = laneStackExtent.map((h) => Math.max(MIN_LANE_HEIGHT, h + LANE_INNER_PAD * 2));
  const laneYBase: number[] = [];
  { let acc = 0; for (let i = 0; i < laneOrder.length; i++) { laneYBase.push(acc); acc += laneHeight[i]; } }
  const laneStackHeight = laneYBase[laneOrder.length - 1] + laneHeight[laneOrder.length - 1];

  // Pick S: the smallest system count (capped at MAX_SYSTEMS) whose width/height ratio is
  // under the target, exactly the "S>=1, max 4" rule in the task contract.
  let plan = splitIntoSystems(totalRanks, colExtent, 1);
  for (let s = 1; s <= MAX_SYSTEMS; s++) {
    const candidate = splitIntoSystems(totalRanks, colExtent, s);
    const height = candidate.numSystems * laneStackHeight + (candidate.numSystems - 1) * SYSTEM_GAP;
    const width = Math.max(...candidate.widths);
    plan = candidate;
    if (width / height <= SWIMLANE_TARGET_ASPECT || s === MAX_SYSTEMS) break;
  }

  const systems: SystemBox[] = [];
  for (let sys = 0; sys < plan.numSystems; sys++) {
    const rankStart = sys * plan.ranksPerSystem;
    const rankEnd = Math.min(rankStart + plan.ranksPerSystem, totalRanks) - 1;
    systems.push({
      index: sys,
      yOffset: sys * (laneStackHeight + SYSTEM_GAP),
      width: plan.widths[sys],
      rankStart,
      rankEnd,
    });
  }

  const autoPos = new Map<string, { x: number; y: number }>();
  for (const [key, ids] of cell) {
    const [liStr, rStr] = key.split(":");
    const li = Number(liStr), r = Number(rStr);
    const sys = plan.rankSystem[r] ?? 0;
    const total = stackHeight(ids);
    let y = systems[sys].yOffset + laneYBase[li] + (laneHeight[li] - total) / 2;
    for (const id of ids) {
      const h = nodeSize(nodesById.get(id)!.class).h;
      autoPos.set(id, { x: plan.colStart[r] + LANE_LABEL_W, y });
      y += h + LANE_NODE_GAP;
    }
  }

  const lanes: LaneBox[] = laneOrder.map((id, i) => ({
    id,
    label: id === OTHER_LANE_ID ? "Other" : (groupsById.get(id)?.label ?? id),
    y: laneYBase[i],
    h: laneHeight[i],
    index: i,
  }));
  return { autoPos, lanes, systems, laneStackHeight, rankSystem: plan.rankSystem };
}

type GroupBox = { group: DiagramGroup; x: number; y: number; w: number; h: number; depth: number };

function groupDepth(g: DiagramGroup, byId: Map<string, DiagramGroup>): number {
  let d = 0;
  let cur: DiagramGroup | undefined = g;
  const seen = new Set<string>();
  while (cur?.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = byId.get(cur.parent);
    if (!p) break;
    d++;
    cur = p;
  }
  return d;
}

function nestingBelow(g: DiagramGroup, groups: DiagramGroup[]): number {
  const children = groups.filter((c) => c.parent === g.id);
  if (!children.length) return 0;
  return 1 + Math.max(...children.map((c) => nestingBelow(c, groups)));
}

// Groups have no geometry of their own: a group's box is the padded bounding box of every
// node that sits in it, directly or through a nested child group. An empty group (no member
// anywhere in the tree) draws nothing on the canvas — it still exists, and shows up once a
// node is assigned to it. Returned in root-first order so nested boxes paint on top of their
// parent's.
function layoutGroups(diagram: Diagram, boxes: NodeBox[]): GroupBox[] {
  const groups = diagram.groups ?? [];
  if (!groups.length) return [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const isDescendantOf = (groupId: string, ancestorId: string, seen = new Set<string>()): boolean => {
    if (seen.has(groupId)) return false;
    seen.add(groupId);
    const g = byId.get(groupId);
    if (!g?.parent) return false;
    if (g.parent === ancestorId) return true;
    return isDescendantOf(g.parent, ancestorId, seen);
  };
  const result: GroupBox[] = [];
  for (const g of groups) {
    const members = boxes.filter((b) => b.node.group === g.id || (b.node.group && isDescendantOf(b.node.group, g.id)));
    if (!members.length) continue;
    const bounds = computeBounds(members);
    const pad = GROUP_PAD + nestingBelow(g, groups) * 26;
    result.push({
      group: g,
      x: bounds.minX - pad,
      y: bounds.minY - pad - GROUP_LABEL_H,
      w: bounds.maxX - bounds.minX + pad * 2,
      h: bounds.maxY - bounds.minY + pad * 2 + GROUP_LABEL_H,
      depth: groupDepth(g, byId),
    });
  }
  return result.sort((a, b) => a.depth - b.depth);
}

function hitNode(boxes: NodeBox[], x: number, y: number, excludeId: string): NodeBox | null {
  for (const b of boxes) {
    if (b.node.id === excludeId) continue;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  }
  return null;
}

// Groups a candidate parent must not become: itself, or any group already nested inside it
// (picking one would create a cycle).
function eligibleParents(groups: DiagramGroup[], groupId: string): DiagramGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const isDescendantOf = (id: string, ancestorId: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const g = byId.get(id);
    if (!g?.parent) return false;
    if (g.parent === ancestorId) return true;
    return isDescendantOf(g.parent, ancestorId, seen);
  };
  return groups.filter((g) => g.id !== groupId && !isDescendantOf(g.id, groupId));
}

// ---------- shape per node class ----------

function NodeShape({ box, colorVar, selected }: { box: NodeBox; colorVar: string; selected: boolean }) {
  const { x, y, w, h, node } = box;
  const stroke = selected ? "var(--accent)" : colorVar;
  const strokeWidth = selected ? 2.4 : 1.6;
  const common = { fill: "var(--panel-2)", stroke, strokeWidth };

  switch (node.class) {
    case "decision": {
      const cx = x + w / 2, cy = y + h / 2;
      return <polygon className="dg-node-shape" points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`} {...common} />;
    }
    case "start":
    case "end":
      return <rect className="dg-node-shape" x={x} y={y} width={w} height={h} rx={h / 2} ry={h / 2} {...common} />;
    case "database": {
      const rx = w / 2, ry = 12;
      const body = `M ${x} ${y + ry} L ${x} ${y + h - ry} A ${rx} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry}`;
      return (
        <g>
          <path className="dg-node-shape" d={body} {...common} />
          <ellipse cx={x + rx} cy={y + h - ry} rx={rx} ry={ry} fill="var(--panel-2)" stroke={stroke} strokeWidth={strokeWidth} />
          <ellipse cx={x + rx} cy={y + ry} rx={rx} ry={ry} fill="var(--panel-2)" stroke={stroke} strokeWidth={strokeWidth} />
        </g>
      );
    }
    case "document": {
      const wave = 12;
      const d = `M ${x} ${y} H ${x + w} V ${y + h - wave} `
        + `Q ${x + w * 0.75} ${y + h}, ${x + w / 2} ${y + h - wave} `
        + `Q ${x + w * 0.25} ${y + h - wave * 2}, ${x} ${y + h - wave} Z`;
      return <path className="dg-node-shape" d={d} {...common} />;
    }
    case "actor": {
      const cx = x + w / 2;
      const headR = 11;
      const headCy = y + headR + 2;
      const bodyBottom = y + h * 0.6;
      return (
        <g>
          <circle cx={cx} cy={headCy} r={headR} fill="var(--panel-2)" stroke={stroke} strokeWidth={strokeWidth} />
          <path
            className="dg-node-shape-lines"
            d={`M ${cx} ${headCy + headR} V ${bodyBottom} M ${x + w * 0.12} ${y + h * 0.38} H ${x + w * 0.88} `
              + `M ${cx} ${bodyBottom} L ${x + w * 0.18} ${y + h} M ${cx} ${bodyBottom} L ${x + w * 0.82} ${y + h}`}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </g>
      );
    }
    default:
      return <rect className="dg-node-shape" x={x} y={y} width={w} height={h} rx={9} {...common} />;
  }
}

function labelPos(box: NodeBox): { labelY: number; descY: number | null } {
  const { y, h, node } = box;
  if (node.class === "actor") return { labelY: y + h - 6, descY: null };
  const midY = y + h / 2;
  if (node.desc) return { labelY: midY - 3, descY: midY + 13 };
  return { labelY: midY + 4, descY: null };
}

// ---------- small floating menu (class / kind pickers) ----------

function PickerMenu({ items, onPick }: { items: { key: string; label: string }[]; onPick: (key: string) => void }) {
  return (
    <div className="dg-picker">
      {items.map((it) => (
        <div key={it.key} className="dg-picker-item" onClick={() => onPick(it.key)}>
          {it.label}
        </div>
      ))}
    </div>
  );
}

// ---------- selection / editing / menu state shapes ----------

type Selection = { type: "node"; id: string } | { type: "group"; id: string } | { type: "edge"; index: number } | null;
type EditingNode = { id: string; label: string; desc: string; group?: string } | null;
type EditingGroup = { id: string; label: string } | null;
type OpenMenu =
  | { kind: "add-node" }
  | { kind: "add-diagram" }
  | { kind: "group-assign"; nodeId: string }
  | { kind: "group-settings"; groupId: string }
  | null;
type ConnDrag = { fromId: string; x: number; y: number } | null;

// Server error format for a missing document, mirrored from server/main.py::get_doc
// ("{doc}.json not found for project '{name}'"), shared by every document kind. Detecting it
// this way (rather than threading ApiError.status through useReloadableDoc, which every other
// view relies on as-is) is what lets diagram.json alone offer a "create from scratch" empty
// state without touching the shared hook.
function looksMissing(message: string | null): boolean {
  return !!message && /not found/i.test(message);
}

export default function DiagramView({
  project,
  tick,
  onSaved,
  onDirtyChange,
}: {
  project: string;
  tick: number;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { doc, setDoc, loadError, dirty, setDirty, stale, reloadDiscardingChanges } =
    useReloadableDoc<DiagramDoc>(project, "diagram", tick);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [editingNode, setEditingNode] = useState<EditingNode>(null);
  const [editingGroup, setEditingGroup] = useState<EditingGroup>(null);
  const [diagramRename, setDiagramRename] = useState<{ id: string; title: string } | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [connDrag, setConnDrag] = useState<ConnDrag>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; vb: { x: number; y: number; w: number; h: number } } | null>(null);
  const [panning, setPanning] = useState(false);
  const didInitialFit = useRef(false);

  const [dragOverride, setDragOverride] = useState<Override>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // Project changed: forget the fit and the current selection/diagram, exactly like
  // DataModelView resets didInitialFit on [project].
  useEffect(() => {
    didInitialFit.current = false;
    setActiveId(null);
    setSel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Keep a valid activeId once the document loads or a diagram is added/removed.
  useEffect(() => {
    if (!doc) return;
    setActiveId((cur) => (cur && doc.diagrams.some((d) => d.id === cur) ? cur : doc.diagrams[0]?.id ?? null));
  }, [doc]);

  // Switching diagrams: forget the fit, selection and any in-progress edit.
  useEffect(() => {
    didInitialFit.current = false;
    setSel(null);
    setEditingNode(null);
    setEditingGroup(null);
    setOpenMenu(null);
    setConnDrag(null);
  }, [activeId]);

  useEffect(() => {
    if (!openMenu) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (menuRef.current && menuRef.current.contains(t)) return;
      if (t.closest && t.closest(".dg-menu-trigger")) return;
      setOpenMenu(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openMenu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenMenu(null);
      setConnDrag(null);
      setEditingNode(null);
      setEditingGroup(null);
      setDiagramRename(null);
      setSel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const activeDiagram = useMemo(
    () => doc?.diagrams.find((d) => d.id === activeId) ?? null,
    [doc, activeId],
  );

  const isSwimlane = useMemo(() => (activeDiagram ? diagramUsesSwimlanes(activeDiagram) : false), [activeDiagram]);
  const rankInfo = useMemo(
    () => (activeDiagram && activeDiagram.kind !== "sequence" ? computeRanks(activeDiagram) : new Map<string, number>()),
    [activeDiagram],
  );
  const byRank = useMemo(
    () => (activeDiagram && activeDiagram.kind !== "sequence" ? byRankMap(activeDiagram, rankInfo) : new Map<number, string[]>()),
    [activeDiagram, rankInfo],
  );
  const swimlane = useMemo(
    () => (activeDiagram && isSwimlane ? computeSwimlaneLayout(activeDiagram, rankInfo, byRank) : null),
    [activeDiagram, isSwimlane, rankInfo, byRank],
  );
  const boxes = useMemo(() => {
    if (!activeDiagram || activeDiagram.kind === "sequence") return [];
    const autoPos = swimlane ? swimlane.autoPos : computeLayeredAutoPos(activeDiagram, rankInfo, byRank);
    return buildBoxes(activeDiagram, autoPos, dragOverride);
  }, [activeDiagram, swimlane, rankInfo, byRank, dragOverride]);
  const groupBoxes = useMemo(
    () => (activeDiagram && !isSwimlane && activeDiagram.kind !== "sequence" ? layoutGroups(activeDiagram, boxes) : []),
    [activeDiagram, isSwimlane, boxes],
  );
  const laneBoxes = swimlane?.lanes ?? [];
  const systemBoxes = swimlane?.systems ?? [];
  // One rect per (system, lane): each system repeats the whole lane stack at its own yOffset
  // and its own content width — see computeSwimlaneLayout's "score" fold.
  const laneRects: Rect[] = isSwimlane
    ? systemBoxes.flatMap((sys) => laneBoxes.map((l) => ({ x: 0, y: l.y + sys.yOffset, w: sys.width, h: l.h })))
    : [];
  // Recomputed every render rather than memoized: cheap (a handful of rects), and it must
  // reflect laneRects/groupBoxes derived values without a fragile hand-maintained dep list.
  const bounds = computeBounds([...boxes, ...groupBoxes, ...laneRects]);
  const dragTarget = connDrag ? hitNode(boxes, connDrag.x, connDrag.y, connDrag.fromId) : null;

  // Off-page connector numbering (swimlane only): a sequential number per edge whose endpoints
  // fall in different systems — back-edges and forward skips alike, per the task contract.
  // Kept as a plain useMemo (not derived inline in the render loop) so both the exit stub and
  // the matching entry stub agree on the same number without threading extra state.
  const crossingSystem = useMemo(() => {
    const map = new Map<number, number>();
    if (!activeDiagram || !swimlane) return map;
    let n = 0;
    activeDiagram.edges.forEach((edge, i) => {
      const fromRank = rankInfo.get(edge.from) ?? 0;
      const toRank = rankInfo.get(edge.to) ?? 0;
      const fromSys = swimlane.rankSystem[fromRank] ?? 0;
      const toSys = swimlane.rankSystem[toRank] ?? 0;
      if (fromSys !== toSys) map.set(i, ++n);
    });
    return map;
  }, [activeDiagram, swimlane, rankInfo]);

  // Sequence layout: fixed lifelines (node order) and messages (edge order) — no auto-layout,
  // no dragging.
  const seq = useMemo(() => {
    if (!activeDiagram || activeDiagram.kind !== "sequence") return null;
    const lifelines = activeDiagram.nodes.map((node, i) => ({
      node,
      cx: PADDING + i * SEQ_GAP + SEQ_HEADER_W / 2,
      x: PADDING + i * SEQ_GAP,
    }));
    const bottom = SEQ_TOP + SEQ_HEADER_H + (activeDiagram.edges.length + 1) * SEQ_MSG_GAP + 30;
    const right = PADDING * 2 + Math.max(1, activeDiagram.nodes.length) * SEQ_GAP;
    return { lifelines, bottom, right };
  }, [activeDiagram]);

  useEffect(() => {
    if (!activeDiagram || didInitialFit.current) return;
    if (activeDiagram.kind === "sequence") {
      if (!seq) return;
      setViewBox({ x: 0, y: 0, w: seq.right, h: seq.bottom });
    } else {
      setViewBox({
        x: bounds.minX - PADDING,
        y: bounds.minY - PADDING,
        w: bounds.maxX - bounds.minX + PADDING * 2,
        h: bounds.maxY - bounds.minY + PADDING * 2,
      });
    }
    didInitialFit.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDiagram, bounds, seq]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setViewBox((vb) => {
        if (!vb) return vb;
        const rect = el.getBoundingClientRect();
        const px = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
        const py = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
        const scale = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        const w = Math.min(Math.max(vb.w * scale, 300), 8000);
        const h = Math.min(Math.max(vb.h * scale, 200), 6000);
        return { x: px - ((px - vb.x) / vb.w) * w, y: py - ((py - vb.y) / vb.h) * h, w, h };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc, activeId]);

  if (loadError && !looksMissing(loadError)) {
    return <div className="viewer-empty">Diagrams load error: {loadError}</div>;
  }

  if (loadError) {
    // looksMissing(loadError): diagram.json does not exist yet for this project.
    const createDocument = async () => {
      setCreating(true);
      setError(null);
      const today = new Date().toISOString().slice(0, 10);
      const skeleton: DiagramDoc = {
        meta: { project, title: `${project} — diagrams`, date: today, status: "draft" },
        diagrams: [{ id: "arch-overview", kind: "architecture", title: "Architecture overview", groups: [], nodes: [], edges: [] }],
      };
      try {
        await apiClient.putDoc(project, "diagram", skeleton);
        useToastStore.getState().push("Diagram document created");
        onSaved();
        reloadDiscardingChanges();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not create the document");
      } finally {
        setCreating(false);
      }
    };
    return (
      <div className="viewer-empty dg-empty">
        <p>No technical diagrams yet for this project.</p>
        <button type="button" className="mini-btn primary" disabled={creating} onClick={createDocument}>
          <Icon name="plus" size={13} />
          <span>{creating ? "creating…" : "New diagram"}</span>
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: DiagramDoc) => DiagramDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };
  const mutateActive = (fn: (dg: Diagram) => void) => {
    mutate((d) => {
      const dg = d.diagrams.find((x) => x.id === activeId);
      if (dg) fn(dg);
      return d;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "diagram", doc);
      setDirty(false);
      useToastStore.getState().push("Diagram saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  // ---- diagram-level actions (tab bar) ----

  const addDiagram = (kind: DiagramKind) => {
    const id = uniqueId(doc.diagrams.map((d) => d.id), `${kind}-diagram`);
    mutate((d) => { d.diagrams.push({ id, kind, title: "New diagram", groups: [], nodes: [], edges: [] }); return d; });
    setActiveId(id);
    setOpenMenu(null);
  };

  const deleteDiagram = (id: string) => {
    const remaining = doc.diagrams.filter((d) => d.id !== id);
    mutate((d) => { d.diagrams = d.diagrams.filter((dg) => dg.id !== id); return d; });
    if (activeId === id) setActiveId(remaining[0]?.id ?? null);
  };

  const commitDiagramRename = () => {
    const r = diagramRename;
    setDiagramRename(null);
    if (!r) return;
    const title = r.title.trim();
    if (!title) return;
    mutate((d) => { const dg = d.diagrams.find((x) => x.id === r.id); if (dg) dg.title = title; return d; });
  };

  // ---- node / group / edge actions (active diagram) ----

  const addNode = (cls: DiagramNodeClass) => {
    if (!activeDiagram) return;
    const id = uniqueId(activeDiagram.nodes.map((n) => n.id), slugify(cls));
    const node: DiagramNode = { id, label: "New node", class: cls };
    if (activeDiagram.kind !== "sequence" && viewBox) {
      const size = nodeSize(cls);
      node.pos = {
        x: Math.round(viewBox.x + viewBox.w / 2 - size.w / 2),
        y: Math.round(viewBox.y + viewBox.h / 2 - size.h / 2),
      };
    }
    mutateActive((dg) => { dg.nodes.push(node); });
    setOpenMenu(null);
    setSel({ type: "node", id });
  };

  const addGroup = () => {
    if (!activeDiagram) return;
    const id = uniqueId((activeDiagram.groups ?? []).map((g) => g.id), "group");
    mutateActive((dg) => { dg.groups = [...(dg.groups ?? []), { id, label: "New group" }]; });
  };

  const deleteSelected = () => {
    if (!sel) return;
    if (sel.type === "node") {
      mutateActive((dg) => {
        dg.nodes = dg.nodes.filter((n) => n.id !== sel.id);
        dg.edges = dg.edges.filter((e) => e.from !== sel.id && e.to !== sel.id);
      });
    } else if (sel.type === "group") {
      mutateActive((dg) => {
        const remaining = (dg.groups ?? []).filter((g) => g.id !== sel.id);
        remaining.forEach((g) => { if (g.parent === sel.id) g.parent = undefined; });
        dg.groups = remaining;
        dg.nodes.forEach((n) => { if (n.group === sel.id) n.group = undefined; });
      });
    } else if (sel.type === "edge") {
      mutateActive((dg) => { dg.edges.splice(sel.index, 1); });
    }
    setSel(null);
  };

  const patchEdge = (index: number, patch: Partial<DiagramEdge>) =>
    mutateActive((dg) => { Object.assign(dg.edges[index], patch); });

  const moveNode = (fromIdx: number, toIdx: number) =>
    mutateActive((dg) => {
      if (toIdx < 0 || toIdx >= dg.nodes.length) return;
      const [n] = dg.nodes.splice(fromIdx, 1);
      dg.nodes.splice(toIdx, 0, n);
    });

  const moveEdge = (fromIdx: number, toIdx: number) =>
    mutateActive((dg) => {
      if (toIdx < 0 || toIdx >= dg.edges.length) return;
      const [e] = dg.edges.splice(fromIdx, 1);
      dg.edges.splice(toIdx, 0, e);
    });

  const addMessage = () => {
    if (!activeDiagram || activeDiagram.nodes.length < 1) return;
    const from = activeDiagram.nodes[0].id;
    const to = activeDiagram.nodes[1]?.id ?? from;
    mutateActive((dg) => { dg.edges.push({ from, to, style: "solid" }); });
    setSel({ type: "edge", index: activeDiagram.edges.length });
  };

  // ---- node editing (double-click) ----

  const startNodeEdit = (node: DiagramNode) =>
    setEditingNode({ id: node.id, label: node.label, desc: node.desc ?? "", group: node.group });
  const commitNodeEdit = () => {
    const en = editingNode;
    if (!en) return;
    setEditingNode(null);
    const label = en.label.trim() || "node";
    const desc = en.desc.trim();
    mutateActive((dg) => {
      const n = dg.nodes.find((x) => x.id === en.id);
      if (n) { n.label = label; n.desc = desc || undefined; n.group = en.group || undefined; }
    });
  };

  const startGroupEdit = (g: DiagramGroup) => setEditingGroup({ id: g.id, label: g.label });
  const commitGroupEdit = () => {
    const eg = editingGroup;
    if (!eg) return;
    setEditingGroup(null);
    const label = eg.label.trim();
    if (!label) return;
    mutateActive((dg) => { const g = (dg.groups ?? []).find((x) => x.id === eg.id); if (g) g.label = label; });
  };

  // ---- canvas pan/zoom (background) ----

  const onCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!viewBox) return;
    setSel(null);
    panRef.current = { x: e.clientX, y: e.clientY, vb: viewBox };
    setPanning(true);
  };
  const onCanvasPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!panRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const { x, y, vb } = panRef.current;
    const dx = ((e.clientX - x) / rect.width) * vb.w;
    const dy = ((e.clientY - y) / rect.height) * vb.h;
    setViewBox({ ...vb, x: vb.x - dx, y: vb.y - dy });
  };
  const endPan = () => { panRef.current = null; setPanning(false); };

  const zoomBtn = (factor: number) => () =>
    setViewBox((vb) => {
      if (!vb) return vb;
      const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
      const w = vb.w * factor, h = vb.h * factor;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    });
  const resetView = () => {
    if (activeDiagram?.kind === "sequence" && seq) {
      setViewBox({ x: 0, y: 0, w: seq.right, h: seq.bottom });
      return;
    }
    const b = computeBounds([...boxes, ...groupBoxes, ...laneRects]);
    setViewBox({ x: b.minX - PADDING, y: b.minY - PADDING, w: b.maxX - b.minX + PADDING * 2, h: b.maxY - b.minY + PADDING * 2 });
  };

  // ---- node drag (reposition) ----

  const onNodePointerDown = (e: React.PointerEvent, box: NodeBox) => {
    e.stopPropagation();
    setSel({ type: "node", id: box.node.id });
    const svg = svgRef.current;
    if (!svg) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    dragRef.current = { id: box.node.id, startX: pt.x, startY: pt.y, origX: box.x, origY: box.y };
    setDragOverride({ id: box.node.id, x: box.x, y: box.y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const svg = svgRef.current;
    if (!svg) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    setDragOverride({ id: d.id, x: d.origX + (pt.x - d.startX), y: d.origY + (pt.y - d.startY) });
  };
  const onNodePointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    setDragOverride((ov) => {
      if (ov && ov.id === d.id) {
        mutateActive((dg) => {
          const n = dg.nodes.find((n) => n.id === d.id);
          if (n) n.pos = { x: Math.round(ov.x), y: Math.round(ov.y) };
        });
      }
      return null;
    });
  };

  // ---- create an edge by dragging from a node's port ----

  const onPortPointerDown = (e: React.PointerEvent, box: NodeBox) => {
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    setConnDrag({ fromId: box.node.id, x: pt.x, y: pt.y });
    (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
  };
  const onPortPointerMove = (e: React.PointerEvent) => {
    if (!connDrag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    setConnDrag((cd) => (cd ? { ...cd, x: pt.x, y: pt.y } : cd));
  };
  const onPortPointerUp = () => {
    if (!connDrag) return;
    if (dragTarget) {
      mutateActive((dg) => { dg.edges.push({ from: connDrag.fromId, to: dragTarget.node.id, style: "solid" }); });
      setSel({ type: "edge", index: (activeDiagram?.edges.length ?? 0) });
    }
    setConnDrag(null);
  };

  // ---- popover screen positions (canvas-anchored) ----

  const screenOf = (x: number, y: number): { left: number; top: number } | null => {
    if (!svgRef.current || !canvasWrapRef.current) return null;
    const p = toScreenPoint(svgRef.current, x, y);
    const wrap = canvasWrapRef.current.getBoundingClientRect();
    return { left: p.x - wrap.left, top: p.y - wrap.top };
  };

  const groups = activeDiagram?.groups ?? [];

  return (
    <div className="dg-editor">
      {stale && (
        <div className="stale-banner">
          <Icon name="triangle-alert" size={15} />
          <span>The document changed on disk (updated in the meantime). Unsaved changes here were left untouched.</span>
          <ConfirmButton label="reload from disk" confirmLabel="you'll lose your changes: confirm" onConfirm={reloadDiscardingChanges} />
        </div>
      )}

      <div className="dg-tabbar">
        {doc.diagrams.map((d) => (
          <div
            key={d.id}
            className={`dg-tab ${d.id === activeId ? "active" : ""}`}
            onClick={() => setActiveId(d.id)}
          >
            {diagramRename?.id === d.id ? (
              <input
                className="dg-rename-input"
                autoFocus
                value={diagramRename.title}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDiagramRename({ id: d.id, title: e.target.value })}
                onBlur={commitDiagramRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                  if (e.key === "Escape") setDiagramRename(null);
                }}
              />
            ) : (
              <span onDoubleClick={(e) => { e.stopPropagation(); setDiagramRename({ id: d.id, title: d.title }); }}>
                {d.title}
              </span>
            )}
            <span className="dg-tab-kind">{KIND_LABEL[d.kind]}</span>
            <ConfirmButton
              className="icon-btn danger dg-tab-delete"
              icon="trash-2"
              iconSize={12}
              label="delete diagram"
              confirmLabel="confirm"
              onConfirm={() => deleteDiagram(d.id)}
            />
          </div>
        ))}
        <div className="dg-menu-anchor">
          <button
            type="button"
            className="ghost-btn small dg-menu-trigger"
            onClick={() => setOpenMenu((m) => (m?.kind === "add-diagram" ? null : { kind: "add-diagram" }))}
          >
            <Icon name="plus" size={12} />
            <span>diagram</span>
          </button>
          {openMenu?.kind === "add-diagram" && (
            <div ref={menuRef}>
              <PickerMenu
                items={DIAGRAM_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] }))}
                onPick={(k) => addDiagram(k as DiagramKind)}
              />
            </div>
          )}
        </div>
      </div>

      {!activeDiagram ? (
        <div className="viewer-empty">No diagrams in this document yet. Use "+ diagram" above to add one.</div>
      ) : (
        <>
          <div className="table-toolbar">
            <div className="dg-menu-anchor">
              <button
                type="button"
                className="ghost-btn dg-menu-trigger"
                onClick={() => setOpenMenu((m) => (m?.kind === "add-node" ? null : { kind: "add-node" }))}
              >
                <Icon name="plus" size={14} />
                <span>node</span>
              </button>
              {openMenu?.kind === "add-node" && (
                <div ref={menuRef}>
                  <PickerMenu items={NODE_CLASSES.map((c) => ({ key: c, label: CLASS_LABEL[c] }))} onPick={(c) => addNode(c as DiagramNodeClass)} />
                </div>
              )}
            </div>
            {activeDiagram.kind !== "sequence" && (
              <button type="button" className="ghost-btn" onClick={addGroup}>
                <Icon name="plus" size={14} />
                <span>group</span>
              </button>
            )}
            {sel && (
              <ConfirmButton
                className="mini-btn danger"
                label="delete selected"
                confirmLabel="confirm delete"
                onConfirm={deleteSelected}
              />
            )}
            <input
              className="dg-notes-input"
              placeholder="notes (optional caption shown under the title)…"
              value={activeDiagram.notes ?? ""}
              onChange={(e) => mutateActive((dg) => { dg.notes = e.target.value || undefined; })}
            />
            <span className="spacer" />
            {error && <span className="error-text">{error}</span>}
            {dirty && !error && <span className="vh-dirty">unsaved changes</span>}
            <button className="mini-btn primary" disabled={!dirty || saving} onClick={save}>
              {saving ? "saving…" : "save"}
            </button>
          </div>

          <div className="dg-canvas-wrap" ref={canvasWrapRef}>
            <svg
              ref={svgRef}
              className={`dg-wrap ${panning ? "panning" : ""}`}
              viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : undefined}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={endPan}
              onPointerLeave={endPan}
            >
              <defs>
                <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#9a908e" />
                </marker>
                <marker id="dg-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
                </marker>
              </defs>

              {activeDiagram.kind === "sequence" && seq ? (
                <g className="dg-seq">
                  {/* lifelines */}
                  {seq.lifelines.map(({ node, x, cx }, i) => (
                    <g key={node.id} className={`dg-seq-header ${sel?.type === "node" && sel.id === node.id ? "selected" : ""}`}>
                      <line x1={cx} y1={SEQ_TOP + SEQ_HEADER_H} x2={cx} y2={seq.bottom} className="dg-seq-lifeline" />
                      <rect
                        x={x} y={SEQ_TOP} width={SEQ_HEADER_W} height={SEQ_HEADER_H} rx={8}
                        className="dg-node-shape"
                        stroke={sel?.type === "node" && sel.id === node.id ? "var(--accent)" : classColorVar(node.class)}
                        strokeWidth={sel?.type === "node" && sel.id === node.id ? 2.4 : 1.6}
                        fill="var(--panel-2)"
                        onPointerDown={(e) => { e.stopPropagation(); setSel({ type: "node", id: node.id }); }}
                        onDoubleClick={(e) => { e.stopPropagation(); startNodeEdit(node); }}
                      />
                      {editingNode?.id === node.id ? (
                        <foreignObject x={x} y={SEQ_TOP + 4} width={SEQ_HEADER_W} height={SEQ_HEADER_H - 8} onPointerDown={(e) => e.stopPropagation()}>
                          <div
                            className="dg-edit-box dg-edit-box-inline"
                            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commitNodeEdit(); }}
                          >
                            <input
                              autoFocus
                              value={editingNode.label}
                              placeholder="label"
                              onChange={(e) => setEditingNode({ ...editingNode, label: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingNode(null); }}
                            />
                            <input
                              value={editingNode.desc}
                              placeholder="description"
                              onChange={(e) => setEditingNode({ ...editingNode, desc: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingNode(null); }}
                            />
                          </div>
                        </foreignObject>
                      ) : (
                        <>
                          <text x={x + SEQ_HEADER_W / 2} y={SEQ_TOP + 20} textAnchor="middle" className="dg-node-label" style={{ pointerEvents: "none" }}>
                            {node.label}
                          </text>
                          {node.desc && (
                            <text x={x + SEQ_HEADER_W / 2} y={SEQ_TOP + 35} textAnchor="middle" className="dg-node-desc" style={{ pointerEvents: "none" }}>
                              {node.desc}
                            </text>
                          )}
                        </>
                      )}
                      <foreignObject x={x - 2} y={SEQ_TOP - 22} width={44} height={20} className="dg-seq-reorder" onPointerDown={(e) => e.stopPropagation()}>
                        <div className="dg-seq-reorder-row">
                          <button type="button" className="icon-btn" disabled={i === 0} title="move left" onClick={() => moveNode(i, i - 1)}>
                            <Icon name="chevron-left" size={11} />
                          </button>
                          <button type="button" className="icon-btn" disabled={i === seq.lifelines.length - 1} title="move right" onClick={() => moveNode(i, i + 1)}>
                            <Icon name="chevron-right" size={11} />
                          </button>
                        </div>
                      </foreignObject>
                    </g>
                  ))}

                  {/* messages */}
                  {activeDiagram.edges.map((edge, i) => {
                    const fromLine = seq.lifelines.find((l) => l.node.id === edge.from);
                    const toLine = seq.lifelines.find((l) => l.node.id === edge.to);
                    if (!fromLine || !toLine) return null;
                    const y = SEQ_TOP + SEQ_HEADER_H + (i + 1) * SEQ_MSG_GAP;
                    const isSelf = edge.from === edge.to;
                    const isSel = sel?.type === "edge" && sel.index === i;
                    const path = isSelf
                      ? `M ${fromLine.cx} ${y} h 46 v 18 h -46`
                      : `M ${fromLine.cx} ${y} L ${toLine.cx} ${y}`;
                    return (
                      <g key={i} className={`dg-seq-msg ${isSel ? "selected" : ""}`}>
                        <path
                          className="dg-seq-msg-hit"
                          d={path}
                          onPointerDown={(e) => { e.stopPropagation(); setSel({ type: "edge", index: i }); }}
                        />
                        <path
                          className="dg-seq-msg-line"
                          d={path}
                          stroke={isSel ? "var(--accent)" : "var(--muted)"}
                          strokeDasharray={edge.style === "dashed" ? "5 4" : undefined}
                          markerEnd={isSel ? "url(#dg-arrow-sel)" : "url(#dg-arrow)"}
                        />
                        {edge.label && (
                          <text
                            x={(fromLine.cx + toLine.cx) / 2}
                            y={y - 6}
                            textAnchor="middle"
                            className="dg-seq-msg-label"
                            style={{ pointerEvents: "none" }}
                          >
                            {edge.label}
                          </text>
                        )}
                        <foreignObject x={PADDING - 58} y={y - 12} width={40} height={20} className="dg-seq-reorder" onPointerDown={(e) => e.stopPropagation()}>
                          <div className="dg-seq-reorder-row">
                            <button type="button" className="icon-btn" disabled={i === 0} title="move up" onClick={() => moveEdge(i, i - 1)}>
                              <Icon name="arrow-up" size={11} />
                            </button>
                            <button type="button" className="icon-btn" disabled={i === activeDiagram.edges.length - 1} title="move down" onClick={() => moveEdge(i, i + 1)}>
                              <Icon name="arrow-down" size={11} />
                            </button>
                          </div>
                        </foreignObject>
                      </g>
                    );
                  })}

                  {/* add-message ghost row */}
                  {seq.lifelines.length > 0 && (
                    <g
                      className="dg-seq-add-msg"
                      onPointerDown={(e) => { e.stopPropagation(); addMessage(); }}
                    >
                      <line
                        x1={seq.lifelines[0].cx}
                        y1={SEQ_TOP + SEQ_HEADER_H + (activeDiagram.edges.length + 1) * SEQ_MSG_GAP}
                        x2={seq.lifelines[seq.lifelines.length - 1].cx}
                        y2={SEQ_TOP + SEQ_HEADER_H + (activeDiagram.edges.length + 1) * SEQ_MSG_GAP}
                      />
                      <text
                        x={(seq.lifelines[0].cx + seq.lifelines[seq.lifelines.length - 1].cx) / 2}
                        y={SEQ_TOP + SEQ_HEADER_H + (activeDiagram.edges.length + 1) * SEQ_MSG_GAP - 6}
                        textAnchor="middle"
                      >
                        + message
                      </text>
                    </g>
                  )}
                </g>
              ) : (
                <>
                  {isSwimlane ? (
                    <>
                      {systemBoxes.map((sys) => {
                        const lastLane = laneBoxes[laneBoxes.length - 1];
                        const bottomY = lastLane ? lastLane.y + lastLane.h + sys.yOffset : sys.yOffset;
                        return (
                          <g key={`sys-${sys.index}`} className="dg-lane-system">
                            {laneBoxes.map((lane) => {
                              const isRealGroup = lane.id !== OTHER_LANE_ID;
                              const laneSelected = sel?.type === "group" && sel.id === lane.id;
                              const y = lane.y + sys.yOffset;
                              return (
                                <g key={lane.id} className={`dg-lane ${laneSelected ? "selected" : ""}`}>
                                  <rect
                                    className={`dg-lane-bg ${lane.index % 2 === 1 ? "dg-lane-bg-alt" : ""}`}
                                    x={0} y={y} width={sys.width} height={lane.h}
                                    onPointerDown={isRealGroup ? (e) => { e.stopPropagation(); setSel({ type: "group", id: lane.id }); } : undefined}
                                  />
                                  {editingGroup?.id === lane.id && sys.index === 0 ? (
                                    <foreignObject x={8} y={y + lane.h / 2 - 11} width={LANE_LABEL_W - 16} height={22} onPointerDown={(e) => e.stopPropagation()}>
                                      <input
                                        className="dg-rename-input"
                                        autoFocus
                                        value={editingGroup.label}
                                        onChange={(e) => setEditingGroup({ ...editingGroup, label: e.target.value })}
                                        onBlur={commitGroupEdit}
                                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingGroup(null); }}
                                      />
                                    </foreignObject>
                                  ) : (
                                    <text
                                      x={12}
                                      y={y + lane.h / 2}
                                      dominantBaseline="middle"
                                      className="dg-lane-label"
                                      onDoubleClick={isRealGroup ? (e) => { e.stopPropagation(); const g = groups.find((x) => x.id === lane.id); if (g) startGroupEdit(g); } : undefined}
                                    >
                                      {lane.label}
                                    </text>
                                  )}
                                </g>
                              );
                            })}
                            {laneBoxes.map((lane) => (
                              <line key={`b-${lane.id}`} className="dg-lane-border" x1={0} y1={lane.y + sys.yOffset} x2={sys.width} y2={lane.y + sys.yOffset} />
                            ))}
                            {laneBoxes.length > 0 && (
                              <>
                                <line className="dg-lane-border" x1={0} y1={bottomY} x2={sys.width} y2={bottomY} />
                                <line className="dg-lane-border dg-lane-border-strong" x1={LANE_LABEL_W} y1={sys.yOffset} x2={LANE_LABEL_W} y2={bottomY} />
                              </>
                            )}
                          </g>
                        );
                      })}
                    </>
                  ) : (
                    groupBoxes.map((gb) => (
                      <g
                        key={gb.group.id}
                        className={`dg-group ${sel?.type === "group" && sel.id === gb.group.id ? "selected" : ""}`}
                        onPointerDown={(e) => { e.stopPropagation(); setSel({ type: "group", id: gb.group.id }); }}
                      >
                        <rect className="dg-group-box" x={gb.x} y={gb.y} width={gb.w} height={gb.h} rx={10} />
                        {editingGroup?.id === gb.group.id ? (
                          <foreignObject x={gb.x + 8} y={gb.y + 3} width={Math.min(gb.w - 16, 220)} height={20} onPointerDown={(e) => e.stopPropagation()}>
                            <input
                              className="dg-rename-input"
                              autoFocus
                              value={editingGroup.label}
                              onChange={(e) => setEditingGroup({ ...editingGroup, label: e.target.value })}
                              onBlur={commitGroupEdit}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingGroup(null); }}
                            />
                          </foreignObject>
                        ) : (
                          <text
                            x={gb.x + 10}
                            y={gb.y + 17}
                            className="dg-group-label"
                            onDoubleClick={(e) => { e.stopPropagation(); startGroupEdit(gb.group); }}
                          >
                            {gb.group.label}
                          </text>
                        )}
                        {groups.length > 1 && (
                          <foreignObject x={gb.x + gb.w - 26} y={gb.y + 2} width={22} height={22} className="dg-group-actions" onPointerDown={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="icon-btn dg-menu-trigger"
                              title="nest inside another group"
                              onClick={() => setOpenMenu((m) => (m && m.kind === "group-settings" && m.groupId === gb.group.id ? null : { kind: "group-settings", groupId: gb.group.id }))}
                            >
                              <Icon name="link-2" size={12} />
                            </button>
                          </foreignObject>
                        )}
                      </g>
                    ))
                  )}

                  {activeDiagram.edges.map((edge, i) => {
                    const fromBox = boxes.find((b) => b.node.id === edge.from);
                    const toBox = boxes.find((b) => b.node.id === edge.to);
                    if (!fromBox || !toBox) return null;
                    const isSelf = edge.from === edge.to;
                    const isSel = sel?.type === "edge" && sel.index === i;

                    // Swimlane mode, endpoints in different systems: an edge crossing the fold
                    // (forward skip or back-edge alike) never draws as a line wrapping across
                    // the whole score — it renders as a pair of BPMN-style off-page connectors,
                    // a numbered stub leaving the source system's right edge and its twin
                    // entering the destination system's left edge, per the task contract.
                    if (isSwimlane && swimlane) {
                      const fromRank = rankInfo.get(edge.from) ?? 0;
                      const toRank = rankInfo.get(edge.to) ?? 0;
                      const fromSys = swimlane.rankSystem[fromRank] ?? 0;
                      const toSys = swimlane.rankSystem[toRank] ?? 0;
                      if (fromSys !== toSys) {
                        const num = crossingSystem.get(i) ?? 0;
                        const exitSys = swimlane.systems[fromSys];
                        const exitY = fromBox.y + fromBox.h / 2;
                        const exitX = exitSys ? exitSys.width : fromBox.x + fromBox.w;
                        const enterY = toBox.y + toBox.h / 2;
                        const enterX = LANE_LABEL_W;
                        const stroke = isSel ? "var(--accent)" : "var(--muted)";
                        return (
                          <g
                            key={i}
                            className={`dg-offpage ${isSel ? "selected" : ""}`}
                            onPointerDown={(e) => { e.stopPropagation(); setSel({ type: "edge", index: i }); }}
                          >
                            <path
                              className="dg-edge-line"
                              d={`M ${fromBox.x + fromBox.w} ${exitY} L ${exitX} ${exitY}`}
                              stroke={stroke}
                              strokeWidth={isSel ? 2.2 : 1.4}
                              strokeDasharray={edge.style === "dashed" ? "6 4" : undefined}
                            />
                            <circle className="dg-offpage-circle" cx={exitX} cy={exitY} r={OFFPAGE_R} stroke={stroke}>
                              <title>{`→ ${toBox.node.label}`}</title>
                            </circle>
                            <text className="dg-offpage-num" x={exitX} y={exitY} textAnchor="middle" dominantBaseline="central">
                              {num}
                            </text>

                            <path
                              className="dg-edge-line"
                              d={`M ${enterX} ${enterY} L ${toBox.x} ${enterY}`}
                              stroke={stroke}
                              strokeWidth={isSel ? 2.2 : 1.4}
                              strokeDasharray={edge.style === "dashed" ? "6 4" : undefined}
                              markerEnd={isSel ? "url(#dg-arrow-sel)" : "url(#dg-arrow)"}
                            />
                            <circle className="dg-offpage-circle" cx={enterX} cy={enterY} r={OFFPAGE_R} stroke={stroke}>
                              <title>{`← ${fromBox.node.label}`}</title>
                            </circle>
                            <text className="dg-offpage-num" x={enterX} y={enterY} textAnchor="middle" dominantBaseline="central">
                              {num}
                            </text>
                            {edge.label && (
                              <text x={exitX} y={exitY - 14} textAnchor="middle" className="dg-edge-label" style={{ pointerEvents: "none" }}>
                                {edge.label}
                              </text>
                            )}
                          </g>
                        );
                      }
                    }

                    let path: string;
                    let midX: number, midY: number;
                    if (isSelf) {
                      const bx = fromBox.x + fromBox.w, by = fromBox.y + fromBox.h * 0.3;
                      path = `M ${bx} ${by} C ${bx + 44} ${by - 12}, ${bx + 44} ${by + fromBox.h * 0.4 + 12}, ${bx} ${by + fromBox.h * 0.4}`;
                      midX = bx + 40; midY = by + fromBox.h * 0.2;
                    } else {
                      const fromCenter = { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 };
                      const toCenter = { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 };
                      const from = borderPoint(fromBox, toCenter);
                      const to = borderPoint(toBox, fromCenter);
                      path = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
                      midX = (from.x + to.x) / 2; midY = (from.y + to.y) / 2;
                    }
                    return (
                      <g key={i}>
                        <path
                          className="dg-edge-hit"
                          d={path}
                          onPointerDown={(e) => { e.stopPropagation(); setSel({ type: "edge", index: i }); }}
                        />
                        <path
                          className="dg-edge-line"
                          d={path}
                          stroke={isSel ? "var(--accent)" : "var(--muted)"}
                          strokeWidth={isSel ? 2.2 : 1.4}
                          strokeDasharray={edge.style === "dashed" ? "6 4" : undefined}
                          markerEnd={isSel ? "url(#dg-arrow-sel)" : "url(#dg-arrow)"}
                        />
                        {edge.label && (
                          <text x={midX} y={midY - 5} textAnchor="middle" className="dg-edge-label" style={{ pointerEvents: "none" }}>
                            {edge.label}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {boxes.map((box) => {
                    const isSel = sel?.type === "node" && sel.id === box.node.id;
                    const { labelY, descY } = labelPos(box);
                    const isEditing = editingNode?.id === box.node.id;
                    return (
                      <g
                        key={box.node.id}
                        className="dg-node"
                        onPointerDown={(e) => onNodePointerDown(e, box)}
                        onPointerMove={onNodePointerMove}
                        onPointerUp={onNodePointerUp}
                        onDoubleClick={(e) => { e.stopPropagation(); startNodeEdit(box.node); }}
                      >
                        <NodeShape box={box} colorVar={classColorVar(box.node.class)} selected={isSel} />

                        {!isEditing && (
                          <>
                            <text x={box.x + box.w / 2} y={labelY} textAnchor="middle" className="dg-node-label" style={{ pointerEvents: "none" }}>
                              {box.node.label}
                            </text>
                            {box.node.desc && descY !== null && (
                              <text x={box.x + box.w / 2} y={descY} textAnchor="middle" className="dg-node-desc" style={{ pointerEvents: "none" }}>
                                {box.node.desc}
                              </text>
                            )}
                          </>
                        )}

                        {isEditing && (() => {
                          const h = isSwimlane ? 92 : 64;
                          return (
                            <foreignObject x={box.x + box.w / 2 - 90} y={box.y + box.h / 2 - h / 2} width={180} height={h} onPointerDown={(e) => e.stopPropagation()}>
                              <div
                                className="dg-edit-box"
                                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commitNodeEdit(); }}
                              >
                                <input
                                  autoFocus
                                  value={editingNode.label}
                                  placeholder="label"
                                  onChange={(e) => setEditingNode({ ...editingNode, label: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingNode(null); }}
                                />
                                <input
                                  value={editingNode.desc}
                                  placeholder="description (optional)"
                                  onChange={(e) => setEditingNode({ ...editingNode, desc: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingNode(null); }}
                                />
                                {isSwimlane && (
                                  <select
                                    value={editingNode.group ?? ""}
                                    onChange={(e) => setEditingNode({ ...editingNode, group: e.target.value || undefined })}
                                  >
                                    <option value="">(no lane)</option>
                                    {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                                  </select>
                                )}
                              </div>
                            </foreignObject>
                          );
                        })()}

                        {groups.length > 0 && (
                          <foreignObject x={box.x + box.w - 22} y={box.y - 22} width={22} height={22} className="dg-node-actions" onPointerDown={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="icon-btn dg-menu-trigger"
                              title="assign group"
                              onClick={() => setOpenMenu((m) => (m && m.kind === "group-assign" && m.nodeId === box.node.id ? null : { kind: "group-assign", nodeId: box.node.id }))}
                            >
                              <Icon name="droplet" size={12} />
                            </button>
                          </foreignObject>
                        )}

                        <circle
                          className="dg-port-dot"
                          cx={box.x + box.w}
                          cy={box.y + box.h / 2}
                          r={5}
                          onPointerDown={(e) => onPortPointerDown(e, box)}
                          onPointerMove={onPortPointerMove}
                          onPointerUp={onPortPointerUp}
                        >
                          <title>drag to connect</title>
                        </circle>
                      </g>
                    );
                  })}

                  {connDrag && (() => {
                    const src = boxes.find((b) => b.node.id === connDrag.fromId);
                    if (!src) return null;
                    return (
                      <path
                        d={`M ${src.x + src.w} ${src.y + src.h / 2} L ${connDrag.x} ${connDrag.y}`}
                        stroke="var(--accent)"
                        strokeWidth={1.6}
                        strokeDasharray="4 3"
                        fill="none"
                        style={{ pointerEvents: "none" }}
                      />
                    );
                  })()}
                </>
              )}
            </svg>

            <div className="er-controls">
              <button className="mini-btn" onClick={zoomBtn(1 / 1.25)}>+</button>
              <button className="mini-btn" onClick={zoomBtn(1.25)}>−</button>
              <button className="mini-btn" onClick={resetView}>reset</button>
            </div>

            {openMenu?.kind === "group-assign" && (() => {
              const box = boxes.find((b) => b.node.id === openMenu.nodeId);
              if (!box) return null;
              const pos = screenOf(box.x + box.w, box.y);
              if (!pos) return null;
              const node = activeDiagram.nodes.find((n) => n.id === openMenu.nodeId);
              return (
                <div className="dg-picker" ref={menuRef} style={{ position: "absolute", left: pos.left, top: pos.top }}>
                  <div
                    className="dg-picker-item"
                    onClick={() => { mutateActive((dg) => { const n = dg.nodes.find((x) => x.id === openMenu.nodeId); if (n) n.group = undefined; }); setOpenMenu(null); }}
                  >
                    (no group){!node?.group ? " ✓" : ""}
                  </div>
                  {groups.map((g) => (
                    <div
                      key={g.id}
                      className="dg-picker-item"
                      onClick={() => { mutateActive((dg) => { const n = dg.nodes.find((x) => x.id === openMenu.nodeId); if (n) n.group = g.id; }); setOpenMenu(null); }}
                    >
                      {g.label}{node?.group === g.id ? " ✓" : ""}
                    </div>
                  ))}
                </div>
              );
            })()}

            {openMenu?.kind === "group-settings" && (() => {
              const gb = groupBoxes.find((b) => b.group.id === openMenu.groupId);
              const anchorX = gb ? gb.x + gb.w : (boxes[0]?.x ?? 0);
              const anchorY = gb ? gb.y : (boxes[0]?.y ?? 0);
              const pos = screenOf(anchorX, anchorY);
              if (!pos) return null;
              const g = groups.find((x) => x.id === openMenu.groupId);
              if (!g) return null;
              const options = eligibleParents(groups, g.id);
              return (
                <div className="dg-popover" ref={menuRef} style={{ position: "absolute", left: pos.left, top: pos.top }}>
                  <label className="muted">nest inside</label>
                  <select
                    value={g.parent ?? ""}
                    onChange={(e) => {
                      const val = e.target.value || undefined;
                      mutateActive((dg) => { const target = (dg.groups ?? []).find((x) => x.id === g.id); if (target) target.parent = val; });
                      setOpenMenu(null);
                    }}
                  >
                    <option value="">(top level)</option>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
              );
            })()}

            {sel?.type === "edge" && activeDiagram.edges[sel.index] && (() => {
              const edge = activeDiagram.edges[sel.index];
              let pos: { left: number; top: number } | null = null;
              if (activeDiagram.kind === "sequence" && seq) {
                const fromLine = seq.lifelines.find((l) => l.node.id === edge.from);
                const toLine = seq.lifelines.find((l) => l.node.id === edge.to);
                if (fromLine && toLine) {
                  const y = SEQ_TOP + SEQ_HEADER_H + (sel.index + 1) * SEQ_MSG_GAP;
                  pos = screenOf((fromLine.cx + toLine.cx) / 2, y);
                }
              } else {
                const fromBox = boxes.find((b) => b.node.id === edge.from);
                const toBox = boxes.find((b) => b.node.id === edge.to);
                if (fromBox && toBox) {
                  pos = screenOf((fromBox.x + fromBox.w / 2 + toBox.x + toBox.w / 2) / 2, (fromBox.y + fromBox.h / 2 + toBox.y + toBox.h / 2) / 2);
                }
              }
              if (!pos) return null;
              return (
                <div className="dg-popover" style={{ position: "absolute", left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
                  {activeDiagram.kind === "sequence" && (
                    <>
                      <label className="muted">from</label>
                      <select value={edge.from} onChange={(e) => patchEdge(sel.index, { from: e.target.value })}>
                        {activeDiagram.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                      </select>
                      <label className="muted">to</label>
                      <select value={edge.to} onChange={(e) => patchEdge(sel.index, { to: e.target.value })}>
                        {activeDiagram.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                      </select>
                    </>
                  )}
                  <input
                    value={edge.label ?? ""}
                    placeholder="label"
                    onChange={(e) => patchEdge(sel.index, { label: e.target.value || undefined })}
                  />
                  <select
                    value={edge.style ?? "solid"}
                    onChange={(e) => patchEdge(sel.index, { style: e.target.value as "solid" | "dashed" })}
                  >
                    <option value="solid">solid</option>
                    <option value="dashed">dashed</option>
                  </select>
                </div>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
