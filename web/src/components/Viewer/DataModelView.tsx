import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient, ApiError } from "../../api/client";
import { useReloadableDoc } from "../../hooks/useReloadableDoc";
import { useToastStore } from "../../store/toastStore";
import type { DataModelArea, DataModelDoc, DataModelField, DataModelRelation, DataModelTable } from "../../types";
import { Icon } from "../icons";
import AnchorButton from "./AnchorButton";
import ConfirmButton from "./ConfirmButton";

// Native data model editor, draw.io style — it replaces draw.io. The JSON
// (data_model.json) stays the source of truth: it saves via PUT like every other live
// document (see useReloadableDoc/EstimateView for the shared dirty/stale/save pattern).
// The per-area grid layout remains the default for tables with no manual position ("pos");
// dragging a box header pins its position in the doc without touching the others (no global
// re-layout).
//
// ALL editing happens inside the boxes on the canvas (SVG + foreignObject for the HTML
// inputs): no side panel. Field name and type are edited inline in the row; PK/FK is a
// clickable badge; relations are created by dragging from the connection dot at the edge of
// a row, and edited with a small floating popover when the edge is selected.

const TABLE_W = 300;
const HEADER_H = 30;
const ROW_H = 22;
const ADD_ROW_H = 20;
const H_GAP = 60;
const V_GAP = 90;
const PADDING = 70;
// Strokes read the accent straight from the stylesheet, so restyling theme.css
// restyles the diagram too. The area colour can't: it gets written into
// data_model.json and has to survive as a literal value.
const ACCENT = "var(--accent)";
const DEFAULT_AREA_COLOR = "#2f80ff";
const IDLE_STROKE = "#5b6478";

const FIELD_TYPES = ["TEXT", "INTEGER", "DECIMAL", "DATE", "DATETIME", "BOOLEAN", "DOCUMENT"];
const RELATION_TYPES = ["N:1", "1:1", "N:M"];

type Box = { table: DataModelTable; x: number; y: number; w: number; h: number };
type Override = { id: string; x: number; y: number } | null;
type ConnDrag = { fromTableId: string; fromField: string; x: number; y: number } | null;
type FieldHit = { tableId: string; fieldName: string } | null;

function tableHeight(table: DataModelTable): number {
  return HEADER_H + table.fields.length * ROW_H + ADD_ROW_H + 8;
}

// Automatic row-per-area layout (the historical behaviour) — used as a fallback for tables
// with no "pos". Tables that have a "pos" stay where they were even when others move.
function layoutTables(doc: DataModelDoc, override: Override): Box[] {
  const autoPos = new Map<string, { x: number; y: number }>();
  let y = 0;
  const areaIds = doc.areas.map((a) => a.id);
  const grouped: DataModelTable[][] = doc.areas.map((a) => doc.tables.filter((t) => t.area === a.id));
  const orphan = doc.tables.filter((t) => !areaIds.includes(t.area));
  if (orphan.length) grouped.push(orphan);

  for (const rowTables of grouped) {
    if (!rowTables.length) continue;
    let x = 0;
    let rowH = 0;
    for (const table of rowTables) {
      autoPos.set(table.id, { x, y });
      rowH = Math.max(rowH, tableHeight(table));
      x += TABLE_W + H_GAP;
    }
    y += rowH + V_GAP;
  }

  return doc.tables.map((table) => {
    const auto = autoPos.get(table.id) ?? { x: 0, y: 0 };
    const base = table.pos ?? auto;
    const pos = override && override.id === table.id ? { x: override.x, y: override.y } : base;
    return { table, x: pos.x, y: pos.y, w: TABLE_W, h: tableHeight(table) };
  });
}

function computeBounds(boxes: Box[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!boxes.length) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY };
}

function findBox(boxes: Box[], key: string): Box | undefined {
  const k = key.trim().toLowerCase();
  return boxes.find((b) => b.table.id.toLowerCase() === k || b.table.name.toLowerCase() === k);
}

function fieldRowIndex(box: Box, fieldName: string): number {
  const k = fieldName.trim().toLowerCase();
  return box.table.fields.findIndex((f) => f.name.toLowerCase() === k);
}

// Finds the field (belonging to a table other than the source one) under the given SVG
// point — used both to highlight the target while dragging a connection and to create the
// relation on release.
function hitField(boxes: Box[], x: number, y: number, excludeTableId: string): FieldHit {
  for (const box of boxes) {
    if (box.table.id === excludeTableId) continue;
    if (x < box.x || x > box.x + box.w) continue;
    const rowsBottom = box.y + HEADER_H + box.table.fields.length * ROW_H;
    if (y < box.y + HEADER_H || y > rowsBottom) continue;
    const fi = Math.floor((y - box.y - HEADER_H) / ROW_H);
    const f = box.table.fields[fi];
    if (!f) continue;
    return { tableId: box.table.id, fieldName: f.name };
  }
  return null;
}

// Geometry shared between drawing the edge and placing the edit popover — this avoids
// computing the same curve twice and risking a mismatch between the two.
function relGeometry(boxes: Box[], rel: DataModelRelation): { path: string; midX: number; midY: number } | null {
  const [fromTab, ...fromRest] = rel.from.split(".");
  const [toTab, ...toRest] = rel.to.split(".");
  const fromBox = findBox(boxes, fromTab);
  const toBox = findBox(boxes, toTab);
  if (!fromBox || !toBox) return null;
  const fromFieldIdx = fieldRowIndex(fromBox, fromRest.join("."));
  const toFieldIdx = fieldRowIndex(toBox, toRest.join("."));
  const fy = fromFieldIdx >= 0 ? fromBox.y + HEADER_H + fromFieldIdx * ROW_H + ROW_H / 2 : fromBox.y + fromBox.h / 2;
  const ty = toFieldIdx >= 0 ? toBox.y + HEADER_H + toFieldIdx * ROW_H + ROW_H / 2 : toBox.y + toBox.h / 2;
  const goRight = fromBox.x <= toBox.x;
  const fx = goRight ? fromBox.x + fromBox.w : fromBox.x;
  const tx = goRight ? toBox.x : toBox.x + toBox.w;
  const midX = (fx + tx) / 2;
  const path = `M ${fx} ${fy} C ${midX} ${fy}, ${midX} ${ty}, ${tx} ${ty}`;
  return { path, midX, midY: (fy + ty) / 2 };
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

// The inverse of toSvgPoint: from SVG coordinates to screen coordinates — used to place the
// HTML popovers (which live outside the SVG) next to a canvas element that moves with
// pan/zoom.
function toScreenPoint(svg: SVGSVGElement, x: number, y: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm);
  return { x: p.x, y: p.y };
}

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "item"
  );
}

function uniqueId(existing: string[], base: string): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`.toLowerCase())) n++;
  return `${base}_${n}`;
}

function newTable(doc: DataModelDoc, cx: number, cy: number): DataModelTable {
  const id = uniqueId(doc.tables.map((t) => t.id), "new_table");
  return {
    id,
    name: "NewTable",
    area: doc.areas[0]?.id ?? "",
    fields: [{ name: "id", type: "INTEGER", pk: true }],
    pos: { x: Math.round(cx - TABLE_W / 2), y: Math.round(cy - 40) },
  };
}

function newArea(doc: DataModelDoc): DataModelArea {
  const id = uniqueId(doc.areas.map((a) => a.id), "new_area");
  return { id, name: "New Area", color: DEFAULT_AREA_COLOR };
}

// Renaming a table (just the human-readable "name") doesn't touch the id — relations and
// fks that reference it by id stay valid. The one case to fix up is a legacy reference made
// by NAME (findBox accepts either id or name): if the name changes, that reference has to be
// updated to keep resolving to the same table.
function renameTableName(doc: DataModelDoc, tableId: string, newName: string): void {
  const table = doc.tables.find((t) => t.id === tableId);
  if (!table) return;
  const oldName = table.name;
  table.name = newName;
  const oldKey = oldName.trim().toLowerCase();
  if (oldKey === tableId.trim().toLowerCase()) return; // name == id: no reference by name is possible
  const fix = (ref: string): string => {
    const dot = ref.indexOf(".");
    if (dot < 0) return ref;
    const tab = ref.slice(0, dot);
    const rest = ref.slice(dot + 1);
    if (tab.trim().toLowerCase() === oldKey) return `${newName}.${rest}`;
    return ref;
  };
  doc.relations.forEach((r) => { r.from = fix(r.from); r.to = fix(r.to); });
  doc.tables.forEach((t) => t.fields.forEach((f) => { if (f.fk) f.fk = fix(f.fk); }));
}

// Deletes a table and cleans up every reference that involves it: relations to and from it,
// plus the fks (on other tables) that point at its fields.
function removeTableFromDoc(doc: DataModelDoc, tableId: string): void {
  const t = doc.tables.find((t) => t.id === tableId);
  if (!t) return;
  const keys = [t.id.toLowerCase(), t.name.toLowerCase()];
  const tabOf = (ref: string) => ref.split(".")[0]?.trim().toLowerCase() ?? "";
  const refersToTable = (ref: string) => keys.includes(tabOf(ref));
  doc.tables = doc.tables.filter((x) => x.id !== tableId);
  doc.relations = doc.relations.filter((r) => !refersToTable(r.from) && !refersToTable(r.to));
  doc.tables.forEach((x) => x.fields.forEach((f) => { if (f.fk && refersToTable(f.fk)) f.fk = undefined; }));
}

export default function DataModelView({
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
    useReloadableDoc<DataModelDoc>(project, "data_model", tick);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; vb: { x: number; y: number; w: number; h: number } } | null>(null);
  const [panning, setPanning] = useState(false);
  const didInitialFit = useRef(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragOverride, setDragOverride] = useState<Override>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [areaPopoverId, setAreaPopoverId] = useState<string | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  const [tableAreaPickerId, setTableAreaPickerId] = useState<string | null>(null);
  const areaPickerRef = useRef<HTMLDivElement>(null);

  const [connDrag, setConnDrag] = useState<ConnDrag>(null);
  const [selectedRelIndex, setSelectedRelIndex] = useState<number | null>(null);
  const relPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!areaPopoverId) return;
    const onClick = (e: MouseEvent) => {
      if (legendRef.current && !legendRef.current.contains(e.target as Node)) setAreaPopoverId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [areaPopoverId]);

  useEffect(() => {
    if (!tableAreaPickerId) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (areaPickerRef.current && areaPickerRef.current.contains(target)) return;
      if (target.closest && target.closest(".dm-area-dot-btn")) return;
      setTableAreaPickerId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [tableAreaPickerId]);

  useEffect(() => {
    if (selectedRelIndex === null) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (relPopoverRef.current && relPopoverRef.current.contains(target)) return;
      if (target.closest && target.closest(".dm-rel-hit")) return;
      setSelectedRelIndex(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [selectedRelIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSelectedRelIndex(null);
      setTableAreaPickerId(null);
      setConnDrag(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    didInitialFit.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const boxes = useMemo(() => (doc ? layoutTables(doc, dragOverride) : []), [doc, dragOverride]);
  const bounds = useMemo(() => computeBounds(boxes), [boxes]);
  const dragTarget = connDrag ? hitField(boxes, connDrag.x, connDrag.y, connDrag.fromTableId) : null;

  useEffect(() => {
    if (doc && !didInitialFit.current) {
      setViewBox({
        x: bounds.minX - PADDING,
        y: bounds.minY - PADDING,
        w: bounds.maxX - bounds.minX + PADDING * 2,
        h: bounds.maxY - bounds.minY + PADDING * 2,
      });
      didInitialFit.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, bounds]);

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
    // depends on doc: on the first render the SVG doesn't exist yet (spinner) and svgRef is
    // null — the listener has to be (re)attached once the document arrives and the SVG mounts.
  }, [doc]);

  if (loadError) return <div className="viewer-empty">Data model load error: {loadError}</div>;
  if (!doc) return <div className="spinner-block"><span className="spinner" />loading…</div>;

  const mutate = (fn: (d: DataModelDoc) => DataModelDoc) => {
    setDoc((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.putDoc(project, "data_model", doc);
      setDirty(false);
      useToastStore.getState().push("Data model saved");
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save error");
    } finally {
      setSaving(false);
    }
  };

  const areaColor = (areaId: string) => doc.areas.find((a) => a.id === areaId)?.color ?? "#555";

  const zoomBtn = (factor: number) => () =>
    setViewBox((vb) => {
      if (!vb) return vb;
      const cx = vb.x + vb.w / 2;
      const cy = vb.y + vb.h / 2;
      const w = vb.w * factor;
      const h = vb.h * factor;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    });

  const resetView = () => {
    const b = computeBounds(boxes);
    setViewBox({ x: b.minX - PADDING, y: b.minY - PADDING, w: b.maxX - b.minX + PADDING * 2, h: b.maxY - b.minY + PADDING * 2 });
  };

  // Canvas panning: only when the pointerdown starts on empty background (the tables stop
  // propagation in their own handlers — see onBoxPointerDown/onHeaderPointerDown and the
  // row foreignObjects).
  const onCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!viewBox) return;
    setSelectedRelIndex(null);
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

  const onBoxPointerDown = (e: React.PointerEvent, tableId: string) => {
    e.stopPropagation();
    if (renamingId && renamingId !== tableId) commitRename();
    setSelectedRelIndex(null);
  };

  const onHeaderPointerDown = (e: React.PointerEvent<SVGRectElement>, box: Box) => {
    e.stopPropagation();
    if (renamingId && renamingId !== box.table.id) commitRename();
    setSelectedRelIndex(null);
    const svg = svgRef.current;
    if (!svg) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    dragRef.current = { id: box.table.id, startX: pt.x, startY: pt.y, origX: box.x, origY: box.y };
    setDragOverride({ id: box.table.id, x: box.x, y: box.y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent<SVGRectElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const svg = svgRef.current;
    if (!svg) return;
    const pt = toSvgPoint(svg, e.clientX, e.clientY);
    setDragOverride({ id: d.id, x: d.origX + (pt.x - d.startX), y: d.origY + (pt.y - d.startY) });
  };
  const onHeaderPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    setDragOverride((ov) => {
      if (ov && ov.id === d.id) {
        mutate((doc) => {
          const t = doc.tables.find((t) => t.id === d.id);
          if (t) t.pos = { x: Math.round(ov.x), y: Math.round(ov.y) };
          return doc;
        });
      }
      return null;
    });
  };

  const startRename = (e: React.MouseEvent, table: DataModelTable) => {
    e.stopPropagation();
    dragRef.current = null;
    setDragOverride(null);
    setRenamingId(table.id);
    setRenameValue(table.name);
  };
  const commitRename = () => {
    const id = renamingId;
    const val = renameValue.trim();
    setRenamingId(null);
    if (id && val) mutate((d) => { renameTableName(d, id, val); return d; });
  };

  const addTable = () => {
    if (!viewBox) return;
    const cx = viewBox.x + viewBox.w / 2;
    const cy = viewBox.y + viewBox.h / 2;
    mutate((d) => { d.tables.push(newTable(d, cx, cy)); return d; });
  };

  const addArea = () => mutate((d) => { d.areas.push(newArea(d)); return d; });
  const patchArea = (areaId: string, patch: Partial<DataModelArea>) =>
    mutate((d) => { const a = d.areas.find((a) => a.id === areaId); if (a) Object.assign(a, patch); return d; });
  const removeArea = (areaId: string) =>
    mutate((d) => { d.areas = d.areas.filter((a) => a.id !== areaId); return d; });
  const areaInUse = (areaId: string) => doc.tables.some((t) => t.area === areaId);
  const patchTableArea = (tableId: string, areaId: string) =>
    mutate((d) => { const t = d.tables.find((t) => t.id === tableId); if (t) t.area = areaId; return d; });

  const patchField = (tableId: string, fi: number, patch: Partial<DataModelField>) =>
    mutate((d) => {
      const t = d.tables.find((t) => t.id === tableId);
      if (t) Object.assign(t.fields[fi], patch);
      return d;
    });
  const moveField = (tableId: string, fi: number, dir: -1 | 1) =>
    mutate((d) => {
      const t = d.tables.find((t) => t.id === tableId);
      if (!t) return d;
      const nj = fi + dir;
      if (nj < 0 || nj >= t.fields.length) return d;
      [t.fields[fi], t.fields[nj]] = [t.fields[nj], t.fields[fi]];
      return d;
    });
  const removeField = (tableId: string, fi: number) =>
    mutate((d) => {
      const t = d.tables.find((t) => t.id === tableId);
      if (t) t.fields.splice(fi, 1);
      return d;
    });
  const addField = (tableId: string) =>
    mutate((d) => {
      const t = d.tables.find((t) => t.id === tableId);
      if (t) t.fields.push({ name: "new_field", type: "TEXT" });
      return d;
    });

  const patchRelation = (ri: number, patch: Partial<DataModelRelation>) =>
    mutate((d) => { Object.assign(d.relations[ri], patch); return d; });
  const removeRelation = (ri: number) =>
    mutate((d) => {
      const rel = d.relations[ri];
      if (rel) {
        const [fromTab, ...fromRest] = rel.from.split(".");
        const fromKey = fromTab.trim().toLowerCase();
        const fieldKey = fromRest.join(".").trim().toLowerCase();
        const t = d.tables.find((t) => t.id.toLowerCase() === fromKey || t.name.toLowerCase() === fromKey);
        const f = t?.fields.find((f) => f.name.toLowerCase() === fieldKey);
        if (f && f.fk === rel.to) f.fk = undefined;
      }
      d.relations.splice(ri, 1);
      setSelectedRelIndex(null);
      return d;
    });

  return (
    <div className="dm-editor">
      <datalist id="dm-field-types">
        {FIELD_TYPES.map((t) => <option key={t} value={t} />)}
      </datalist>

      {stale && (
        <div className="stale-banner">
          <Icon name="triangle-alert" size={15} />
          <span>The document changed on disk (updated in the meantime). Unsaved changes here were left untouched.</span>
          <ConfirmButton label="reload from disk" confirmLabel="you'll lose your changes: confirm" onConfirm={reloadDiscardingChanges} />
        </div>
      )}

      <div className="table-toolbar">
        <button type="button" className="ghost-btn" onClick={addTable}>
          <Icon name="table" size={14} />
          <span>table</span>
        </button>
        <span className="spacer" />
        {error && <span className="error-text">{error}</span>}
        {dirty && !error && <span className="vh-dirty">unsaved changes</span>}
        <button className="mini-btn primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "saving…" : "save"}
        </button>
      </div>

      <div className="dm-canvas-wrap" ref={canvasWrapRef}>
        {!doc.tables.length ? (
          <div className="viewer-empty">No tables in the data model. Use "+ table" to get started.</div>
        ) : (
          <svg
            ref={svgRef}
            className={`er-wrap ${panning ? "panning" : ""}`}
            viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : undefined}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={endPan}
            onPointerLeave={endPan}
          >
            <defs>
              <marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#9a908e" />
              </marker>
            </defs>

            {doc.relations.map((rel, i) => {
              const geo = relGeometry(boxes, rel);
              if (!geo) return null;
              const isSel = selectedRelIndex === i;
              return (
                <g key={i}>
                  <path
                    className="dm-rel-hit"
                    d={geo.path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={10}
                    style={{ cursor: "pointer" }}
                    onPointerDown={(e) => { e.stopPropagation(); setSelectedRelIndex(i); }}
                  />
                  <path
                    d={geo.path}
                    fill="none"
                    stroke={isSel ? ACCENT : IDLE_STROKE}
                    strokeWidth={isSel ? 2.2 : 1.4}
                    markerEnd="url(#er-arrow)"
                    style={{ pointerEvents: "none" }}
                  />
                  {rel.label && (
                    <text x={geo.midX} y={geo.midY - 4} fontSize={10.5} fill="#9a908e" textAnchor="middle" style={{ pointerEvents: "none" }}>
                      {rel.label}{rel.type ? ` (${rel.type})` : ""}
                    </text>
                  )}
                </g>
              );
            })}

            {boxes.map((box) => {
              const isRenaming = renamingId === box.table.id;
              return (
                <g
                  key={box.table.id}
                  className="dm-box"
                  onPointerDown={(e) => onBoxPointerDown(e, box.table.id)}
                >
                  <rect className="dm-box-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={8} fill="#201c17" stroke="#3a332b" />
                  <rect
                    className="dm-box-header"
                    x={box.x} y={box.y} width={box.w} height={HEADER_H} rx={8}
                    fill={areaColor(box.table.area)}
                    onPointerDown={(e) => onHeaderPointerDown(e, box)}
                    onPointerMove={onHeaderPointerMove}
                    onPointerUp={onHeaderPointerUp}
                    onDoubleClick={(e) => startRename(e, box.table)}
                  />
                  <rect x={box.x} y={box.y + HEADER_H - 8} width={box.w} height={8} fill={areaColor(box.table.area)} style={{ pointerEvents: "none" }} />
                  {!isRenaming && (
                    <text x={box.x + 10} y={box.y + HEADER_H / 2 + 4} fontSize={12.5} fontWeight={600} fill="#fff" style={{ pointerEvents: "none" }}>
                      {box.table.name}
                    </text>
                  )}
                  {isRenaming && (
                    <foreignObject x={box.x + 8} y={box.y + 4} width={box.w - 90} height={HEADER_H - 8} onPointerDown={(e) => e.stopPropagation()}>
                      <input
                        className="dm-rename-input"
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                    </foreignObject>
                  )}

                  <foreignObject x={box.x + box.w - 78} y={box.y + 3} width={24} height={24} onPointerDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`dm-area-dot-btn ${tableAreaPickerId === box.table.id ? "active" : ""}`}
                      title="change area"
                      onClick={() => setTableAreaPickerId((cur) => (cur === box.table.id ? null : box.table.id))}
                    >
                      <Icon name="droplet" size={13} />
                    </button>
                  </foreignObject>

                  <foreignObject x={box.x + box.w - 52} y={box.y + 3} width={24} height={24} onPointerDown={(e) => e.stopPropagation()}>
                    <div className="dm-header-trash-wrap">
                      <ConfirmButton
                        className="icon-btn danger"
                        icon="trash-2"
                        iconSize={13}
                        label="delete table"
                        confirmLabel="confirm deletion"
                        onConfirm={() => mutate((d) => { removeTableFromDoc(d, box.table.id); return d; })}
                      />
                    </div>
                  </foreignObject>

                  <foreignObject x={box.x + box.w - 26} y={box.y + 3} width={24} height={24} onPointerDown={(e) => e.stopPropagation()}>
                    <div className="dm-header-anchor">
                      <AnchorButton project={project} file="data_model.json" anchorRef={box.table.name} label={`Table ${box.table.name}`} />
                    </div>
                  </foreignObject>

                  {box.table.fields.map((f, fi) => {
                    const ry = box.y + HEADER_H + fi * ROW_H;
                    const isTarget = !!(dragTarget && dragTarget.tableId === box.table.id && dragTarget.fieldName === f.name);
                    const badgeMode = f.pk ? "pk" : f.fk ? "fk" : "ghost";
                    return (
                      <foreignObject
                        key={f.name + fi}
                        x={box.x} y={ry} width={box.w} height={ROW_H}
                        style={{ overflow: "visible" }}
                        onPointerDown={(e) => { e.stopPropagation(); setSelectedRelIndex(null); }}
                      >
                        <div
                          className={`dm-row ${fi % 2 === 1 ? "dm-row-alt" : ""} ${isTarget ? "dm-row-target" : ""}`}
                          title={f.notes || undefined}
                        >
                          <button
                            type="button"
                            className={`dm-badge dm-badge-${badgeMode}`}
                            title={f.pk ? "primary key — click to remove" : "click to make this the primary key"}
                            onClick={() => patchField(box.table.id, fi, { pk: !f.pk })}
                          >
                            {f.pk ? "PK" : f.fk ? "FK" : "PK"}
                          </button>
                          <input
                            className="cell-input dm-name-input"
                            value={f.name}
                            onChange={(e) => patchField(box.table.id, fi, { name: e.target.value })}
                            placeholder="field name"
                          />
                          <input
                            className="cell-input dm-type-input"
                            list="dm-field-types"
                            value={f.type}
                            onChange={(e) => patchField(box.table.id, fi, { type: e.target.value })}
                            placeholder="type"
                          />
                          <div className="dm-row-actions">
                            <button type="button" className="icon-btn" title="move up" disabled={fi === 0}
                              onClick={() => moveField(box.table.id, fi, -1)}>
                              <Icon name="arrow-up" size={12} />
                            </button>
                            <button type="button" className="icon-btn" title="move down" disabled={fi === box.table.fields.length - 1}
                              onClick={() => moveField(box.table.id, fi, 1)}>
                              <Icon name="arrow-down" size={12} />
                            </button>
                            <ConfirmButton
                              className="icon-btn danger"
                              icon="trash-2"
                              iconSize={12}
                              label="delete field"
                              confirmLabel="confirm"
                              onConfirm={() => removeField(box.table.id, fi)}
                            />
                            <AnchorButton
                              project={project}
                              file="data_model.json"
                              anchorRef={`${box.table.name}.${f.name}`}
                              label={`${box.table.name}.${f.name} (${f.type})`}
                            />
                          </div>
                          <div
                            className="dm-port"
                            title="drag to create a relation"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              const svg = svgRef.current;
                              if (!svg) return;
                              const pt = toSvgPoint(svg, e.clientX, e.clientY);
                              setConnDrag({ fromTableId: box.table.id, fromField: f.name, x: pt.x, y: pt.y });
                              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                            }}
                            onPointerMove={(e) => {
                              if (!connDrag) return;
                              const svg = svgRef.current;
                              if (!svg) return;
                              const pt = toSvgPoint(svg, e.clientX, e.clientY);
                              setConnDrag((cd) => (cd ? { ...cd, x: pt.x, y: pt.y } : cd));
                            }}
                            onPointerUp={() => {
                              if (!connDrag) return;
                              if (dragTarget) {
                                mutate((d) => {
                                  const srcT = d.tables.find((t) => t.id === connDrag.fromTableId);
                                  const srcF = srcT?.fields.find((ff) => ff.name === connDrag.fromField);
                                  if (srcF) srcF.fk = `${dragTarget.tableId}.${dragTarget.fieldName}`;
                                  d.relations.push({
                                    from: `${connDrag.fromTableId}.${connDrag.fromField}`,
                                    to: `${dragTarget.tableId}.${dragTarget.fieldName}`,
                                    type: "N:1",
                                  });
                                  return d;
                                });
                              }
                              setConnDrag(null);
                            }}
                          />
                        </div>
                      </foreignObject>
                    );
                  })}

                  <foreignObject
                    x={box.x} y={box.y + HEADER_H + box.table.fields.length * ROW_H} width={box.w} height={ADD_ROW_H}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <div className="dm-add-field-row" onClick={() => addField(box.table.id)}>
                      <Icon name="plus" size={11} />
                      <span>field</span>
                    </div>
                  </foreignObject>
                </g>
              );
            })}

            {connDrag && (() => {
              const srcBox = findBox(boxes, connDrag.fromTableId);
              if (!srcBox) return null;
              const fi = fieldRowIndex(srcBox, connDrag.fromField);
              const oy = fi >= 0 ? srcBox.y + HEADER_H + fi * ROW_H + ROW_H / 2 : srcBox.y + srcBox.h / 2;
              const ox = srcBox.x + srcBox.w;
              return (
                <path
                  d={`M ${ox} ${oy} L ${connDrag.x} ${connDrag.y}`}
                  stroke={ACCENT}
                  strokeWidth={1.6}
                  strokeDasharray="4 3"
                  fill="none"
                  style={{ pointerEvents: "none" }}
                />
              );
            })()}
          </svg>
        )}

        <div className="er-legend" ref={legendRef}>
          {doc.areas.map((a) => (
            <div className="er-legend-item" key={a.id} onClick={() => setAreaPopoverId(areaPopoverId === a.id ? null : a.id)}>
              <span className="er-legend-dot" style={{ background: a.color }} />
              <span>{a.name}</span>
              {areaPopoverId === a.id && (
                <div className="dm-area-popover" onClick={(e) => e.stopPropagation()}>
                  <label className="muted">name</label>
                  <input value={a.name} onChange={(e) => patchArea(a.id, { name: e.target.value })} />
                  <label className="muted">colour</label>
                  <input type="color" value={a.color} onChange={(e) => patchArea(a.id, { color: e.target.value })} />
                  {areaInUse(a.id) ? (
                    <span className="muted" title="remove this area's tables first">area in use: can't be deleted</span>
                  ) : (
                    <ConfirmButton
                      className="mini-btn danger"
                      label="delete area"
                      confirmLabel="sure?"
                      onConfirm={() => { removeArea(a.id); setAreaPopoverId(null); }}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="er-legend-add" onClick={addArea}>
            <Icon name="plus" size={12} />
            <span>area</span>
          </div>
        </div>

        <div className="er-controls">
          <button className="mini-btn" onClick={zoomBtn(1 / 1.25)}>+</button>
          <button className="mini-btn" onClick={zoomBtn(1.25)}>−</button>
          <button className="mini-btn" onClick={resetView}>reset</button>
        </div>

        {tableAreaPickerId && svgRef.current && canvasWrapRef.current && (() => {
          const box = boxes.find((b) => b.table.id === tableAreaPickerId);
          if (!box) return null;
          const screenPt = toScreenPoint(svgRef.current!, box.x + box.w - 78, box.y + HEADER_H);
          const wrapRect = canvasWrapRef.current!.getBoundingClientRect();
          return (
            <div
              className="dm-area-picker"
              ref={areaPickerRef}
              style={{ left: screenPt.x - wrapRect.left, top: screenPt.y - wrapRect.top }}
            >
              {doc.areas.map((a) => (
                <div
                  key={a.id}
                  className="dm-area-picker-item"
                  onClick={() => { patchTableArea(tableAreaPickerId, a.id); setTableAreaPickerId(null); }}
                >
                  <span className="er-legend-dot" style={{ background: a.color }} />
                  <span>{a.name}</span>
                </div>
              ))}
            </div>
          );
        })()}

        {selectedRelIndex !== null && doc.relations[selectedRelIndex] && svgRef.current && canvasWrapRef.current && (() => {
          const rel = doc.relations[selectedRelIndex];
          const geo = relGeometry(boxes, rel);
          if (!geo) return null;
          const screenPt = toScreenPoint(svgRef.current!, geo.midX, geo.midY);
          const wrapRect = canvasWrapRef.current!.getBoundingClientRect();
          return (
            <div
              className="dm-rel-popover"
              ref={relPopoverRef}
              style={{ left: screenPt.x - wrapRect.left, top: screenPt.y - wrapRect.top }}
            >
              <select value={rel.type} onChange={(e) => patchRelation(selectedRelIndex, { type: e.target.value })}>
                {RELATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input
                value={rel.label ?? ""}
                placeholder="label"
                onChange={(e) => patchRelation(selectedRelIndex, { label: e.target.value || undefined })}
              />
              <ConfirmButton
                className="mini-btn danger"
                label="delete relation"
                confirmLabel="sure?"
                onConfirm={() => removeRelation(selectedRelIndex)}
              />
            </div>
          );
        })()}
      </div>
    </div>
  );
}
