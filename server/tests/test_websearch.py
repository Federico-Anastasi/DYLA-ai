"""The web search: parsers, merging, and reading a page.

These run against recorded HTML, never the network. A test that queries DuckDuckGo fails
the day DuckDuckGo is slow, and then nobody trusts the suite. What the fixtures cannot
tell us is whether the engines still serve this markup — that is what the parsers are
expected to outlive, and when one breaks it breaks in the open, with the other two
carrying the search.

Run: python -m pytest server/tests/test_websearch.py
"""
import socket

import httpx
import pytest

from server import websearch

DDG_HTML = """
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvetsoftware.co.uk%2Fpricing&amp;rut=x">Vet Software Pricing</a>
  <div class="result__snippet">Plans for small practices.</div>
</div>
<div class="result">
  <a class="result__a" href="https://direct.example.com/page">A direct link</a>
  <div class="result__snippet">No redirect wrapper here.</div>
</div>
"""

BRAVE_HTML = """
<div data-type="web" class="svelte-abc123">
  <a href="https://vetsoftware.co.uk/pricing/"><div class="title">Vet Software Pricing</div></a>
  <div class="snippet-content">Plans for small practices, billed yearly.</div>
</div>
<div data-type="web" class="svelte-abc123">
  <a href="https://other.example.org/x"><div class="title">Something else</div></a>
  <div class="snippet-content">Unrelated.</div>
</div>
"""

STARTPAGE_HTML = """
<div class="result">
  <a href="https://www.startpage.com/anon/proxy?u=1">Anonymous View</a>
  <a href="https://vetsoftware.co.uk/pricing"><style>.x{color:red}</style>Vet Software Pricing</a>
  <p>Plans for small practices.</p>
</div>
"""


def _canned(pages: dict):
    """Serves recorded HTML by URL fragment, and raises for anything else — so a test
    that would have hit the network fails loudly instead of quietly going online."""
    async def fake_get(url, accept="text/html,*/*", ua=None):
        for fragment, html in pages.items():
            if fragment in url:
                return html
        raise AssertionError(f"unexpected request: {url}")
    return fake_get


@pytest.mark.asyncio
async def test_duckduckgo_unwraps_the_redirect(monkeypatch):
    """Every DDG link is wrapped in a redirect. Handing those to the model means it reads
    duckduckgo.com instead of the page."""
    monkeypatch.setattr(websearch, "_get", _canned({"duckduckgo": DDG_HTML}))
    rows = await websearch._duckduckgo("vet software")
    assert rows[0]["url"] == "https://vetsoftware.co.uk/pricing"
    assert rows[0]["title"] == "Vet Software Pricing"
    assert rows[1]["url"] == "https://direct.example.com/page", "a plain link stays as it is"


@pytest.mark.asyncio
async def test_startpage_titles_do_not_come_out_full_of_css(monkeypatch):
    """Startpage inlines <style> inside its anchors: read the text without stripping it
    first and the title arrives as '.x{color:red}Vet Software Pricing'."""
    monkeypatch.setattr(websearch, "_get", _canned({"startpage": STARTPAGE_HTML}))
    rows = await websearch._startpage("vet software")
    assert rows[0]["title"] == "Vet Software Pricing"
    assert "color:red" not in rows[0]["title"]


@pytest.mark.asyncio
async def test_startpage_skips_the_anonymous_view_link(monkeypatch):
    """The first anchor in a result is Startpage's own proxy, not the result."""
    monkeypatch.setattr(websearch, "_get", _canned({"startpage": STARTPAGE_HTML}))
    rows = await websearch._startpage("vet software")
    assert "startpage.com" not in rows[0]["url"]


@pytest.mark.asyncio
async def test_a_page_found_by_every_engine_ranks_first(monkeypatch):
    """Agreement between independent engines is the only quality signal we have."""
    monkeypatch.setattr(websearch, "_get", _canned({
        "duckduckgo": DDG_HTML, "brave": BRAVE_HTML, "startpage": STARTPAGE_HTML}))
    out = await websearch._search("vet software", max_results=5)
    first = out["results"][0]
    assert set(first["engines"]) == {"duckduckgo", "brave", "startpage"}
    assert first["url"].startswith("https://vetsoftware.co.uk/pricing")


@pytest.mark.asyncio
async def test_the_same_page_is_not_listed_three_times(monkeypatch):
    """The three engines return the same URL with different trailing slashes and tracking
    parameters; without canonicalisation the model reads one page three times."""
    monkeypatch.setattr(websearch, "_get", _canned({
        "duckduckgo": DDG_HTML, "brave": BRAVE_HTML, "startpage": STARTPAGE_HTML}))
    out = await websearch._search("vet software", max_results=10)
    canonical = [websearch._canon(r["url"]) for r in out["results"]]
    assert len(canonical) == len(set(canonical))


@pytest.mark.asyncio
async def test_one_broken_engine_does_not_break_the_search(monkeypatch):
    """This is why there are three. A scraper dies when a site changes its markup, and
    that must cost coverage, not the feature."""
    async def half_broken(url, accept="text/html,*/*", ua=None):
        if "brave" in url:
            raise RuntimeError("markup changed")
        return DDG_HTML if "duckduckgo" in url else STARTPAGE_HTML
    monkeypatch.setattr(websearch, "_get", half_broken)
    out = await websearch._search("vet software", max_results=5)
    assert out["results"], "the surviving engines still answer"
    assert "failed" in out["source"], "and the failure is stated, not hidden"


@pytest.mark.asyncio
async def test_every_engine_failing_is_an_error(monkeypatch):
    """Returning an empty list would read as 'nothing found', which is a different fact."""
    async def all_broken(url, accept="text/html,*/*", ua=None):
        raise RuntimeError("no network")
    monkeypatch.setattr(websearch, "_get", all_broken)
    with pytest.raises(RuntimeError, match="every engine failed"):
        await websearch._search("vet software")


@pytest.mark.asyncio
async def test_reading_a_page_strips_the_furniture(monkeypatch):
    article = """<html><head><title>Vaccination reminders</title></head><body>
      <nav>Home About Contact</nav>
      <article><h1>Vaccination reminders</h1>
      <p>%s</p></article>
      <footer>Copyright 2026</footer></body></html>""" % ("Reminders go out monthly. " * 40)
    monkeypatch.setattr(websearch, "_get", _canned({"example.com": article}))
    out = await websearch._read_url("https://example.com/post")
    assert "Reminders go out monthly" in out
    assert "source: https://example.com/post" in out
    assert "Copyright 2026" not in out


@pytest.mark.asyncio
async def test_a_short_page_still_comes_back(monkeypatch):
    """Readability is built for articles and gives up on reference pages, indexes and
    listings — which are often exactly the pages worth reading. Falling back to the body
    is noisier than failing, and far more useful."""
    page = "<html><head><title>Index</title></head><body><ul><li>Chapter one</li></ul></body></html>"
    monkeypatch.setattr(websearch, "_get", _canned({"example.com": page}))
    out = await websearch._read_url("https://example.com/index")
    assert "Chapter one" in out


@pytest.mark.asyncio
async def test_long_pages_say_they_were_cut(monkeypatch):
    """Silent truncation reads as 'that is all there was'."""
    page = "<html><body><article><p>%s</p></article></body></html>" % ("word " * 5000)
    monkeypatch.setattr(websearch, "_get", _canned({"example.com": page}))
    out = await websearch._read_url("https://example.com/long", max_chars=500)
    assert "CUT at 500" in out


@pytest.mark.asyncio
async def test_research_reads_one_page_per_domain(monkeypatch):
    """Three pages of one site is one point of view. Distinct domains is the whole
    reason to prefer research over search."""
    same_site = "\n".join(
        f'<div class="result"><a class="result__a" href="https://one.example.com/p{i}">Page {i}</a>'
        f'<div class="result__snippet">s</div></div>' for i in range(3))
    other = ('<div class="result"><a class="result__a" href="https://two.example.org/a">Other</a>'
             '<div class="result__snippet">s</div></div>')
    article = "<html><body><article><p>%s</p></article></body></html>" % ("content " * 100)

    async def fake_get(url, accept="text/html,*/*", ua=None):
        if "duckduckgo" in url:
            return same_site + other
        if "brave" in url or "startpage" in url:
            raise RuntimeError("not needed for this test")
        return article
    monkeypatch.setattr(websearch, "_get", fake_get)

    out = await websearch._research("anything", fetch_top=3)
    hosts = [r["url"].split("/")[2] for r in out["pages"]]
    assert len(hosts) == len(set(hosts)), "one page per domain"


@pytest.mark.asyncio
async def test_research_skips_a_page_it_cannot_read(monkeypatch):
    """An anti-bot page that comes back nearly empty must not take one of the slots and
    hand the model '[unreadable]' — the next candidate takes its place."""
    results = "".join(
        f'<div class="result"><a class="result__a" href="https://s{i}.example.com/p">P{i}</a>'
        f'<div class="result__snippet">s</div></div>' for i in range(3))
    article = "<html><body><article><p>%s</p></article></body></html>" % ("content " * 100)

    async def fake_get(url, accept="text/html,*/*", ua=None):
        if "duckduckgo" in url:
            return results
        if "brave" in url or "startpage" in url:
            raise RuntimeError("not needed")
        if "s0.example.com" in url:
            return "<html><body>blocked</body></html>"  # too short to be real content
        return article
    monkeypatch.setattr(websearch, "_get", fake_get)

    out = await websearch._research("anything", fetch_top=2)
    assert len(out["pages"]) == 2
    assert all("s0.example.com" not in p["url"] for p in out["pages"])


# --- _get must never land somewhere private, whatever the model handed it -----------

def test_assert_public_url_rejects_non_http_schemes():
    with pytest.raises(websearch.UnsafeURL):
        websearch._assert_public_url("ftp://example.com/file")
    with pytest.raises(websearch.UnsafeURL):
        websearch._assert_public_url("file:///etc/passwd")


def test_assert_public_url_rejects_loopback_private_and_link_local_addresses():
    """Plain IP literals resolve locally (no DNS query), so this is offline and
    deterministic: 127.0.0.1 (loopback), a 10.x address (private), and the cloud metadata
    endpoint at 169.254.169.254 (link-local) must all be refused."""
    for bad in ("http://127.0.0.1/", "http://10.1.2.3/admin",
                "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data"):
        with pytest.raises(websearch.UnsafeURL):
            websearch._assert_public_url(bad)


def test_assert_public_url_accepts_a_plain_public_address():
    websearch._assert_public_url("http://8.8.8.8/")  # must not raise


def test_assert_public_url_rejects_a_host_that_does_not_resolve(monkeypatch):
    def fail(*a, **k):
        raise socket.gaierror("nope")
    monkeypatch.setattr(websearch.socket, "getaddrinfo", fail)
    with pytest.raises(websearch.UnsafeURL):
        websearch._assert_public_url("http://this-host-does-not-resolve.invalid/")


class _FakeResponse:
    """Minimal stand-in for httpx.Response as used through `client.stream(...)`."""

    def __init__(self, status_code=200, headers=None, body=b"", encoding="utf-8"):
        self.status_code = status_code
        self.headers = headers or {}
        self._body = body
        self.encoding = encoding

    @property
    def is_redirect(self):
        return self.status_code in (301, 302, 303, 307, 308)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=None, response=self)

    async def aiter_bytes(self):
        yield self._body


class _FakeStreamCtx:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *a):
        return False


def _fake_async_client(responses):
    """Replaces httpx.AsyncClient: `.stream(...)` returns the next response in
    `responses`, in order, and records every URL it was asked for."""
    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            calls.append(url)
            return _FakeStreamCtx(responses.pop(0))

    _Client.calls = calls
    return _Client


@pytest.mark.asyncio
async def test_get_refuses_to_follow_a_redirect_into_a_private_address(monkeypatch):
    """httpx's own follow_redirects would check only the first URL and then go wherever
    the server points it — a public page redirecting to 127.0.0.1 used to sail straight
    through."""
    client_cls = _fake_async_client([
        _FakeResponse(302, {"location": "http://127.0.0.1/admin"}),
    ])
    monkeypatch.setattr(websearch.httpx, "AsyncClient", client_cls)
    with pytest.raises(websearch.UnsafeURL):
        await websearch._get("http://8.8.8.8/start")
    assert client_cls.calls == ["http://8.8.8.8/start"], "must never even request the private hop"


@pytest.mark.asyncio
async def test_get_rejects_a_non_text_content_type(monkeypatch):
    """A link to a video or an ISO must not be read into memory just to be thrown away."""
    client_cls = _fake_async_client([
        _FakeResponse(200, {"content-type": "video/mp4"}, body=b"binary"),
    ])
    monkeypatch.setattr(websearch.httpx, "AsyncClient", client_cls)
    with pytest.raises(websearch.UnsafeURL, match="content-type"):
        await websearch._get("http://8.8.8.8/movie.mp4")


@pytest.mark.asyncio
async def test_get_rejects_a_response_over_the_size_cap(monkeypatch):
    monkeypatch.setattr(websearch, "MAX_BODY_BYTES", 10)
    client_cls = _fake_async_client([
        _FakeResponse(200, {"content-type": "text/html"}, body=b"0123456789ABCDEF"),
    ])
    monkeypatch.setattr(websearch.httpx, "AsyncClient", client_cls)
    with pytest.raises(websearch.UnsafeURL, match="exceeds"):
        await websearch._get("http://8.8.8.8/huge-page")


# --- a broken page must not take the whole read (or search) down with it ------------

def test_extract_falls_back_to_plain_text_if_markdownify_itself_fails(monkeypatch):
    """Readability gives up on indexes and listings — exactly the kind of page irregular
    enough that markdownify can choke on the fallback too. It used to be the one call in
    this function with no try/except around it."""
    def boom(*a, **k):
        raise ValueError("markdownify choked")
    monkeypatch.setattr(websearch, "markdownify", boom)
    title, text = websearch._extract(
        "<html><head><title>Index</title></head><body><p>Hello there</p></body></html>",
        "https://example.com/index")
    assert "Hello there" in text


@pytest.mark.asyncio
async def test_research_skips_a_candidate_that_fails_for_a_non_network_reason(monkeypatch):
    """Before this, _research only caught (httpx.HTTPError, RuntimeError, ValueError): a
    parsing failure of a different type used to abort the WHOLE search instead of just
    skipping that one candidate."""
    results = "".join(
        f'<div class="result"><a class="result__a" href="https://s{i}.example.com/p">P{i}</a>'
        f'<div class="result__snippet">s</div></div>' for i in range(2))
    article = "<html><body><article><p>%s</p></article></body></html>" % ("content " * 100)

    async def fake_get(url, accept="text/html,*/*", ua=None):
        if "duckduckgo" in url:
            return results
        if "brave" in url or "startpage" in url:
            raise RuntimeError("not needed for this test")
        if "s0.example.com" in url:
            raise KeyError("not a network error, but must not kill the whole search")
        return article
    monkeypatch.setattr(websearch, "_get", fake_get)

    out = await websearch._research("anything", fetch_top=1)
    assert len(out["pages"]) == 1
    assert "s0.example.com" not in out["pages"][0]["url"]


def test_the_tools_are_registered():
    """The names the model will call. Renaming one silently is a tool that stops
    existing mid-conversation."""
    srv = websearch.server()
    assert srv is not None
