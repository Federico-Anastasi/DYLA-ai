"""Tests for the social/graphic designs HTML export (server/design_export.py), v2:
free agent-authored HTML/CSS artboards, wrapped/sanitized/scaled by the backend.

Fixture pattern taken from test_diagram_export.py / test_mockup_export.py: `load_doc`
is monkeypatched in the module under test, not on the filesystem.

Two layers of tests:
  - unit tests directly against `_sanitize_html` / `_prefix_css` / `_design_size`,
    which pin down exactly what the sanitizer strips and how CSS scoping behaves;
  - integration tests against the full `design_html(project)` output, which check
    wrapping, native sizing, the error-box fallback, and end-to-end escaping.

Run with `python -m pytest server/tests`.
"""
import json
from pathlib import Path

import jsonschema
import pytest

from server import design_export
from server.design_export import _FORMATS, _sanitize_html, _design_size, design_html

SCHEMA = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "schemas" / "design.schema.json")
    .read_text(encoding="utf-8")
)


def _validate(doc: dict) -> None:
    jsonschema.validate(instance=doc, schema=SCHEMA)


@pytest.fixture
def patch_doc(monkeypatch):
    """Makes load_doc('t', 'design') resolve to the given document, without
    touching the filesystem."""

    def _patch(doc: dict):
        monkeypatch.setattr(design_export, "load_doc",
                             lambda project, name: doc if project == "t" else None)

    return _patch


# --- fixture: brand + a handful of designs, one per interesting case -------------

def _brand() -> dict:
    return {
        "name": "Larkfield Vets",
        "handle": "@larkfieldvet",
        "colors": {
            "primary": "#1f6f4a",
            "accent": "#f2a71b",
            "background": "#fbfaf6",
            "text": "#12211c",
        },
        "voice": "warm, local, no corporate speak",
    }


_STYLED_HTML = (
    '<style>.hl{color:red;font-size:40px;} '
    "@media (max-width: 500px){.hl{font-size:20px;}}"
    "</style>"
    '<div class="hl">Autumn <em>Sale</em></div>'
)

_BAD_HTML = (
    "<script>alert(1)</script>"
    '<div onclick="alert(1)" style="background:url(http://evil.com/bg.png)">click me</div>'
    '<img src="http://evil.com/track.png">'
    '<a href="javascript:alert(1)">click</a>'
    '<iframe src="http://evil.com/frame"></iframe>'
    "<style>.x{background:url(http://evil.com/tile.png);} "
    '@import "http://evil.com/import.css";'
    "</style>"
)


def _designs() -> list[dict]:
    return [
        {
            "id": "post-styled", "format": "ig-square",
            "title": 'Autumn <Sale> & "Deals"',  # special chars, deliberately
            "notes": "publish Monday",
            "html": _STYLED_HTML,
        },
        {
            "id": "story-plain", "format": "ig-story",
            "html": '<div style="color:var(--brand-text)">Hello story</div>',
        },
        {
            "id": "portrait-plain", "format": "ig-portrait",
            "html": "<div>Hello portrait</div>",
        },
        {
            "id": "linkedin-plain", "format": "li-landscape",
            "html": "<div>Hello LinkedIn</div>",
        },
        {
            "id": "custom-banner", "format": "custom", "width": 800, "height": 400,
            "html": '<div>Custom banner</div>',
        },
        {
            "id": "custom-bad", "format": "custom",  # no width/height -> error box
            "html": '<div>Should never render</div>',
        },
        {
            "id": "bad-actor", "format": "ig-square",
            "html": _BAD_HTML,
        },
    ]


def _full_doc(designs: list[dict]) -> dict:
    return {
        "meta": {"project": "t", "title": "Larkfield — September campaign",
                 "date": "2026-07-20", "status": "draft"},
        "brand": _brand(),
        "designs": designs,
    }


ALL_DOC = _full_doc(_designs())


def test_fixture_validates_against_the_schema():
    _validate(ALL_DOC)


# --- unit tests: _design_size -----------------------------------------------------

def test_design_size_resolves_fixed_formats():
    for fmt, (w, h) in _FORMATS.items():
        assert _design_size({"format": fmt}) == (w, h)


def test_design_size_resolves_custom_with_dims():
    assert _design_size({"format": "custom", "width": 800, "height": 400}) == (800, 400)


def test_design_size_none_for_custom_missing_dims():
    assert _design_size({"format": "custom"}) is None
    assert _design_size({"format": "custom", "width": 800}) is None
    assert _design_size({"format": "custom", "height": 400}) is None


# --- unit tests: _sanitize_html ----------------------------------------------------

def test_sanitize_removes_script_blocks():
    out = _sanitize_html("<div>ok</div><script>alert(1)</script>", "d1")
    assert "<script" not in out.lower()
    assert "alert(1)" not in out
    assert "<div>ok</div>" in out


def test_sanitize_removes_dangerous_tags():
    out = _sanitize_html(
        '<iframe src="http://evil.com"></iframe><object data="http://evil.com"></object>'
        '<embed src="http://evil.com"><link rel="stylesheet" href="http://evil.com/x.css">'
        '<meta http-equiv="refresh" content="0"><base href="http://evil.com">',
        "d1",
    )
    for tag in ("iframe", "object", "embed", "link", "meta", "base"):
        assert f"<{tag}" not in out.lower()


def test_sanitize_removes_event_handler_attributes():
    out = _sanitize_html('<div onclick="alert(1)" onmouseover="steal()">hi</div>', "d1")
    assert "onclick" not in out.lower()
    assert "onmouseover" not in out.lower()
    assert "<div>hi</div>" in out


def test_sanitize_neutralizes_javascript_href():
    out = _sanitize_html('<a href="javascript:alert(1)">click</a>', "d1")
    assert "javascript:" not in out.lower()
    assert 'href=""' in out


def test_sanitize_neutralizes_external_src_and_href():
    out = _sanitize_html(
        '<img src="http://evil.com/track.png"><a href="https://evil.com/page">go</a>',
        "d1",
    )
    assert "evil.com" not in out
    assert 'src=""' in out
    assert 'href=""' in out


def test_sanitize_allows_data_uri_and_relative_refs():
    out = _sanitize_html(
        '<img src="data:image/png;base64,AAAA"><a href="#section">jump</a>'
        '<svg><use href="#icon-star"></use></svg>',
        "d1",
    )
    assert "data:image/png;base64,AAAA" in out
    assert 'href="#section"' in out
    assert 'href="#icon-star"' in out


def test_sanitize_neutralizes_external_css_url_in_style_block():
    out = _sanitize_html(
        '<style>.x{background:url(http://evil.com/tile.png);} '
        '@import "http://evil.com/import.css";</style>',
        "d1",
    )
    assert "evil.com" not in out
    assert "url(none)" in out
    assert "@import" not in out


def test_sanitize_neutralizes_external_css_url_in_inline_style_attr():
    out = _sanitize_html(
        '<div style="background-image:url(http://evil.com/bg.png)">x</div>', "d1"
    )
    assert "evil.com" not in out
    assert "url(none)" in out


def test_sanitize_scopes_style_selectors_with_design_id():
    out = _sanitize_html(_STYLED_HTML, "post-styled")
    assert "#post-styled .hl{color:red;font-size:40px;}" in out
    assert "@media (max-width: 500px){#post-styled .hl{font-size:20px;}}" in out


def test_sanitize_does_not_escape_html_markup():
    """The design's own html is markup, not text — it must reach the output as
    real tags, not &lt;em&gt;-escaped."""
    out = _sanitize_html(_STYLED_HTML, "post-styled")
    assert "<em>Sale</em>" in out


def test_sanitize_empty_html_does_not_crash():
    assert _sanitize_html("", "d1") == ""
    assert _sanitize_html(None, "d1") == ""


# --- integration tests: design_html ------------------------------------------------

def test_every_fixed_format_renders_at_its_exact_native_size(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")
    for fmt, (w, h) in _FORMATS.items():
        assert f'data-native-w="{w}"' in out, f"missing native width for {fmt}"
        assert f'data-native-h="{h}"' in out, f"missing native height for {fmt}"
        assert f"width:{w}px;height:{h}px;" in out, f"missing exact CSS size for {fmt}"


def test_custom_format_with_dims_renders_at_its_exact_native_size(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")
    assert 'data-native-w="800"' in out
    assert 'data-native-h="400"' in out
    assert "width:800px;height:400px;" in out


def test_custom_format_missing_dims_renders_error_box_not_crash(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")  # must not raise
    assert 'id="custom-bad"' in out
    assert "artboard-error" in out
    assert "width and height" in out
    # the bad design must not carry a native-size artboard of its own
    assert 'id="custom-bad"' in out and "custom-bad.png" not in out


def test_wrapper_ids_present_for_every_design(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")
    for d in _designs():
        assert f'id="{d["id"]}"' in out


def test_brand_css_variables_are_inline_on_the_artboard(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")
    assert "--brand-primary:#1f6f4a;" in out
    assert "--brand-accent:#f2a71b;" in out
    assert "--brand-background:#fbfaf6;" in out
    assert "--brand-text:#12211c;" in out


def test_brand_accent_falls_back_to_primary_when_absent(patch_doc):
    doc = _full_doc([{"id": "solo", "format": "ig-square", "html": "<div>hi</div>"}])
    brand = doc["brand"]
    del brand["colors"]["accent"]
    _validate(doc)
    patch_doc(doc)
    out = design_html("t")
    assert f"--brand-accent:{brand['colors']['primary']};" in out


def test_title_is_escaped_in_the_meta_bar_but_html_is_not_escaped(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")
    assert "Autumn &lt;Sale&gt; &amp; &quot;Deals&quot;" in out
    assert '<span class="meta-title">Autumn <Sale>' not in out  # raw title never leaks
    # meanwhile the design's own markup is real markup, not escaped
    assert "<em>Sale</em>" in out


def test_bad_actor_design_is_fully_neutralized_end_to_end(patch_doc):
    """The page itself legitimately carries one <script> (the PNG/theme JS in
    _page_js) — this only asserts the bad-actor DESIGN's payload is gone, not
    that the whole page is script-free."""
    patch_doc(ALL_DOC)
    out = design_html("t")
    assert "alert(1)" not in out
    assert "onclick" not in out.lower()
    assert "javascript:" not in out.lower()
    assert "<iframe" not in out.lower()
    assert "evil.com" not in out


def test_minimal_design_no_title_no_notes_does_not_crash(patch_doc):
    doc = _full_doc([{"id": "bare", "format": "ig-square", "html": "<div>hi</div>"}])
    _validate(doc)
    patch_doc(doc)
    out = design_html("t")
    assert 'id="bare"' in out


def test_empty_html_field_does_not_crash(patch_doc):
    doc = _full_doc([{"id": "empty-html", "format": "ig-square", "html": ""}])
    _validate(doc)
    patch_doc(doc)
    out = design_html("t")
    assert 'id="empty-html"' in out


def test_png_button_present_for_valid_designs_absent_for_error_box(patch_doc):
    patch_doc(ALL_DOC)
    out = design_html("t")
    assert 'data-filename="t-post-styled.png"' in out
    assert 'data-filename="t-story-plain.png"' in out
    assert 'data-filename="t-custom-banner.png"' in out
    assert 'data-filename="t-custom-bad.png"' not in out


def test_single_design_has_no_errors(patch_doc):
    doc = _full_doc([_designs()[0]])
    patch_doc(doc)
    out = design_html("t")
    assert "post-styled" in out


def test_design_html_doc_not_found():
    with pytest.raises(design_export.DocNotFound):
        design_html("nonexistent_project_xyz_pytest")
