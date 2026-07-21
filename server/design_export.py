"""Exports design.json as a single self-contained HTML file: every social/graphic
design as an artboard at its exact pixel size (see schemas/design.schema.json for the
document shape), with a client-side "PNG" button per artboard.

Philosophy (the v2 pivot): there is no template library any more. The agent writes
free HTML/CSS per artboard (`designs[].html`); this module only wraps it in a
correctly-sized, brand-tokened container, SANITIZES it, and adds the on-screen chrome
(scaling, PNG export, page theme). It never touches layout or content — that is the
agent's job now.

Pipeline per design:
1. resolve its native pixel size from `format` (fixed table) or `width`/`height`
   (format 'custom'). If 'custom' is missing either dimension, render a readable
   error box in its place instead of raising — one bad design must not take the
   whole document down with it.
2. sanitize `html` (see `_sanitize_html` below — this is the critical piece).
3. wrap it in `<div class="artboard" id=... data-native-w=... data-native-h=...
   style="width:...px;height:...px;position:relative;overflow:hidden;
   --brand-primary:...;--brand-accent:...;--brand-background:...;--brand-text:...;
   transform:scale(...)">SANITIZED_HTML</div>` — the four brand CSS variables are
   set INLINE on this exact node, so the agent's CSS can reference
   var(--brand-primary) etc. without the backend hardcoding any hex value into a
   shared stylesheet.
4. scale it down for the on-screen gallery with a CSS transform (native px size is
   preserved via data-native-w/h for the PNG export), and give it a small meta bar
   (id / title / format / dimensions / PNG button).

PNG export (client-side, self-contained, same trick as v1 — see the JS in
`_page_js`): the artboard node is cloned, its preview transform is removed (so it
reports its NATIVE pixel size again), and the clone is serialized inside
`<svg><foreignObject>`, drawn onto a same-size <canvas>, and read back with
toBlob/PNG. Because the design's own <style> tags (already scoped, see below) live
INSIDE the .artboard node itself, cloning the node carries its styling along for
free — unlike v1, this module does not need to re-embed a shared template
stylesheet into the exported SVG; a two-line HTML/body reset is enough.

The page chrome (gallery, top bar) keeps a light/dark toggle for the PAGE only, the
same data-theme + prefers-color-scheme + localStorage pattern used in
diagram_export.py. The artboard content's own colours are the agent's problem (via
the brand CSS variables); this toggle never reaches into an artboard.
"""
from __future__ import annotations

import html
import re

from .documents import load_doc
from .exports import DocNotFound

__all__ = ["design_html", "_FORMATS"]


def _require_design(project: str) -> dict:
    data = load_doc(project, "design")
    if data is None:
        raise DocNotFound(f"design.json not found for project '{project}'")
    return data


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


# ═══════════════════════════════════════════════════════════════════════════
# formats
# ═══════════════════════════════════════════════════════════════════════════

# Native pixel size, per schemas/design.schema.json. 'custom' is handled separately
# (width/height come from the design itself).
_FORMATS = {
    "ig-square": (1080, 1080),
    "ig-portrait": (1080, 1350),
    "ig-story": (1080, 1920),
    "li-landscape": (1200, 627),
}

# Fixed on-screen preview width (px) for every artboard, regardless of format — a
# CSS transform on the artboard itself does the shrinking to fit the page; the
# wrapper around it is sized to the resulting (scaled) box so cards never overlap.
_DISPLAY_WIDTH = 320


def _design_size(d: dict) -> tuple[int, int] | None:
    """Native (width, height) for one design, or None if it cannot be resolved —
    the only case in a schema-valid document is format 'custom' missing width
    and/or height, but this stays defensive (e.g. a document edited by hand
    outside the schema) rather than trusting the input blindly."""
    fmt = d.get("format")
    if fmt in _FORMATS:
        return _FORMATS[fmt]
    if fmt == "custom":
        w, h = d.get("width"), d.get("height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            return w, h
        return None
    return None


# ═══════════════════════════════════════════════════════════════════════════
# SANITIZER — the critical piece. Regex/string-based on purpose: stdlib only (re,
# html), no new dependency, consistent with the rest of this module and easy to
# reason about rule-by-rule. It is NOT a full HTML/CSS parser, and it is not meant
# to withstand a determined attacker — see the "does NOT guarantee" list at the
# bottom of this section. Its job is to stop the ordinary ways an agent-written
# artboard breaks self-containment or does something a static graphic should never
# do (run script, phone home for an image, navigate on click).
#
# Order matters below: strip the big dangerous blocks/tags first (script, iframe,
# object, embed, link, meta, base), then attribute-level hazards (on*, javascript:
# URLs, external http(s) src/href), then scope the design's own <style> blocks
# (which also strips external url(...) inside them), then one last global pass to
# catch url(http...) sitting in inline style="" attributes (a no-op over the
# <style> blocks, which are already clean by then).
# ═══════════════════════════════════════════════════════════════════════════

_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script\s*>", re.I | re.S)
_SCRIPT_ORPHAN_RE = re.compile(r"<script\b[^>]*/?>", re.I)

# iframe/object/embed normally carry content and a closing tag — remove the whole
# block; then sweep any orphan opening tag a malformed document left behind.
_BLOCK_TAGS = ("iframe", "object", "embed")
# link/meta/base are void elements in practice — remove standalone occurrences and
# any (non-conformant but seen in the wild) closing tag.
_VOID_TAGS = ("link", "meta", "base")

# Any on* attribute (onclick, onload, onerror, onmouseover, ...), any quoting style.
_ON_ATTR_RE = re.compile(r"""\s+on[a-zA-Z-]+\s*=\s*(".*?"|'.*?'|[^\s>]+)""", re.I | re.S)

# src=/href= whose value is javascript: or http(s):// — both are neutralized to an
# empty attribute in one pass (a click-triggered script and a network fetch are the
# same class of problem here: something the sanitized artboard must not be able to
# do). data:, #, relative paths, mailto:, tel: and inline SVG references (#icon-id)
# are left untouched.
_RESOURCE_ATTR_RE = re.compile(
    r"""\b(src|href)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))""", re.I
)

# url(http://...) / url(https://...) inside CSS — turned into url(none) so a
# missing network resource can never break layout or the PNG export.
_CSS_EXTERNAL_URL_RE = re.compile(r"""url\(\s*['"]?https?://[^)'"]*['"]?\s*\)""", re.I)
# @import "http://..."; — the string-literal form of @import, which does not go
# through url() and so would not be caught by the rule above.
_CSS_EXTERNAL_IMPORT_RE = re.compile(r"""@import\s+["']https?://[^"']*["'];?""", re.I)

_STYLE_BLOCK_RE = re.compile(r"<style\b([^>]*)>(.*?)</style\s*>", re.I | re.S)

# At-rules whose body is itself a list of rules to recurse into and prefix
# (@media/@supports nest ordinary selectors). Everything else with a body that is
# NOT a selector list (@keyframes percentages, @font-face/@page declarations) is
# left structurally alone — only external url()s inside it are stripped.
_AT_RULES_RECURSE = ("@media", "@supports")


def _strip_block_tag(text: str, tag: str) -> str:
    text = re.sub(rf"<{tag}\b[^>]*>.*?</{tag}\s*>", "", text, flags=re.I | re.S)
    text = re.sub(rf"<{tag}\b[^>]*/?>", "", text, flags=re.I)
    return text


def _strip_void_tag(text: str, tag: str) -> str:
    text = re.sub(rf"<{tag}\b[^>]*/?>", "", text, flags=re.I)
    text = re.sub(rf"</{tag}\s*>", "", text, flags=re.I)
    return text


def _neutralize_resource_attr(m: re.Match) -> str:
    attr = m.group(1)
    value = m.group(4)
    if value is None:
        value = m.group(5)
    if value is None:
        value = m.group(6) or ""
    lowered = value.strip().lower()
    if lowered.startswith("javascript:") or lowered.startswith("http://") or lowered.startswith("https://"):
        return f'{attr}=""'
    return m.group(0)


def _strip_external_css(text: str) -> str:
    text = _CSS_EXTERNAL_IMPORT_RE.sub("", text)
    text = _CSS_EXTERNAL_URL_RE.sub("url(none)", text)
    return text


def _prefix_selector_list(selectors: str, prefix: str) -> str:
    """selector, selector -> #id selector, #id selector — one comma-separated
    selector list. Simple string split on commas: a selector using a comma inside
    a functional pseudo-class (e.g. :not(a, b), level-4 CSS, rare in hand-written
    artboard CSS) would be split incorrectly here. Documented limitation, not
    fixed: a stray extra selector renders as either scoped-but-harmless or
    unscoped-but-present — never a crash, per the brief's own priority."""
    parts = [p.strip() for p in selectors.split(",")]
    out = []
    for p in parts:
        if not p:
            continue
        if p == ":root":
            out.append(prefix)
        elif p.startswith(":root"):
            out.append(prefix + p[len(":root"):])
        elif p == "*":
            out.append(f"{prefix} *")
        elif p.startswith(prefix):
            out.append(p)  # already scoped (defensive; should not normally occur)
        else:
            out.append(f"{prefix} {p}")
    return ", ".join(out) if out else selectors


def _prefix_css(css: str, prefix: str) -> str:
    """Prefixes every ordinary selector in `css` with `prefix` (the wrapper's
    `#design-id`), so a design's <style> block can never leak onto — or be
    clobbered by — another design's markup or the page chrome. Brace-depth aware
    (handles one level of nesting, enough for @media/@supports around ordinary
    rules); NOT a real CSS tokenizer, so a selector containing an unbalanced brace
    inside a string literal (e.g. content: "}") would desync the scan. That is
    deliberately left as a known gap rather than pulled in a CSS parser dependency
    for it — per the brief, a stray unscoped rule is an acceptable outcome, a
    crash is not.
    """
    out = []
    i, n = 0, len(css)
    while i < n:
        brace = css.find("{", i)
        if brace == -1:
            out.append(css[i:])
            break
        head = css[i:brace].strip()
        depth = 1
        j = brace + 1
        while j < n and depth > 0:
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
            j += 1
        body = css[brace + 1:j - 1]

        if head.startswith("@"):
            at_name = head.split(None, 1)[0].lower() if head.split() else head.lower()
            if any(at_name.startswith(p) for p in _AT_RULES_RECURSE):
                out.append(f"{head}{{{_prefix_css(body, prefix)}}}")
            else:
                out.append(f"{head}{{{_strip_external_css(body)}}}")
        elif head:
            out.append(f"{_prefix_selector_list(head, prefix)}{{{_strip_external_css(body)}}}")
        else:
            # stray '{' with no selector before it (malformed CSS) — keep the body,
            # drop nothing, add no selector we cannot construct.
            out.append(f"{{{_strip_external_css(body)}}}")
        i = j
    return "".join(out)


def _scope_style_blocks(text: str, design_id: str) -> str:
    prefix = f"#{design_id}"

    def repl(m: re.Match) -> str:
        attrs, content = m.group(1), m.group(2)
        content = re.sub(r"/\*.*?\*/", "", content, flags=re.S)  # strip CSS comments first
        return f"<style{attrs}>{_prefix_css(content, prefix)}</style>"

    return _STYLE_BLOCK_RE.sub(repl, text)


def _sanitize_html(raw_html: str, design_id: str) -> str:
    """Sanitizes one design's `html` before it is placed inside its artboard
    wrapper. Design-scoped: `design_id` becomes the CSS prefix for that design's
    own <style> blocks (see `_scope_style_blocks`).

    What this DOES:
      - removes <script> blocks entirely (and any orphan/unclosed <script> tag);
      - removes <iframe>/<object>/<embed> blocks, and <link>/<meta>/<base> tags;
      - removes every on* event-handler attribute (onclick, onload, onerror, ...);
      - empties any src=/href= whose value is javascript: or an external
        http(s):// URL (data:, relative paths, #fragments, mailto:, tel: pass
        through untouched — inline images and inline SVG are meant to work);
      - turns url(http://...)/url(https://...) and string-literal @import of an
        external URL into inert `url(none)` / nothing, inside both the design's
        own <style> blocks and any inline style="" attribute;
      - prefixes every ordinary selector in the design's <style> blocks with
        #<design_id>, so its CSS cannot escape its own artboard.

    What this explicitly does NOT guarantee (regex/string-based, not a browser-
    grade sanitizer — acceptable here because this is a local, single-operator
    tool turning the AGENT'S OWN generated markup into a file, not untrusted
    third-party input):
      - it is not a real HTML tokenizer: unusual quoting, stray angle brackets
        inside attribute values, or HTML comments/CDATA used to hide a tag can
        in principle slip past a pattern match built for well-formed markup;
      - it does not decode HTML entities before matching, so an obfuscated
        scheme such as "jav&#97;script:" would not be caught by the
        javascript: check (a browser that decodes entities before evaluating an
        href could still be tricked by that);
      - CSS is scoped with a brace-depth scanner, not a real parser (see
        `_prefix_css`'s docstring for the one known gap: an unbalanced brace
        inside a CSS string literal desyncs the scan);
      - it does not inspect the CONTENT of a data: URI — a data:text/html href
        (as opposed to a data: image, which is the intended and permitted use)
        is not blocked, only javascript:/http(s): are;
      - it does not defend against CSS-only exfiltration techniques (e.g.
        attribute selectors combined with background-image, timing-based
        side channels) — out of scope for a static social-post export.
    """
    if not raw_html:
        return ""

    out = raw_html
    out = _SCRIPT_RE.sub("", out)
    out = _SCRIPT_ORPHAN_RE.sub("", out)
    for tag in _BLOCK_TAGS:
        out = _strip_block_tag(out, tag)
    for tag in _VOID_TAGS:
        out = _strip_void_tag(out, tag)
    out = _ON_ATTR_RE.sub("", out)
    out = _RESOURCE_ATTR_RE.sub(_neutralize_resource_attr, out)
    out = _scope_style_blocks(out, design_id)
    # Final global pass: catches url(http...)/@import left in inline style=""
    # attributes. Harmless no-op over the <style> blocks above, which are
    # already clean by this point.
    out = _CSS_EXTERNAL_IMPORT_RE.sub("", out)
    out = _CSS_EXTERNAL_URL_RE.sub("url(none)", out)
    return out


# ═══════════════════════════════════════════════════════════════════════════
# page chrome CSS (light/dark PAGE theme only — never reaches into an artboard)
# ═══════════════════════════════════════════════════════════════════════════

_CHROME_LIGHT_VARS = {
    "--chrome-bg": "#f1f1f4", "--chrome-fg": "#111827", "--chrome-muted": "#4b5563",
    "--chrome-border": "#e2e8f0", "--chrome-card-bg": "#ffffff",
    "--chrome-tag-bg": "#eef2f7", "--chrome-tag-fg": "#475569",
    "--chrome-btn-bg": "#ffffff", "--chrome-btn-fg": "#111827",
    "--chrome-btn-border": "#cbd5e1", "--chrome-btn-hover": "#f8fafc",
    "--chrome-error-bg": "#fff1f2", "--chrome-error-border": "#fecdd3",
    "--chrome-error-fg": "#9f1239",
}
_CHROME_DARK_VARS = {
    "--chrome-bg": "#0b0f19", "--chrome-fg": "#e2e8f0", "--chrome-muted": "#94a3b8",
    "--chrome-border": "#293347", "--chrome-card-bg": "#131a29",
    "--chrome-tag-bg": "#1e293b", "--chrome-tag-fg": "#94a3b8",
    "--chrome-btn-bg": "#131a29", "--chrome-btn-fg": "#e2e8f0",
    "--chrome-btn-border": "#334155", "--chrome-btn-hover": "#1e293b",
    "--chrome-error-bg": "#2a1215", "--chrome-error-border": "#6b1a24",
    "--chrome-error-fg": "#fda4af",
}


def _vars_block(vars_dict: dict, selector: str = ":root") -> str:
    body = "".join(f"{k}:{v};" for k, v in vars_dict.items())
    return f"{selector}{{{body}}}"


_CHROME_CSS = """
html,body{margin:0;padding:0;background:var(--chrome-bg);color:var(--chrome-fg);
  font-family:system-ui,"Segoe UI",Arial,sans-serif;}
.page-wrap{max-width:1500px;margin:0 auto;padding:24px;}
.top-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  margin-bottom:20px;flex-wrap:wrap;}
.doc-title{font-size:20px;font-weight:700;margin:0;}
.brand-tag{font-size:13px;font-weight:600;color:var(--chrome-muted);letter-spacing:.02em;}
.theme-toggle{border:1px solid var(--chrome-btn-border);background:var(--chrome-btn-bg);
  color:var(--chrome-btn-fg);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;}
.gallery{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-start;}
.artboard-card{background:var(--chrome-card-bg);border:1px solid var(--chrome-border);
  border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
.artboard-scale-wrap{position:relative;overflow:hidden;border-radius:6px;}
.artboard-meta{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;font-size:12px;}
.meta-id{font-weight:700;color:var(--chrome-fg);}
.meta-title{color:var(--chrome-muted);}
.meta-tag{background:var(--chrome-tag-bg);color:var(--chrome-tag-fg);border-radius:5px;
  padding:2px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;}
.png-btn{margin-left:auto;border:1px solid var(--chrome-btn-border);background:var(--chrome-btn-bg);
  color:var(--chrome-btn-fg);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600;}
.png-btn:hover{background:var(--chrome-btn-hover);}
.artboard-error{display:flex;align-items:center;justify-content:center;text-align:center;
  padding:24px;min-height:160px;background:var(--chrome-error-bg);
  border:1px dashed var(--chrome-error-border);color:var(--chrome-error-fg);
  border-radius:6px;font-size:13px;line-height:1.4;box-sizing:border-box;}
"""


def _page_css() -> str:
    return (
        _vars_block(_CHROME_LIGHT_VARS)
        + f"@media (prefers-color-scheme: dark){{{_vars_block(_CHROME_DARK_VARS)}}}"
        + _vars_block(_CHROME_DARK_VARS, ":root[data-theme='dark']")
        + _vars_block(_CHROME_LIGHT_VARS, ":root[data-theme='light']")
        + _CHROME_CSS
    )


# ═══════════════════════════════════════════════════════════════════════════
# JS: page theme toggle + PNG export via SVG foreignObject (see module docstring)
# ═══════════════════════════════════════════════════════════════════════════

def _page_js() -> str:
    return """
(function () {
  var STORAGE_KEY = 'dyla-design-theme';
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
})();

// Minimal reset only: the design's own (already scoped) <style> block lives
// INSIDE the .artboard node and travels with it when cloned below, so no shared
// template stylesheet needs to be re-embedded here (unlike v1's template system).
var EXPORT_CSS = "html,body{margin:0;padding:0;}";

function svgMarkupFor(artboard, w, h) {
  var clone = artboard.cloneNode(true);
  clone.style.transform = 'none';
  clone.style.width = w + 'px';
  clone.style.height = h + 'px';
  clone.removeAttribute('data-native-w');
  clone.removeAttribute('data-native-h');
  var xhtml = clone.outerHTML;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
    + '<foreignObject width="100%" height="100%">'
    + '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;">'
    + '<style>' + EXPORT_CSS + '</style>' + xhtml + '</div>'
    + '</foreignObject></svg>';
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportPng(cardId, filename) {
  var card = document.getElementById(cardId);
  if (!card) return;
  var artboard = card.querySelector('.artboard');
  if (!artboard) return;
  var w = parseInt(artboard.getAttribute('data-native-w'), 10);
  var h = parseInt(artboard.getAttribute('data-native-h'), 10);
  var svgStr = svgMarkupFor(artboard, w, h);
  var svgUrl = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
  var img = new Image();
  img.onload = function () {
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(svgUrl);
    canvas.toBlob(function (blob) { downloadBlob(blob, filename); }, 'image/png');
  };
  img.onerror = function () {
    URL.revokeObjectURL(svgUrl);
    alert('PNG export needs a browser that rasterizes SVG foreignObject (Chrome, Edge, Firefox).');
  };
  img.src = svgUrl;
}

document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-export-png]');
  if (!btn) return;
  exportPng(btn.getAttribute('data-target'), btn.getAttribute('data-filename'));
});
"""


# ═══════════════════════════════════════════════════════════════════════════
# per-design card (artboard, or a readable error box in its place)
# ═══════════════════════════════════════════════════════════════════════════

def _meta_bar(design_id: str, title: str | None, fmt, extra_tags: list[str],
              png_button: str = "") -> str:
    title_html = f'<span class="meta-title">{_esc(title)}</span>' if title else ""
    tags_html = "".join(f'<span class="meta-tag">{_esc(t)}</span>' for t in extra_tags if t)
    return (
        '<div class="artboard-meta">'
        f'<span class="meta-id">{_esc(design_id)}</span>'
        f"{title_html}"
        f'<span class="meta-tag">{_esc(fmt)}</span>'
        f"{tags_html}"
        f"{png_button}"
        "</div>"
    )


def _render_error_card(design_id: str, fmt, title: str | None) -> str:
    message = (
        f'Design "{design_id}": format "custom" needs width and height.'
        if fmt == "custom"
        else f'Design "{design_id}": unsupported format "{fmt}".'
    )
    meta = _meta_bar(design_id, title, fmt, [])
    return (
        f'<div class="artboard-card" id="{_esc(design_id)}">'
        f'<div class="artboard-error" style="width:{_DISPLAY_WIDTH}px;">{_esc(message)}</div>'
        f"{meta}"
        "</div>"
    )


def _render_card(project: str, d: dict, brand: dict) -> str:
    design_id = d["id"]
    fmt = d.get("format")
    title = d.get("title")

    size = _design_size(d)
    if size is None:
        return _render_error_card(design_id, fmt, title)
    w, h = size

    colors = brand["colors"]
    primary = colors["primary"]
    accent = colors.get("accent") or primary
    background = colors["background"]
    text = colors["text"]
    brand_vars = (
        f"--brand-primary:{primary};--brand-accent:{accent};"
        f"--brand-background:{background};--brand-text:{text};"
    )

    safe_html = _sanitize_html(d.get("html") or "", design_id)

    display_scale = _DISPLAY_WIDTH / w
    display_height = h * display_scale

    artboard_style = (
        f"width:{w}px;height:{h}px;position:relative;overflow:hidden;"
        f"transform:scale({display_scale:.6f});transform-origin:top left;{brand_vars}"
    )
    artboard_html = (
        f'<div class="artboard" data-native-w="{w}" data-native-h="{h}" '
        f'style="{artboard_style}">{safe_html}</div>'
    )

    filename = f"{project}-{design_id}.png"
    png_button = (
        f'<button type="button" class="png-btn" data-export-png '
        f'data-target="{_esc(design_id)}" data-filename="{_esc(filename)}">PNG</button>'
    )
    meta = _meta_bar(design_id, title, fmt, [f"{w}×{h}"], png_button)

    return (
        f'<div class="artboard-card" id="{_esc(design_id)}">'
        f'<div class="artboard-scale-wrap" style="width:{_DISPLAY_WIDTH}px;'
        f'height:{display_height:.1f}px;">{artboard_html}</div>'
        f"{meta}"
        "</div>"
    )


# ═══════════════════════════════════════════════════════════════════════════
# full document
# ═══════════════════════════════════════════════════════════════════════════

def design_html(project: str) -> str:
    data = _require_design(project)
    meta = data["meta"]
    brand = data["brand"]
    designs = data["designs"]

    cards = "".join(_render_card(project, d, brand) for d in designs)

    title = _esc(meta.get("title", "Designs"))
    brand_name = _esc(brand.get("name", ""))
    page_css = _page_css()
    js = _page_js()

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>{page_css}</style>
</head>
<body>
<div class="page-wrap">
  <div class="top-bar">
    <h1 class="doc-title">{title}</h1>
    <div class="brand-tag">{brand_name}</div>
    <button type="button" class="theme-toggle" id="theme-toggle">Light / Dark</button>
  </div>
  <div class="gallery">
    {cards}
  </div>
</div>
<script>{js}</script>
</body>
</html>"""
