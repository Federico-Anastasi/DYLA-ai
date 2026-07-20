"""Exports mockup.json as a single self-contained, interactive HTML file.

mockup.json builds pages out of the STANDARD component library, themed per project
(see schemas/mockup.schema.json and web/src/mockup-lib/). This module is the Python twin
of the React library (web/src/mockup-lib/components/*.tsx): same markup (mk-* classes),
same theme CSS — read straight from web/src/mockup-lib/themes/{theme}.css, the single
source of truth for styling, never reimplemented here — so the viewer preview and the
HTML export stay identical.

Rendering choices (mirroring MockupView.tsx):
- The global "chrome" (topbar + nav) is taken once, from the first topbar/nav found while
  walking the pages in JSON order, and stays put while the page content swaps via JS.
- The page title is NOT a component: it is automatic chrome derived from page['name'].
  Standard theme: a 'Back' link (from the 'breadcrumb' component, when present) plus a
  centered accent-colored title. Compact theme: title on the left; and if the FIRST
  component of the page (chrome aside) is of type 'actions', it gets hoisted next to the
  title instead of sitting in the page body.
- Navigation, tabs and grid search: one pair of data-* attributes plus a single delegated
  event listener. No inline onclick, no external libraries.
- No emoji: icons are inline Lucide-style SVGs (stroke-based, "currentColor"), the same
  set as web/src/components/icons.tsx.
- No fake browser frame: the mockup fills the body, on the theme's page background.
"""
from __future__ import annotations

import html

from .config import ROOT
from .documents import load_doc
from .exports import DocNotFound

__all__ = ["build_mockup_html"]


# ── inline SVG icons (Lucide style: 24x24, stroke-based, no emoji) — 1:1 mirror of
# web/src/components/icons.tsx ──────────────────────────────────────────────────

_LUCIDE_PATHS = {
    "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    "triangle-alert": ('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>'
                        '<path d="M12 9v4"/><path d="M12 17h.01"/>'),
    "trending-up": '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    "trending-down": '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    "minus": '<path d="M5 12h14"/>',
    "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevrons-left": '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
    "chevrons-right": '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
    "download": ('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
                 '<polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
    "pencil": '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    "eye": ('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 '
            '10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
    "trash-2": ('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'
                '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
                '<line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
    "check": '<polyline points="20 6 9 17 4 12"/>',
    "check-circle": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    "alert-circle": '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12" y1="16" y2="16.01"/>',
    "pause": '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    "bot": ('<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/>'
            '<path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/>'),
    "corner-up-left": '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    "grid-dots": ('<circle cx="5" cy="5" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="19" cy="5" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>'
                  '<circle cx="19" cy="19" r="1.6" fill="currentColor" stroke="none"/>'),
    "star": ('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 '
             '7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    "file-spreadsheet": ('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>'
                         '<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/>'
                         '<path d="M8 17h2"/><path d="M14 17h2"/>'),
    "play": '<polygon points="6 3 20 12 6 21 6 3"/>',
    "flag": '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    "message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    "file-text": ('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>'
                  '<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
    "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
}


def _icon(name: str, size: int = 16) -> str:
    inner = _LUCIDE_PATHS.get(name, "")
    if not inner:
        return ""
    return (f'<svg class="icon-svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
            f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
            f'aria-hidden="true">{inner}</svg>')


def _require_mockup(project: str) -> dict:
    data = load_doc(project, "mockup")
    if data is None:
        raise DocNotFound(f"mockup.json not found for project '{project}'")
    return data


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


# ── theme: the CSS comes from web/src/mockup-lib/themes/{theme}.css, single source of truth ──

_THEME_FILES = {"standard": "standard.css", "compact": "compact.css", "plain": "plain.css"}
_SHELL_CLASS = {"standard": "mk-shell-standard", "compact": "mk-shell-compact", "plain": "mk-shell-plain"}


def _theme_css(theme: str) -> str:
    filename = _THEME_FILES.get(theme, _THEME_FILES["plain"])
    path = ROOT / "web" / "src" / "mockup-lib" / "themes" / filename
    return path.read_text(encoding="utf-8")


def _theme_of(meta: dict) -> str:
    theme = meta.get("theme", "plain")
    return theme if theme in _THEME_FILES else "plain"


def _grid_actions_position(theme: str) -> str:
    """Where the actions column of a grid goes: decided by the THEME, not by the JSON (see
    schemas/mockup.schema.json, c_grid.props.actions). Standard: first column (checkbox and
    icons come before the status column in that layout). Compact: no actions column at all —
    the layout never has one, row navigation goes exclusively through a kind='id-link'
    column. Plain: last column (the historical default). React mirror: gridActionsPosition
    in MockupView.tsx — same function, same result, so the two stay pixel-identical."""
    if theme == "compact":
        return "none"
    if theme == "standard":
        return "start"
    return "end"


# ── chrome: topbar / nav ────────────────────────────────────────────────────

def _initials(name: str) -> str:
    words = [w for w in str(name or "").split() if w]
    return "".join(w[0] for w in words[:2]).upper() or "U"


def _render_topbar(props: dict, theme: str) -> str:
    user = props.get("user") or "Demo User"
    initials = _initials(user)
    # The product name the mockup is meant to suggest. "acme" is the placeholder for a
    # mockup that does not name one — but when it does, showing "acme" to a client who is
    # being presented their own future application is the wrong kind of detail.
    brand = _esc(props.get("title")) or "acme"
    if theme == "compact":
        # The compact theme has no topbar: its equivalent (user + wordmark) lives in the
        # sidebar footer.
        return (f'<div class="mk-sidebar-footer"><span class="mk-avatar">{_esc(initials)}</span>'
                f'<span class="mk-sidebar-user">{_esc(user)}</span>'
                f'<span class="mk-brand-wordmark">{brand}</span></div>')
    title = _esc(props.get("title", ""))
    return (f'<header class="mk-topbar"><div class="mk-topbar-left">{_icon("file-text", 19)}'
            f'<span class="mk-topbar-title">{title}</span></div>'
            f'<div class="mk-topbar-right">{_icon("grid-dots", 18)}'
            f'<span class="mk-avatar">{_esc(initials)}</span>'
            f'<span class="mk-topbar-user">{_esc(user)}</span>'
            f'<span class="mk-brand-wordmark">{brand}</span></div></header>')


def _render_nav(props: dict, theme: str, current_page: str, modal_page_ids: set) -> str:
    items = props.get("items", [])
    cls = "mk-nav mk-nav-sidebar" if theme == "compact" else "mk-nav mk-nav-tabs"
    buttons = []
    for it in items:
        page = it.get("page", "")
        # kind='modal' pages never show up in the nav: they are not directly navigable.
        if page in modal_page_ids:
            continue
        active = " active" if page == current_page else ""
        buttons.append(
            f'<button type="button" class="mk-nav-item{active}" data-goto="{_esc(page)}">'
            f'{_esc(it.get("label", ""))}</button>'
        )
    return f'<nav class="{cls}">{"".join(buttons)}</nav>'


def _sidebar_brand(title: str | None = None) -> str:
    return (f'<div class="mk-sidebar-brand"><span class="mk-brand-mark" aria-hidden="true"></span>'
            f'<span class="mk-brand-word">{_esc(title) if title else "acme"}</span>'
            f'<span class="mk-brand-launcher">{_icon("grid-dots", 16)}</span></div>')


# ── page title (automatic chrome, not a component) ────────────────────────

def _render_back_link(breadcrumb_props: dict | None) -> str:
    if not breadcrumb_props:
        return ""
    items = breadcrumb_props.get("items", [])
    back = items[-2] if len(items) >= 2 else (items[0] if items else None)
    if not back:
        return ""
    return (f'<button type="button" class="mk-back-link" data-goto="{_esc(back.get("page", ""))}">'
            f'{_icon("corner-up-left", 15)}<span>Back</span></button>')


def _render_page_title(name: str, theme: str, breadcrumb_props: dict | None, actions_html: str) -> str:
    title = f'<h1 class="mk-page-title">{_esc(name)}</h1>'
    if theme == "compact":
        actions_wrap = f'<div class="mk-page-title-actions">{actions_html}</div>' if actions_html else ""
        return f'<div class="mk-page-title-row">{title}{actions_wrap}</div>'
    back = _render_back_link(breadcrumb_props)
    return f'<div class="mk-page-title-block">{back}{title}</div>'


# ── individual component renderers (each returns HTML) ─────────────────────

def _render_breadcrumb(props: dict, theme: str) -> str:
    # In the standard theme the trail has already been consumed by _render_page_title as the
    # 'Back' link, so nothing is emitted here to avoid showing it twice.
    if theme == "standard":
        return ""
    items = props.get("items", [])
    parts = []
    for i, it in enumerate(items):
        label = _esc(it.get("label", ""))
        page = it.get("page")
        if i > 0:
            parts.append('<span class="mk-crumb-sep">/</span>')
        if page and i < len(items) - 1:
            parts.append(f'<span class="mk-crumb"><button type="button" class="mk-crumb-link" data-goto="{_esc(page)}">{label}</button></span>')
        else:
            parts.append(f'<span class="mk-crumb"><span class="mk-crumb-current">{label}</span></span>')
    return '<div class="mk-breadcrumb">' + "".join(parts) + '</div>'


_TREND_ICON = {"up": "trending-up", "down": "trending-down", "flat": "minus"}


def _render_kpi_row(props: dict) -> str:
    cards = []
    for c in props.get("cards", []):
        trend = c.get("trend")
        trend_html = ""
        if trend in _TREND_ICON:
            trend_html = f'<span class="mk-kpi-trend mk-trend-{trend}">{_icon(_TREND_ICON[trend], 14)}</span>'
        cards.append(
            f'<div class="mk-kpi-card"><div class="mk-kpi-label">{_esc(c.get("label",""))}</div>'
            f'<div class="mk-kpi-value">{_esc(c.get("value",""))}{trend_html}</div></div>'
        )
    return '<div class="mk-kpi-row">' + "".join(cards) + '</div>'


def _status_icon_for(value: str) -> tuple[str, str] | None:
    """Heuristic for a kind='status' column: mirror of statusIconFor in DataGrid.tsx."""
    v = value.lower()
    import re
    if re.search(r"complet|approv|\bok\b|done", v):
        return ("check-circle", "mk-status-success")
    if re.search(r"waiting|pending|paused|to review", v):
        return ("pause", "mk-status-warning")
    if re.search(r"automat|sent", v):
        return ("bot", "mk-status-info")
    if re.search(r"reject|error|failed|\bko\b", v):
        return ("alert-circle", "mk-status-error")
    return None


def _render_cell(col: dict, row: dict, actions: list) -> str:
    key = col.get("key", "")
    kind = col.get("kind", "text")
    value = row.get(key, "")
    text = _esc(value)
    if kind == "id-link":
        target = actions[0].get("target") if actions else None
        goto = f' data-goto="{_esc(target)}"' if target else ""
        return f'<button type="button" class="mk-cell-link"{goto}>{text}</button>'
    if kind == "chip":
        return f'<span class="mk-cell-chip">{text}</span>'
    if kind == "progress":
        try:
            pct = max(0, min(100, float(value)))
        except (TypeError, ValueError):
            pct = 0
        return (f'<div class="mk-cell-progress" title="{pct:g}%"><div class="mk-cell-progress-track">'
                f'<div class="mk-cell-progress-fill" style="width:{pct:g}%"></div></div></div>')
    if kind == "sla":
        ok = str(value).strip().lower() in ("ok", "true", "yes")
        cls = "mk-sla-ok" if ok else "mk-sla-ko"
        icon = "check-circle" if ok else "alert-circle"
        return f'<span class="mk-cell-sla {cls}">{_icon(icon, 14)}{text}</span>'
    if kind == "status":
        st = _status_icon_for(str(value))
        icon_html = _icon(st[0], 14) if st else ""
        cls = st[1] if st else ""
        return f'<span class="mk-cell-status {cls}">{icon_html}{text}</span>'
    return text


def _render_grid(props: dict, table_id: str, theme: str) -> str:
    title = props.get("title")
    columns = props.get("columns", [])
    rows = props.get("rows", [])
    actions = props.get("actions", [])
    searchable = props.get("searchable", True)
    pagination_label = props.get("paginationLabel")
    position = _grid_actions_position(theme)
    show_actions_col = position != "none" and bool(actions)
    actions_at_start = position == "start"

    out = []
    if title or searchable:
        out.append('<div class="mk-grid-toolbar">')
        if title:
            out.append(f'<div class="mk-grid-title">{_esc(title)}</div>')
        if searchable:
            out.append(
                f'<div class="mk-search-box">{_icon("search", 14)}'
                f'<input type="text" class="mk-grid-search" placeholder="Search..." '
                f'data-search-for="{_esc(table_id)}"></div>'
            )
        out.append('</div>')

    out.append(f'<div class="mk-grid-wrap"><table class="mk-grid-table" id="{_esc(table_id)}"><thead><tr>')
    if actions_at_start and show_actions_col:
        out.append('<th class="mk-col-actions">Actions</th>')
    for col in columns:
        out.append(f'<th>{_esc(col.get("label",""))}</th>')
    if not actions_at_start and show_actions_col:
        out.append('<th class="mk-col-actions">Actions</th>')
    out.append('</tr></thead><tbody>')

    if not rows:
        colspan = len(columns) + (1 if show_actions_col else 0)
        out.append(f'<tr class="mk-empty-row"><td colspan="{colspan}">No items</td></tr>')

    def actions_cell() -> str:
        btns = []
        for a in actions:
            variant = a.get("variant", "button")
            cls = "mk-link-btn" if variant == "link" else "mk-btn mk-btn-small mk-btn-secondary"
            icon_html = _icon(a["icon"], 13) if a.get("icon") else ""
            btns.append(f'<button type="button" class="{cls}" data-goto="{_esc(a.get("target",""))}">{icon_html}{_esc(a.get("label",""))}</button>')
        return f'<td class="mk-col-actions">{"".join(btns)}</td>'

    for row in rows:
        out.append('<tr>')
        if actions_at_start and show_actions_col:
            out.append(actions_cell())
        for col in columns:
            out.append(f'<td>{_render_cell(col, row, actions)}</td>')
        if not actions_at_start and show_actions_col:
            out.append(actions_cell())
        out.append('</tr>')
    out.append('</tbody></table></div>')

    if pagination_label:
        out.append(
            f'<div class="mk-grid-pagination"><span>{_esc(pagination_label)}</span>'
            f'<span class="mk-pagination-nav">{_icon("chevrons-left",14)}{_icon("chevron-left",14)}'
            f'{_icon("chevron-right",14)}{_icon("chevrons-right",14)}</span></div>'
        )

    return '<div class="mk-grid-block">' + "".join(out) + '</div>'


_FIELD_INPUT = {
    "text": lambda f: f'<input type="text" placeholder="{_esc(f.get("placeholder",""))}">',
    "number": lambda f: f'<input type="number" placeholder="{_esc(f.get("placeholder",""))}">',
    "date": lambda f: '<input type="date">',
    "textarea": lambda f: f'<textarea rows="3" placeholder="{_esc(f.get("placeholder",""))}"></textarea>',
}


def _render_form_field(f: dict) -> str:
    ftype = f.get("type", "text")
    label = _esc(f.get("label", ""))
    req = ' <span class="mk-req">*</span>' if f.get("required") else ""
    wide = " mk-form-field-wide" if ftype == "textarea" else ""
    if ftype == "select":
        opts = "".join(f'<option>{_esc(o)}</option>' for o in f.get("options", []))
        control = f'<select><option value="">Select...</option>{opts}</select>'
        return f'<div class="mk-form-field"><label>{label}{req}</label>{control}</div>'
    if ftype == "checkbox":
        return (f'<div class="mk-form-field mk-form-field-checkbox">'
                f'<label><input type="checkbox"> {label}{req}</label></div>')
    control = _FIELD_INPUT.get(ftype, _FIELD_INPUT["text"])(f)
    return f'<div class="mk-form-field{wide}"><label>{label}{req}</label>{control}</div>'


def _render_form(props: dict) -> str:
    title = props.get("title")
    out = []
    if title:
        out.append(f'<div class="mk-card-title">{_esc(title)}</div>')
    out.append('<div class="mk-form-grid">')
    for f in props.get("fields", []):
        out.append(_render_form_field(f))
    out.append('</div>')

    submit_label = _esc(props.get("submit_label") or "Save")
    cancel_label = props.get("cancel_label")
    submit_target = props.get("submit_target")
    out.append('<div class="mk-actions-row mk-form-actions">')
    if cancel_label:
        # data-modal-close: when the form lives inside a dialog, cancel closes it (handled by
        # the delegated JS); on a regular page the attribute simply does nothing.
        out.append(f'<button type="button" class="mk-btn mk-btn-secondary" data-modal-close>{_esc(cancel_label)}</button>')
    goto_attr = f' data-goto="{_esc(submit_target)}"' if submit_target else ""
    out.append(f'<button type="button" class="mk-btn mk-btn-primary"{goto_attr}>{submit_label}</button>')
    out.append('</div>')
    return '<div class="mk-card mk-form-card">' + "".join(out) + '</div>'


def _render_detail(props: dict) -> str:
    # sec['title'] is optional (see schemas/mockup.schema.json): it is left out when the
    # 'detail' sits inside a collapsible 'section' that already shows the title (the
    # standard-theme dialog pattern with 'sidebar-nav'), to avoid a doubled heading.
    out = []
    title = props.get("title")
    if title:
        out.append(f'<div class="mk-card-title mk-detail-title">{_esc(title)}</div>')
    for sec in props.get("sections", []):
        sec_title = sec.get("title")
        title_html = f'<h4>{_esc(sec_title)}</h4>' if sec_title else ""
        out.append(f'<div class="mk-card mk-detail-section">{title_html}<div class="mk-detail-fields">')
        for f in sec.get("fields", []):
            out.append(
                f'<div class="mk-detail-field"><div class="mk-df-label">{_esc(f.get("label",""))}</div>'
                f'<div class="mk-df-value">{_esc(f.get("value",""))}</div></div>'
            )
        out.append('</div></div>')
    return '<div class="mk-detail-block">' + "".join(out) + '</div>'


def _render_button(b: dict) -> str:
    style = b.get("style", "secondary")
    cls = "mk-link-btn" if style == "link" else f"mk-btn mk-btn-{style}"
    icon_html = _icon(b["icon"], 14) if b.get("icon") else ""
    return f'<button type="button" class="{cls}" data-goto="{_esc(b.get("target",""))}">{icon_html}{_esc(b.get("label",""))}</button>'


def _render_actions(props: dict, split_first: bool = False) -> str:
    """split_first: the dialog action-bar pattern of the standard theme (EXIT on the left,
    CANCEL/HOLD/SAVE on the right) — true when the component sits inside a kind='modal' page
    of the standard theme. The caller decides this; it is never a schema prop. React mirror:
    ActionsBar.tsx (splitFirst prop)."""
    buttons = props.get("buttons", [])
    if split_first and len(buttons) > 1:
        first_html = _render_button(buttons[0])
        rest_html = "".join(_render_button(b) for b in buttons[1:])
        return (
            '<div class="mk-actions-row mk-actions-split">'
            f'<div class="mk-actions-split-start">{first_html}</div>'
            f'<div class="mk-actions-split-end">{rest_html}</div>'
            '</div>'
        )
    return '<div class="mk-actions-row">' + "".join(_render_button(b) for b in buttons) + '</div>'


def _render_banner(props: dict) -> str:
    style = props.get("style", "info")
    icon_map = {"info": "info", "success": "check-circle", "warning": "triangle-alert", "error": "alert-circle"}
    title = props.get("title")
    title_html = f'<strong>{_esc(title)}</strong> ' if title else ""
    return (f'<div class="mk-banner mk-banner-{style}"><span class="mk-banner-icon">{_icon(icon_map.get(style,"info"), 17)}</span>'
            f'<span class="mk-banner-body">{title_html}{_esc(props.get("text",""))}</span></div>')


def _render_filters(props: dict, theme: str, filters_id: str) -> str:
    fields = props.get("fields", [])
    search_label = props.get("search_label")
    if theme == "compact":
        search_html = ""
        if search_label:
            search_html = (f'<div class="mk-filters-search"><input type="text" class="mk-filters-search-input" '
                            f'placeholder="{_esc(search_label)}">'
                            f'<button type="button" class="mk-btn mk-btn-action mk-btn-small">Search</button></div>')
        chips = "".join(
            f'<div class="mk-filter-chip"><span class="mk-filter-chip-label">{_esc(f.get("label",""))}</span>'
            f'<span class="mk-filter-chip-value">{_esc(f.get("value",""))}</span>{_icon("chevron-down",13)}</div>'
            for f in fields
        )
        return f'<div class="mk-filters mk-filters-compact">{search_html}<div class="mk-filter-chips">{chips}</div></div>'

    collapsible = props.get("collapsible", True)
    open_by_default = not collapsible
    open_cls = " mk-filters-open" if open_by_default else ""
    body_style = "" if open_by_default else ' style="display:none"'
    fields_html = "".join(
        f'<div class="mk-filter-field"><label>{_esc(f.get("label",""))}</label>'
        f'<div class="mk-filter-value">{_esc(f.get("value",""))}</div></div>'
        for f in fields
    )
    return (
        f'<div class="mk-filters mk-filters-standard{open_cls}" data-filters-id="{_esc(filters_id)}">'
        f'<button type="button" class="mk-filters-toggle" data-filters-toggle="{_esc(filters_id)}">'
        f'<span class="mk-chevron">{_icon("chevron-down",14)}</span>{_icon("search",15)}<span>Filters</span></button>'
        f'<div class="mk-filters-body" data-filters-body="{_esc(filters_id)}"{body_style}>{fields_html}</div></div>'
    )


def _render_legend(props: dict) -> str:
    title = props.get("title")
    title_html = f'<span class="mk-legend-title">{_esc(title)}</span>' if title else ""
    items = "".join(
        f'<span class="mk-legend-item"><span class="mk-legend-dot mk-legend-{_esc(it.get("color","grey"))}">'
        f'{_icon("star",13)}</span><span>{_esc(it.get("label",""))}</span></span>'
        for it in props.get("items", [])
    )
    return f'<div class="mk-legend">{title_html}{items}</div>'


def _render_statusbar(props: dict) -> str:
    tone = props.get("tone", "success")
    default_icon = {"info": "info", "success": "check", "warning": "triangle-alert", "error": "alert-circle"}
    icon_name = props.get("icon") or default_icon.get(tone, "check")
    return f'<div class="mk-statusbar mk-statusbar-{tone}">{_icon(icon_name, 17)}<span>{_esc(props.get("label",""))}</span></div>'


def _render_wizard_steps(props: dict) -> str:
    steps = props.get("steps", [])
    current = props.get("current", 1)
    orientation = props.get("orientation") or ("horizontal" if len(steps) <= 7 else "vertical")
    parts = []
    for i, label in enumerate(steps):
        n = i + 1
        state = "done" if n < current else ("active" if n == current else "todo")
        circle = _icon("check", 16) if state == "done" else str(n)
        connector = '<span class="mk-wizard-connector"></span>' if i < len(steps) - 1 else ""
        parts.append(
            f'<div class="mk-wizard-step mk-wizard-step-{state}"><span class="mk-wizard-circle">{circle}</span>'
            f'<span class="mk-wizard-label">{_esc(label)}</span>{connector}</div>'
        )
    return f'<div class="mk-wizard mk-wizard-{orientation}">{"".join(parts)}</div>'


def _render_state_progress(props: dict) -> str:
    states = props.get("states", [])
    current = props.get("current", 1)
    title = _esc(props.get("title") or "Status")
    parts = []
    for i, s in enumerate(states):
        n = i + 1
        state = "done" if n < current else ("active" if n == current else "todo")
        circle = _icon("check", 14) if state == "done" else str(n)
        date = s.get("date")
        date_html = f'<span class="mk-progress-timestamp">{_esc(date)}</span>' if date else ""
        connector = '<span class="mk-progress-connector"></span>' if i < len(states) - 1 else ""
        parts.append(
            f'<div class="mk-progress-step mk-progress-step-{state}"><span class="mk-progress-circle">{circle}</span>'
            f'<span class="mk-progress-text"><span class="mk-progress-label">{_esc(s.get("label",""))}</span>{date_html}</span>'
            f'{connector}</div>'
        )
    return f'<div class="mk-state-progress"><div class="mk-state-progress-title">{title}</div>{"".join(parts)}</div>'


def _render_segmented(props: dict) -> str:
    options = props.get("options", [])
    active = props.get("active", 0)
    items = []
    for i, o in enumerate(options):
        cls = "mk-segmented-item active" if i == active else "mk-segmented-item"
        goto = f' data-goto="{_esc(o.get("target",""))}"' if o.get("target") else ""
        items.append(f'<button type="button" class="{cls}"{goto}>{_esc(o.get("label",""))}</button>')
    return f'<div class="mk-segmented">{"".join(items)}</div>'


def _render_tiles(props: dict) -> str:
    items = []
    for it in props.get("items", []):
        icon_name = it.get("icon") or "flag"
        link_label = _esc(it.get("link_label") or "View all")
        items.append(
            f'<div class="mk-tile"><span class="mk-tile-icon">{_icon(icon_name, 22)}</span>'
            f'<div class="mk-tile-label">{_esc(it.get("label",""))}</div>'
            f'<button type="button" class="mk-tile-link" data-goto="{_esc(it.get("target",""))}">{link_label}</button></div>'
        )
    return f'<div class="mk-tiles">{"".join(items)}</div>'


def _render_tabs(props: dict, group_id: str, page_id: str, render_children) -> str:
    tabs = props.get("tabs", [])
    btns, panels = [], []
    for i, t in enumerate(tabs):
        active = " active" if i == 0 else ""
        btns.append(
            f'<button type="button" class="mk-tab-btn{active}" data-tab-btn="1" '
            f'data-tab-group="{_esc(group_id)}" data-tab-index="{i}">{_esc(t.get("label",""))}</button>'
        )
        style = "" if i == 0 else ' style="display:none"'
        body = render_children(t.get("components", []), page_id)
        panels.append(f'<div class="mk-tab-panel" data-tab-group="{_esc(group_id)}" data-tab-panel="{i}"{style}>{body}</div>')
    return (f'<div class="mk-tabs-block"><div class="mk-tabs-bar">{"".join(btns)}</div>'
            f'<div class="mk-tabs-body">{"".join(panels)}</div></div>')


def _render_section(props: dict, page_id: str, render_children, section_id: str) -> str:
    # 'collapsible' (the standard-theme dialog pattern, e.g. Recipient / Checks / Applicant /
    # General): clickable title with a chevron, body shown/hidden by the delegated JS (see
    # _build_js, data-section-toggle). React mirror: Section.tsx (collapsible prop, same
    # "expanded" initial state).
    title = props.get("title")
    icon = props.get("icon")
    collapsible = bool(props.get("collapsible")) and bool(title)
    title_html = ""
    if title:
        icon_html = _icon(icon, 16) if icon else ""
        if collapsible:
            chevron_html = f'<span class="mk-chevron mk-chevron-open">{_icon("chevron-down", 14)}</span>'
            title_html = (
                f'<div class="mk-section-title mk-section-title-toggle" data-section-toggle="{_esc(section_id)}">'
                f'{chevron_html}{icon_html}<span>{_esc(title)}</span></div>'
            )
        else:
            title_html = f'<div class="mk-section-title">{icon_html}<span>{_esc(title)}</span></div>'
    body = render_children(props.get("components", []), page_id)
    return (
        f'<div class="mk-card mk-section">{title_html}'
        f'<div class="mk-section-body" data-section-body="{_esc(section_id)}">{body}</div></div>'
    )


def _render_sidebar_nav(props: dict, group_id: str, page_id: str, render_children) -> str:
    """Vertical menu for navigating between the sections of a standard-theme dialog (schema
    type 'sidebar-nav'). React mirror: SidebarNav.tsx — same structure (menu plus fixed info
    and alert blocks, body swapping with the selected section), and the same delegated JS as
    'tabs' drives the toggle (see _build_js)."""
    title = _esc(props.get("title", ""))
    sections = props.get("sections", [])
    info = props.get("info")
    alerts = props.get("alerts")

    menu_btns = []
    panels = []
    for i, s in enumerate(sections):
        active = " active" if i == 0 else ""
        menu_btns.append(
            f'<button type="button" class="mk-sidenav-item{active}" data-tab-btn="1" '
            f'data-tab-group="{_esc(group_id)}" data-tab-index="{i}">{_esc(s.get("label",""))}</button>'
        )
        style = "" if i == 0 else ' style="display:none"'
        body = render_children(s.get("components", []), page_id)
        panels.append(f'<div class="mk-tab-panel" data-tab-group="{_esc(group_id)}" data-tab-panel="{i}"{style}>{body}</div>')

    info_html = ""
    if info:
        info_title = _esc(info.get("title") or "Information")
        fields_html = "".join(
            f'<div class="mk-sidenav-info-field"><span class="mk-sidenav-info-label">{_esc(f.get("label",""))}</span>'
            f'<span class="mk-sidenav-info-value">{_esc(f.get("value",""))}</span></div>'
            for f in info.get("fields", [])
        )
        info_html = (
            f'<div class="mk-sidenav-info"><div class="mk-sidenav-info-title">{_icon("info", 14)}'
            f'<span>{info_title}</span></div>{fields_html}</div>'
        )

    alerts_html = ""
    if alerts:
        alerts_title = _esc(alerts.get("title") or "Alerts")
        items_html = "".join(f'<div class="mk-sidenav-alert-item">{_esc(a)}</div>' for a in alerts.get("items", []))
        alerts_html = f'<div class="mk-sidenav-alerts"><div class="mk-sidenav-alerts-title">{alerts_title}</div>{items_html}</div>'

    return (
        '<div class="mk-sidenav-block"><aside class="mk-sidenav-menu">'
        f'<div class="mk-sidenav-title">{title}</div>'
        f'<nav class="mk-sidenav-items">{"".join(menu_btns)}</nav>'
        f'{info_html}{alerts_html}</aside>'
        f'<div class="mk-sidenav-body">{"".join(panels)}</div></div>'
    )


# ── page component dispatch (topbar/nav excluded: they are global chrome) ──

def _render_component(comp: dict, page_id: str, theme: str, comp_counter: list, in_modal: bool = False) -> str:
    ctype = comp.get("type")
    props = comp.get("props", {})
    comp_id = comp.get("id", f"c{len(comp_counter)}")
    comp_counter.append(1)

    if ctype == "breadcrumb":
        return _render_breadcrumb(props, theme)
    if ctype == "kpi-row":
        return _render_kpi_row(props)
    if ctype == "grid":
        return _render_grid(props, f"grid-{page_id}-{comp_id}", theme)
    if ctype == "form":
        return _render_form(props)
    if ctype == "detail":
        return _render_detail(props)
    if ctype == "actions":
        # Standard theme: inside a dialog the first button is pulled out to the left (the
        # EXIT + rest-on-the-right pattern) — see schemas/mockup.schema.json c_actions and
        # _render_actions.
        return _render_actions(props, split_first=(theme == "standard" and in_modal))
    if ctype == "banner":
        return _render_banner(props)
    if ctype == "filters":
        return _render_filters(props, theme, f"filters-{page_id}-{comp_id}")
    if ctype == "legend":
        return _render_legend(props)
    if ctype == "statusbar":
        return _render_statusbar(props)
    if ctype == "wizard-steps":
        return _render_wizard_steps(props)
    if ctype == "state-progress":
        return _render_state_progress(props)
    if ctype == "segmented":
        return _render_segmented(props)
    if ctype == "tiles":
        return _render_tiles(props)

    def render_children(children, pid):
        return "".join(_render_component(c, pid, theme, comp_counter, in_modal) for c in children)

    if ctype == "tabs":
        group_id = f"tabs-{page_id}-{comp_id}"
        return _render_tabs(props, group_id, page_id, render_children)
    if ctype == "section":
        return _render_section(props, page_id, render_children, f"section-{page_id}-{comp_id}")
    if ctype == "sidebar-nav":
        group_id = f"sidenav-{page_id}-{comp_id}"
        return _render_sidebar_nav(props, group_id, page_id, render_children)
    return ""  # topbar/nav are handled as global chrome, no other type exists (schema-validated)


# ── full document ────────────────────────────────────────────────────────

def _render_modal(page: dict, theme: str) -> str:
    """A kind='modal' page: an overlaid dialog (overlay + card), hidden by default
    ([hidden]). The JS shows and hides it when a target points at it (see _build_js)."""
    comp_counter: list = []
    body_components = [c for c in page["components"] if c["type"] not in ("topbar", "nav")]
    body = "".join(_render_component(c, page["id"], theme, comp_counter, in_modal=True) for c in body_components)
    return (
        f'<div class="mk-modal-overlay" data-modal="{_esc(page["id"])}" hidden>'
        f'<div class="mk-modal-card">'
        f'<div class="mk-modal-header"><h2 class="mk-modal-title">{_esc(page["name"])}</h2>'
        f'<button type="button" class="mk-modal-close" data-modal-close aria-label="Close">{_icon("x", 18)}</button></div>'
        f'<div class="mk-modal-body">{body}</div>'
        f'</div></div>'
    )


def build_mockup_html(project: str) -> str:
    data = _require_mockup(project)
    meta = data["meta"]
    theme = _theme_of(meta)
    pages = data["pages"]

    # kind='modal' pages: dialogs, never in the nav and never directly navigable (see
    # schemas/mockup.schema.json). Everything else (no kind, or 'page') is a normal page.
    modal_page_ids = {p["id"] for p in pages if p.get("kind") == "modal"}
    navigable_pages = [p for p in pages if p["id"] not in modal_page_ids]
    modal_pages = [p for p in pages if p["id"] in modal_page_ids]
    first_page_id = navigable_pages[0]["id"] if navigable_pages else pages[0]["id"]

    # Global chrome: the first topbar/nav found while walking the pages in order.
    topbar_comp = None
    nav_comp = None
    for p in pages:
        for c in p["components"]:
            if c["type"] == "topbar" and topbar_comp is None:
                topbar_comp = c
            if c["type"] == "nav" and nav_comp is None:
                nav_comp = c
        if topbar_comp and nav_comp:
            break

    topbar_html = _render_topbar(topbar_comp["props"], theme) if topbar_comp else ""
    nav_html = _render_nav(nav_comp["props"], theme, first_page_id, modal_page_ids) if nav_comp else ""
    # Standard/plain: the nav goes INSIDE each page, right under the title — it is no longer
    # standalone chrome attached to the topbar. See web/src/mockup-lib/components/AppShell.tsx.
    nav_in_page_html = nav_html if theme != "compact" else ""

    # Body of every NAVIGABLE page: automatic title + nav (unless compact) + components
    # (minus topbar/nav, which are global chrome).
    page_sections = []
    for i, page in enumerate(navigable_pages):
        comp_counter: list = []
        body_components = [c for c in page["components"] if c["type"] not in ("topbar", "nav")]

        breadcrumb_props = next((c["props"] for c in body_components if c["type"] == "breadcrumb"), None)

        hoisted_actions_html = ""
        if theme == "compact" and body_components and body_components[0]["type"] == "actions":
            hoisted_actions_html = _render_actions(body_components[0]["props"])
            body_components = body_components[1:]

        # Compact theme: when the body (after hoisting) starts with 'state-progress', we pull
        # it out — together with a 'section' immediately after it, if there is one (a
        # "Messages" card, say) — into a narrow left column; everything else goes into the
        # wide right column. That is the compact record view pattern (status plus a secondary
        # card on the left, sections and grids on the right). It happens automatically, driven
        # by the ORDER of the components: no dedicated schema prop. React mirror:
        # MockupView.tsx (same rule, same two conditions).
        side_components: list = []
        if theme == "compact" and body_components and body_components[0]["type"] == "state-progress":
            side_components = [body_components[0]]
            rest = body_components[1:]
            if rest and rest[0]["type"] == "section":
                side_components.append(rest[0])
                rest = rest[1:]
            body_components = rest

        title_html = _render_page_title(page["name"], theme, breadcrumb_props, hoisted_actions_html)
        if side_components:
            side_html = "".join(_render_component(c, page["id"], theme, comp_counter) for c in side_components)
            main_html = "".join(_render_component(c, page["id"], theme, comp_counter) for c in body_components)
            body = (
                '<div class="mk-record-view-cols">'
                f'<aside class="mk-record-view-side">{side_html}</aside>'
                f'<div class="mk-record-view-main">{main_html}</div>'
                '</div>'
            )
        else:
            body = "".join(_render_component(c, page["id"], theme, comp_counter) for c in body_components)
        style = "" if i == 0 else ' style="display:none"'
        page_sections.append(
            f'<section class="mk-page-body" data-page="{_esc(page["id"])}"{style}>'
            f'<div class="mk-page-inner">{title_html}{nav_in_page_html}{body}</div></section>'
        )

    modal_html = "".join(_render_modal(p, theme) for p in modal_pages)

    css = _theme_css(theme)
    js = _build_js()
    shell_class = _SHELL_CLASS[theme]

    if theme == "compact":
        shell = f"""
<div class="mk-shell {shell_class}">
  <div class="mk-shell-row">
    <aside class="mk-sidebar">{_sidebar_brand(topbar_comp["props"].get("title") if topbar_comp else None)}{nav_html}{topbar_html}</aside>
    <main class="mk-main">{"".join(page_sections)}</main>
  </div>
  {modal_html}
</div>"""
    else:
        shell = f"""
<div class="mk-shell {shell_class}">
  {topbar_html}
  <main class="mk-main">{"".join(page_sections)}</main>
  {modal_html}
</div>"""

    title = _esc(meta.get("title", "Mockup"))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — Mockup</title>
<style>
html, body {{ height: 100%; margin: 0; }}
{css}
</style>
</head>
<body>
{shell}
<script>{js}</script>
</body>
</html>"""


# ── navigation JS (delegated events, no external libraries) ────────────────

def _build_js() -> str:
    return """
function showPage(id) {
  document.querySelectorAll('.mk-page-body').forEach(function (el) {
    el.style.display = (el.getAttribute('data-page') === id) ? '' : 'none';
  });
  document.querySelectorAll('.mk-nav-item[data-goto]').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-goto') === id);
  });
  window.scrollTo(0, 0);
}
function closeAllModals() {
  document.querySelectorAll('.mk-modal-overlay').forEach(function (m) { m.hidden = true; });
}
function openModal(id) {
  var el = document.querySelector('.mk-modal-overlay[data-modal="' + id + '"]');
  if (el) { el.hidden = false; }
  return !!el;
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeAllModals(); }
});
document.addEventListener('click', function (e) {
  var modalClose = e.target.closest('[data-modal-close]');
  if (modalClose) {
    var overlay = modalClose.closest('.mk-modal-overlay');
    if (overlay) { overlay.hidden = true; }
    return;
  }
  if (e.target.classList && e.target.classList.contains('mk-modal-overlay')) {
    e.target.hidden = true;
    return;
  }
  var goto = e.target.closest('[data-goto]');
  if (goto) {
    var target = goto.getAttribute('data-goto');
    if (target) {
      // If the target is a kind='modal' page, open the dialog. Otherwise close whatever
      // dialog may be open (even when the button lives inside that dialog) and navigate.
      if (!openModal(target)) {
        closeAllModals();
        showPage(target);
      }
    }
    return;
  }
  var tabBtn = e.target.closest('[data-tab-btn]');
  if (tabBtn) {
    var group = tabBtn.getAttribute('data-tab-group');
    var idx = tabBtn.getAttribute('data-tab-index');
    document.querySelectorAll('[data-tab-group="' + group + '"][data-tab-btn]').forEach(function (b) {
      b.classList.toggle('active', b === tabBtn);
    });
    document.querySelectorAll('[data-tab-group="' + group + '"][data-tab-panel]').forEach(function (p) {
      p.style.display = (p.getAttribute('data-tab-panel') === idx) ? '' : 'none';
    });
    return;
  }
  var filtersToggle = e.target.closest('[data-filters-toggle]');
  if (filtersToggle) {
    var fid = filtersToggle.getAttribute('data-filters-toggle');
    var body = document.querySelector('[data-filters-body="' + fid + '"]');
    var wrap = filtersToggle.closest('.mk-filters');
    if (body) {
      var isOpen = wrap.classList.toggle('mk-filters-open');
      body.style.display = isOpen ? '' : 'none';
    }
    return;
  }
  var sectionToggle = e.target.closest('[data-section-toggle]');
  if (sectionToggle) {
    var sid = sectionToggle.getAttribute('data-section-toggle');
    var sbody = document.querySelector('[data-section-body="' + sid + '"]');
    if (sbody) {
      var isSectionOpen = sbody.style.display !== 'none';
      sbody.style.display = isSectionOpen ? 'none' : '';
      sectionToggle.querySelector('.mk-chevron').classList.toggle('mk-chevron-open', !isSectionOpen);
    }
  }
});
document.querySelectorAll('[data-search-for]').forEach(function (inp) {
  inp.addEventListener('input', function () {
    var table = document.getElementById(inp.getAttribute('data-search-for'));
    if (!table) { return; }
    var q = inp.value.trim().toLowerCase();
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      if (tr.classList.contains('mk-empty-row')) { return; }
      var txt = tr.textContent.toLowerCase();
      tr.style.display = (!q || txt.indexOf(q) !== -1) ? '' : 'none';
    });
  });
});
"""
