"""Tests for the per-theme structural rules of the mockup library and for the
'sidebar-nav' component (a dialog with a vertical menu).

Run with `python -m pytest server/tests`.

The rules covered here have a 1:1 React mirror (see web/src/lib/mockupTheme.ts and
web/src/mockup-lib/components/SidebarNav.tsx, Section.tsx, ActionsBar.tsx,
DetailView.tsx) — these tests only check the Python side (server/mockup_export.py); the
React side has its own tests in web/src/lib/mockupTheme.test.ts and mockupLabels.test.ts.
"""
import json
from pathlib import Path

import jsonschema
import pytest

from server import mockup_export
from server.mockup_export import _grid_actions_position, build_mockup_html

SCHEMA = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "schemas" / "mockup.schema.json")
    .read_text(encoding="utf-8")
)


def _validate(doc: dict) -> None:
    jsonschema.validate(instance=doc, schema=SCHEMA)


def _meta(theme: str) -> dict:
    return {"project": "t", "title": "Test", "theme": theme, "date": "2026-07-19"}


def _grid_doc(theme: str, actions: list | None = None, columns=None, extra_pages=None) -> dict:
    """Minimal valid document with a 'list' page holding a grid, for the given theme."""
    grid_props = {
        "columns": columns or [{"key": "id", "label": "ID"}, {"key": "name", "label": "Name"}],
        "rows": [{"id": "1", "name": "Booking One"}],
    }
    if actions is not None:
        grid_props["actions"] = actions
    pages = [
        {
            "id": "list",
            "name": "List",
            "components": [
                {"id": "grid1", "type": "grid", "props": grid_props},
            ],
        }
    ]
    if extra_pages:
        pages.extend(extra_pages)
    return {"meta": _meta(theme), "pages": pages}


@pytest.fixture
def patch_doc(monkeypatch):
    """Makes load_doc('t', 'mockup') resolve to the given document, without touching the
    filesystem."""

    def _patch(doc: dict):
        monkeypatch.setattr(mockup_export, "load_doc",
                            lambda project, name: doc if project == "t" else None)

    return _patch


# --- component ids have no schema pattern (unlike page ids) and must be escaped -----

def test_component_ids_with_a_quote_do_not_break_out_of_html_attributes(patch_doc):
    """Page ids are constrained by the schema to lowercase-digits-hyphens, but component
    ids are a plain string with no pattern — one containing a quote used to break out of
    whatever data-* attribute or id="..." it was written into (grid's table_id/
    data-search-for, tabs'/sidebar-nav's data-tab-group, section's data-section-toggle/
    data-section-body, filters' data-filters-*)."""
    evil = 'x" onmouseover="alert(1)'
    doc = {
        "meta": _meta("plain"),
        "pages": [{
            "id": "list", "name": "List",
            "components": [
                {"id": evil, "type": "grid",
                 "props": {"columns": [{"key": "id", "label": "ID"}],
                           "rows": [{"id": "1"}], "searchable": True}},
                {"id": evil, "type": "filters",
                 "props": {"fields": [{"label": "Status", "value": "Any"}]}},
                {"id": evil, "type": "tabs",
                 "props": {"tabs": [{"label": "A", "components": []}]}},
                {"id": evil, "type": "section",
                 "props": {"title": "S", "collapsible": True, "components": []}},
            ],
        }],
    }
    _validate(doc)
    patch_doc(doc)
    html = build_mockup_html("t")
    assert 'onmouseover="alert(1)"' not in html
    assert "&quot;" in html


# --- position of the actions column, decided by the theme ---------------------

def test_the_actions_column_position_comes_from_the_theme():
    assert _grid_actions_position("standard") == "start"
    assert _grid_actions_position("compact") == "none"
    assert _grid_actions_position("plain") == "end"


def test_standard_theme_puts_the_actions_column_first(patch_doc):
    doc = _grid_doc("standard", actions=[{"label": "View", "target": "d1", "icon": "eye"}])
    full = {**doc, "pages": doc["pages"] + [{"id": "d1", "name": "D", "kind": "modal",
                                             "components": []}]}
    _validate(full)
    patch_doc(full)
    html = build_mockup_html("t")
    thead = html.split("<thead>")[1].split("</thead>")[0]
    # the actions column (th class mk-col-actions) comes before the first data column
    assert thead.index('class="mk-col-actions"') < thead.index(">ID<")
    assert 'data-goto="d1"' in html


def test_compact_theme_has_no_actions_column(patch_doc):
    doc = _grid_doc(
        "compact",
        actions=[{"label": "Open", "target": "d1"}],
        columns=[{"key": "id", "label": "ID", "kind": "id-link"},
                 {"key": "name", "label": "Name"}],
    )
    pages = doc["pages"] + [{"id": "d1", "name": "D", "components": []}]
    full = {**doc, "pages": pages}
    _validate(full)
    patch_doc(full)
    html = build_mockup_html("t")
    # We look for the USE of the class attribute (not the mere presence of the CSS rule,
    # which is in the included <style> anyway): no <th>/<td> may carry mk-col-actions.
    assert 'class="mk-col-actions"' not in html
    # the id-link still uses actions[0].target as the click destination
    assert 'class="mk-cell-link"' in html
    assert 'data-goto="d1"' in html


def test_plain_theme_puts_the_actions_column_last(patch_doc):
    doc = _grid_doc("plain", actions=[{"label": "Open", "target": "d1"}])
    pages = doc["pages"] + [{"id": "d1", "name": "D", "components": []}]
    full = {**doc, "pages": pages}
    _validate(full)
    patch_doc(full)
    html = build_mockup_html("t")
    thead = html.split("<thead>")[1].split("</thead>")[0]
    assert thead.index(">ID<") < thead.index('class="mk-col-actions"')


# --- binding rule: grid.actions[].target should be a kind='modal' page --------

def test_the_schema_does_not_force_kind_modal_but_the_rule_is_documented():
    # The schema does not force kind='modal' on grid.actions[].target (that semantic check
    # is left to the skill/agent, like other structural rules in this project): we only
    # check that a target pointing at a plain 'page' stays JSON-valid — the rule is a
    # modelling constraint, not a schema one.
    doc = _grid_doc("standard", actions=[{"label": "Open", "target": "d1"}])
    pages = doc["pages"] + [{"id": "d1", "name": "D", "components": []}]  # no kind = "page"
    _validate({**doc, "pages": pages})


# --- collapsible section ------------------------------------------------------

def _section_doc(components: list) -> dict:
    return {
        "meta": _meta("standard"),
        "pages": [
            {"id": "d1", "name": "Detail", "kind": "modal", "components": components}
        ],
    }


_COLLAPSIBLE_SECTION = {
    "id": "sec1",
    "type": "section",
    "props": {
        "title": "Organiser",
        "collapsible": True,
        "components": [
            {"id": "det1", "type": "detail",
             "props": {"sections": [{"fields": [{"label": "Name", "value": "Mario"}]}]}}
        ],
    },
}


def test_a_collapsible_section_is_schema_valid():
    _validate(_section_doc([_COLLAPSIBLE_SECTION]))


def test_a_collapsible_section_renders_a_toggle(patch_doc):
    doc = _section_doc([
        _COLLAPSIBLE_SECTION,
        {"id": "sec2", "type": "section",
         "props": {"title": "Not Collapsible", "components": []}},
    ])
    patch_doc(doc)
    html = build_mockup_html("t")
    assert 'data-section-toggle="section-d1-sec1"' in html
    assert 'class="mk-section-title mk-section-title-toggle"' in html
    # the non-collapsible section has no data-section-toggle
    assert html.count("data-section-toggle=") == 1


# --- detail: sections[].title is optional -------------------------------------

_DETAIL_NO_TITLE = {
    "id": "det1", "type": "detail",
    "props": {"sections": [{"fields": [{"label": "Name", "value": "Mario"}]}]},
}


def test_a_detail_section_without_a_title_is_schema_valid():
    doc = {
        "meta": _meta("standard"),
        "pages": [{"id": "d1", "name": "Detail", "components": [_DETAIL_NO_TITLE]}],
    }
    _validate(doc)


def test_a_detail_section_without_a_title_renders_no_h4(patch_doc):
    doc = {
        "meta": _meta("standard"),
        "pages": [{"id": "d1", "name": "Detail", "components": [_DETAIL_NO_TITLE]}],
    }
    patch_doc(doc)
    html = build_mockup_html("t")
    assert "<h4>" not in html


# --- split action bar (standard-theme dialog: first button left, rest right) ---

def _actions_doc(theme: str, page_kind: dict, buttons: list) -> dict:
    return {
        "meta": _meta(theme),
        "pages": [
            {"id": "list", "name": "List", "components": []},
            {
                "id": "d1", "name": "Detail", **page_kind,
                "components": [
                    {"id": "act1", "type": "actions", "props": {"buttons": buttons}}
                ],
            },
        ],
    }


def test_actions_split_only_in_a_standard_theme_dialog(patch_doc):
    doc = _actions_doc("standard", {"kind": "modal"}, [
        {"label": "Exit", "style": "secondary", "target": "list"},
        {"label": "Save", "style": "primary", "target": "list"},
    ])
    _validate(doc)
    patch_doc(doc)
    html = build_mockup_html("t")
    assert 'class="mk-actions-row mk-actions-split"' in html
    start = html.split('class="mk-actions-split-start"')[1].split("</div>")[0]
    assert "Exit" in start
    assert "Save" not in start


def test_no_split_on_a_normal_standard_page(patch_doc):
    doc = {
        "meta": _meta("standard"),
        "pages": [
            {
                "id": "list", "name": "List",
                "components": [
                    {"id": "act1", "type": "actions",
                     "props": {"buttons": [{"label": "One", "target": "list"},
                                           {"label": "Two", "target": "list"}]}}
                ],
            }
        ],
    }
    patch_doc(doc)
    html = build_mockup_html("t")
    assert 'class="mk-actions-row mk-actions-split"' not in html


def test_no_split_in_the_compact_theme(patch_doc):
    doc = _actions_doc("compact", {"kind": "modal"}, [
        {"label": "Cancel", "target": "list"},
        {"label": "Confirm", "target": "list"},
    ])
    patch_doc(doc)
    html = build_mockup_html("t")
    assert 'class="mk-actions-row mk-actions-split"' not in html


# --- sidebar-nav: schema and rendering ----------------------------------------

def _sidebar_nav_doc(extra_props: dict | None = None) -> dict:
    props = {
        "title": "BOOKING: 1801",
        "sections": [
            {"label": "Summary", "components": [
                {"id": "det1", "type": "detail",
                 "props": {"sections": [{"fields": [{"label": "Name", "value": "Mario"}]}]}}
            ]},
            {"label": "Attachments", "components": [
                {"id": "grid1", "type": "grid",
                 "props": {"columns": [{"key": "f", "label": "File"}], "rows": []}}
            ]},
        ],
        "info": {"title": "Info", "fields": [{"label": "Reference", "value": "12345"}]},
        "alerts": {"title": "Alerts", "items": ["Sync | Integration error"]},
    }
    if extra_props:
        props.update(extra_props)
    return {
        "meta": _meta("standard"),
        "pages": [
            {
                "id": "d1", "name": "Detail", "kind": "modal",
                "components": [{"id": "snav1", "type": "sidebar-nav", "props": props}],
            }
        ],
    }


def test_sidebar_nav_is_schema_valid():
    _validate(_sidebar_nav_doc())


def test_sidebar_nav_requires_title_and_sections():
    doc = _sidebar_nav_doc()
    del doc["pages"][0]["components"][0]["props"]["title"]
    with pytest.raises(jsonschema.ValidationError):
        _validate(doc)

    doc2 = _sidebar_nav_doc()
    del doc2["pages"][0]["components"][0]["props"]["sections"]
    with pytest.raises(jsonschema.ValidationError):
        _validate(doc2)


def test_sidebar_nav_rejects_types_not_allowed_in_a_nested_component():
    # 'tabs' is not allowed inside nestedComponent (consistent with the other nested
    # sections, e.g. inside 'tabs'/'section') — see schemas/mockup.schema.json
    # $defs.nestedComponent.
    doc = _sidebar_nav_doc()
    doc["pages"][0]["components"][0]["props"]["sections"][0]["components"] = [
        {"id": "bad", "type": "tabs", "props": {"tabs": []}}
    ]
    with pytest.raises(jsonschema.ValidationError):
        _validate(doc)


def test_sidebar_nav_renders_menu_info_alerts_and_activates_the_first_section(patch_doc):
    doc = _sidebar_nav_doc()
    patch_doc(doc)
    html = build_mockup_html("t")
    assert "BOOKING: 1801" in html
    assert 'class="mk-sidenav-item active"' in html
    assert "Summary" in html and "Attachments" in html
    assert "Sync | Integration error" in html
    assert "Reference" in html
    # the first section is active/visible by default, the second hidden
    assert 'data-tab-panel="0"><div class="mk-detail-block">' in html.replace("\n", "")
    assert 'data-tab-panel="1" style="display:none"' in html


def test_sidebar_nav_is_valid_without_info_and_alerts(patch_doc):
    doc = _sidebar_nav_doc()
    props = doc["pages"][0]["components"][0]["props"]
    del props["info"]
    del props["alerts"]
    _validate(doc)
    patch_doc(doc)
    html = build_mockup_html("t")
    assert 'class="mk-sidenav-info"' not in html
    assert 'class="mk-sidenav-alerts"' not in html
