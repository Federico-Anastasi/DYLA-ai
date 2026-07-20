"""Web search for the agent, scraped directly. No cloud service, no API key, no Docker.

The built-in WebSearch tool reaches Anthropic's servers, which a local model cannot do:
it does not fail loudly, it comes back empty and the turn is wasted. So the search is
ours — three public engines scraped in parallel, results merged, pages extracted to
clean markdown. It is the same recipe as the commercial tools (Tavily, Jina, Firecrawl)
reduced to what one person actually needs, and it costs nothing to run.

Four tools, shaped for a slow local model where every round trip is a minute of someone's
time:

    search        DuckDuckGo, Brave and Startpage in parallel, merged and deduped —
              one engine breaking does not break the search
    read_url      a page as clean markdown, nav and ads stripped
    research      search AND the top pages already extracted, in ONE call
    search_images direct image URLs

The engines were chosen by probing them (2026-07-18): Brave answered 429 that day and Bing
now serves a page with no results in the markup at all; the three in ENGINES are the ones
that serve real HTML today. These are scrapers against HTML nobody promised us: when an engine changes its
markup its parser breaks, and the fix is that parser — which is why they are three, and
why one failing is survivable.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import socket
from urllib.parse import quote, unquote, urlparse

import httpx
from bs4 import BeautifulSoup
from claude_agent_sdk import create_sdk_mcp_server, tool
from markdownify import markdownify
from readability import Document

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
# Some sites (Medium and friends) refuse anonymous browsers but serve Googlebot.
GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
TIMEOUT = 20.0

# A page worth reading is text. Past this many bytes it stops being a page and starts
# being a download — an ISO, a video — and reading the whole thing into memory just to
# throw it away is how one bad link swells the process. Content-Type is checked too, for
# the same reason: a PDF or a video comes back as noise no markdown pipeline should touch.
MAX_BODY_BYTES = 5_000_000
_TEXTY_PREFIXES = ("text/", "application/json", "application/xml",
                   "application/xhtml+xml", "application/rss+xml", "application/atom+xml")
_MAX_REDIRECTS = 5


class UnsafeURL(ValueError):
    """A URL this tool refuses to fetch: not http(s), resolves to a local/private
    address, or the response is not a text document."""


def _assert_public_url(url: str) -> None:
    """Raises UnsafeURL unless `url` is a plain http(s) address that resolves to a
    public IP.

    The model can be handed any URL — by the user, or by a page it just read that
    contains a link — and this tool would fetch it with no browser sandbox in the way.
    Without this check a "read this page" can just as well read 127.0.0.1, the router's
    admin page on the LAN, or the cloud metadata endpoint at 169.254.169.254. It is
    called on EVERY hop of a redirect, not just the first URL, because a public page is
    an easy place to park a redirect to a private one.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeURL(f"refusing to fetch '{url}': only http(s) URLs are allowed")
    host = parsed.hostname
    if not host:
        raise UnsafeURL(f"refusing to fetch '{url}': no host in the URL")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise UnsafeURL(f"refusing to fetch '{url}': cannot resolve host '{host}' ({e})") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise UnsafeURL(
                f"refusing to fetch '{url}': host '{host}' resolves to {ip}, "
                "a local or private address")


async def _get(url: str, accept: str = "text/html,*/*", ua: str | None = None) -> str:
    """The page as text. Retries once as Googlebot when politely refused.

    HTTP/2 is not a nicety here. Wikipedia — and it will not be the only one — answers
    403 to an HTTP/1.1 client no matter what User-Agent it sends, and 200 to the same
    request over h2. Without this the single most common source on the web is
    unreadable, and the failure looks like a blocked scraper rather than a protocol
    version.

    Redirects are followed by hand, one hop at a time, instead of handing the job to
    httpx's `follow_redirects`: that would check the URL we were asked for and then go
    wherever the server points it, including somewhere _assert_public_url would have
    refused outright.
    """
    cur = url
    async with httpx.AsyncClient(follow_redirects=False, timeout=TIMEOUT, http2=True) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            _assert_public_url(cur)
            async with client.stream("GET", cur, headers={"user-agent": ua or UA, "accept": accept}) as r:
                if r.is_redirect and r.headers.get("location"):
                    cur = str(httpx.URL(cur).join(r.headers["location"]))
                    continue
                if r.status_code in (403, 429) and ua is None:
                    return await _get(url, accept, GOOGLEBOT)
                r.raise_for_status()
                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                if ctype and not any(ctype.startswith(p) for p in _TEXTY_PREFIXES):
                    raise UnsafeURL(f"refusing to read '{cur}': content-type '{ctype}' is not text")
                body = bytearray()
                async for chunk in r.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BODY_BYTES:
                        raise UnsafeURL(f"refusing to read '{cur}': response exceeds "
                                        f"{MAX_BODY_BYTES} bytes")
                return body.decode(r.encoding or "utf-8", errors="replace")
        raise UnsafeURL(f"refusing to fetch '{url}': too many redirects")


def _soup(html: str) -> BeautifulSoup:
    """Parsed page with style, script and svg removed BEFORE anything reads text.

    Not tidiness: Startpage inlines <style> inside its result anchors, and without this
    the titles come out full of CSS.
    """
    doc = BeautifulSoup(html, "lxml")
    for node in doc.select("style, script, svg"):
        node.decompose()
    return doc


def _text(node) -> str:
    return re.sub(r"\s+", " ", node.get_text()).strip() if node else ""


# --- one parser per engine ----------------------------------------------------------

async def _duckduckgo(query: str) -> list[dict]:
    doc = _soup(await _get(f"https://html.duckduckgo.com/html/?q={quote(query)}"))
    out = []
    for el in doc.select(".result"):
        a = el.select_one("a.result__a")
        url = a.get("href", "") if a else ""
        m = re.search(r"uddg=([^&]+)", url)
        if m:  # DDG wraps every link in a redirect
            url = unquote(m.group(1))
        out.append({"title": _text(a), "url": url,
                    "snippet": _text(el.select_one(".result__snippet"))})
    return out


async def _brave(query: str) -> list[dict]:
    """Brave. Its markup is Svelte-generated, so the class names carry a build hash that
    changes on every deploy: we hang only off `data-type` and `.title`, which are the
    stable parts, and take the snippet as "the block minus its title" rather than naming
    a class that will not exist next month.

    (A probe in July 2026 got 429s from Brave and picked Bing instead; now Bing serves a
    page with no results in the HTML at all and Brave answers — which is the normal state
    of affairs for scrapers, and why there are three of them.)
    """
    doc = _soup(await _get(f"https://search.brave.com/search?q={quote(query)}"))
    out = []
    for el in doc.select("[data-type=web]"):
        a = el.select_one('a[href^="http"]')
        title = _text(el.select_one(".title"))
        whole = _text(el)
        snippet = whole[len(title):].strip() if title and whole.startswith(title) else whole
        out.append({"title": title, "url": a.get("href", "") if a else "",
                    "snippet": snippet[:300]})
    return out


async def _startpage(query: str) -> list[dict]:
    doc = _soup(await _get(f"https://www.startpage.com/sp/search?query={quote(query)}"))
    out = []
    for el in doc.select("div.result"):
        anchors = [a for a in el.select('a[href^="http"]')
                   if "startpage.com" not in a.get("href", "")]
        if not anchors:
            continue
        # The first anchor is often the "anonymous view" proxy link, not the result.
        a = next((x for x in anchors
                  if len(_text(x)) > 5 and "anonymous view" not in _text(x).lower()),
                 anchors[0])
        out.append({"title": _text(a), "url": a.get("href", ""),
                    "snippet": _text(el.select_one("p"))})
    return out


ENGINES = {"duckduckgo": _duckduckgo, "brave": _brave, "startpage": _startpage}


def _canon(url: str) -> str:
    """Host and path, lowercase, no trailing slash — enough to spot the same page found
    by two engines with different tracking parameters."""
    try:
        x = urlparse(url)
        return f"{x.netloc}{x.path}".lower().rstrip("/")
    except ValueError:
        return url


async def _search(query: str, max_results: int = 8) -> dict:
    """All three engines at once. A page several engines agree on ranks first."""
    names = list(ENGINES)
    settled = await asyncio.gather(*(ENGINES[n](query) for n in names),
                                   return_exceptions=True)
    status, by_url = [], {}
    for name, result in zip(names, settled):
        if isinstance(result, Exception):
            status.append(f"{name}: failed ({result})")
            continue
        rows = [r for r in result if r["url"].startswith("http")]
        status.append(f"{name}: {len(rows)}")
        for rank, r in enumerate(rows):
            key = _canon(r["url"])
            seen = by_url.get(key)
            if seen:
                seen["engines"].append(name)
                if len(r["snippet"]) > len(seen["snippet"]):
                    seen["snippet"] = r["snippet"]
            else:
                by_url[key] = {**r, "engines": [name], "rank": rank}
    if not by_url:
        raise RuntimeError("every engine failed: " + " · ".join(status))
    ranked = sorted(by_url.values(), key=lambda r: (-len(r["engines"]), r["rank"]))
    return {"source": " · ".join(status),
            "results": [{k: v for k, v in r.items() if k != "rank"}
                        for r in ranked[:max_results]]}


# --- reading a page -----------------------------------------------------------------

def _extract(html: str, url: str) -> tuple[str, str]:
    """(title, markdown). Readability first; the whole body when it gives up.

    Readability is built for articles and returns almost nothing on reference pages,
    documentation indexes and listings — exactly the pages worth reading. Below a few
    hundred characters we take the body instead: noisier, but there.
    """
    try:
        doc = Document(html)
        title, content = doc.short_title(), doc.summary()
        if len(re.sub(r"<[^>]+>", "", content).strip()) > 200:
            return title, markdownify(content, heading_style="ATX")
    except Exception:
        pass  # a broken page is not a reason to return nothing
    soup = BeautifulSoup(html, "lxml")
    for node in soup.select("script, style, noscript, iframe"):
        node.decompose()
    title = _text(soup.select_one("title")) or url
    body = soup.body or soup
    try:
        return title, markdownify(str(body), heading_style="ATX")
    except Exception:
        # The fallback used to be uncovered: readability giving up is exactly the kind of
        # page (a listing, an index) with markup irregular enough that markdownify can
        # choke on it too. Plain text beats losing the page a second time.
        return title, _text(body)


async def _read_url(url: str, max_chars: int = 20000) -> str:
    # New reddit is an anti-bot SPA; old.reddit serves real HTML.
    url = re.sub(r"^https?://(www\.)?reddit\.com/", "https://old.reddit.com/", url)
    raw = await _get(url)
    if not re.search(r"<[a-z][\s\S]*>", raw, re.I):
        return raw[:max_chars]  # already plain text or markdown
    title, md = _extract(raw, url)
    md = re.sub(r"\n{3,}", "\n\n", md)
    out = f"# {title}\nsource: {url}\n\n{md}"
    if len(out) > max_chars:
        out = out[:max_chars] + f"\n\n[CUT at {max_chars} chars — read again with a higher max_chars if you need the rest]"
    return out


async def _research(query: str, fetch_top: int = 3, max_chars_per_page: int = 8000) -> dict:
    """Search and read, in one call.

    A search that returns links costs a slow model two more turns before it knows
    anything. This returns the pages already extracted. Candidates come from distinct
    domains — three pages of one site is one point of view — and unreadable ones are
    skipped rather than handed over as an error for the model to puzzle over.
    """
    found = await _search(query, max_results=12)
    seen_hosts, candidates = set(), []
    for r in found["results"]:
        host = urlparse(r["url"]).netloc or r["url"]
        if host not in seen_hosts:
            seen_hosts.add(host)
            candidates.append(r)

    pages, used = [], set()
    for r in candidates:
        if len(pages) >= fetch_top:
            break
        try:
            text = await _read_url(r["url"], max_chars=max_chars_per_page)
            if len(re.sub(r"\s+", " ", text)) < 300:
                continue  # empty or anti-bot: the next candidate takes its place
            pages.append({"title": r["title"], "url": r["url"], "content": text})
            used.add(r["url"])
        except Exception:
            # Wider than (httpx.HTTPError, RuntimeError, ValueError) on purpose: a page
            # extraction can fail in ways that belong to bs4/markdownify, not to the
            # network, and any of those used to abort the WHOLE batch instead of just
            # this one candidate — the next one takes its place either way.
            continue
    return {"query": query, "source": found["source"], "pages": pages,
            "other_results": [{"title": r["title"], "url": r["url"], "snippet": r["snippet"]}
                              for r in candidates if r["url"] not in used][:6]}


async def _search_images(query: str, max_results: int = 12) -> dict:
    """DuckDuckGo's own image endpoint. It wants a token that only lives in the page."""
    html = await _get(f"https://duckduckgo.com/?q={quote(query)}&iax=images&ia=images")
    m = re.search(r"vqd=[\"']?([\d-]+)", html)
    if not m:
        raise RuntimeError("vqd token not found: DuckDuckGo changed the page, the parser needs updating")
    raw = await _get(f"https://duckduckgo.com/i.js?l=us-en&o=json&q={quote(query)}&vqd={m.group(1)}",
                     accept="application/json")
    results = json.loads(raw).get("results", [])
    return {"query": query,
            "images": [{"title": r.get("title"), "image_url": r.get("image"),
                        "thumbnail": r.get("thumbnail"), "width": r.get("width"),
                        "height": r.get("height"), "source_page": r.get("url")}
                       for r in results[:max_results]]}


# --- the tools the agent sees -------------------------------------------------------
#
# Descriptions are part of the prompt on every single turn, so they say what the tool is
# for and stop. See session_manager._tools_to_leave_out for what that costs.

def _reply(payload) -> dict:
    text = payload if isinstance(payload, str) else json.dumps(payload, indent=1, ensure_ascii=False)
    return {"content": [{"type": "text", "text": text}]}


def _failed(e: Exception) -> dict:
    return {"content": [{"type": "text", "text": f"ERROR: {e}"}], "is_error": True}


# Schemas are written out in full rather than with the shorthand {"query": str, ...}:
# the shorthand marks EVERY key as required, so the model could not call search without
# also inventing a max_results, and research without inventing two more numbers. Making
# the optional ones optional is the difference between one round trip and three.
@tool("search", "Web search across three engines at once, merged and deduplicated. "
                "Returns title, url and snippet. Use for anything current or outside "
                "what you already know.",
      {"type": "object",
       "properties": {"query": {"type": "string", "description": "what to search for"},
                      "max_results": {"type": "integer", "description": "default 8"}},
       "required": ["query"]})
async def search_tool(args) -> dict:
    try:
        return _reply(await _search(args["query"], int(args.get("max_results") or 8)))
    except Exception as e:
        return _failed(e)


@tool("read_url", "Fetch a page and return its main content as clean markdown, with "
                  "navigation, ads and footers stripped. Use after search to actually "
                  "read a result.",
      {"type": "object",
       "properties": {"url": {"type": "string", "description": "http(s) URL to read"},
                      "max_chars": {"type": "integer", "description": "default 20000"}},
       "required": ["url"]})
async def read_url_tool(args) -> dict:
    try:
        return _reply(await _read_url(args["url"], int(args.get("max_chars") or 20000)))
    except Exception as e:
        return _failed(e)


@tool("research", "Search AND read the best pages in one call: returns the top results "
                  "from distinct domains with their content already extracted. Prefer "
                  "this over search followed by read_url.",
      {"type": "object",
       "properties": {"query": {"type": "string", "description": "the question to research"},
                      "fetch_top": {"type": "integer", "description": "pages to read, default 3"},
                      "max_chars_per_page": {"type": "integer", "description": "default 8000"}},
       "required": ["query"]})
async def research_tool(args) -> dict:
    try:
        return _reply(await _research(args["query"], int(args.get("fetch_top") or 3),
                                      int(args.get("max_chars_per_page") or 8000)))
    except Exception as e:
        return _failed(e)


@tool("search_images", "Image search. Returns direct image URLs, thumbnails and the page "
                       "each came from.",
      {"type": "object",
       "properties": {"query": {"type": "string", "description": "what to look for"},
                      "max_results": {"type": "integer", "description": "default 12"}},
       "required": ["query"]})
async def search_images_tool(args) -> dict:
    try:
        return _reply(await _search_images(args["query"], int(args.get("max_results") or 12)))
    except Exception as e:
        return _failed(e)


def server():
    """The MCP server, running inside this process — no second runtime to install and no
    child process to supervise."""
    return create_sdk_mcp_server(
        name="web", version="1.0.0",
        tools=[search_tool, read_url_tool, research_tool, search_images_tool])
