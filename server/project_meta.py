"""Machine-readable project metadata (`.project.json`).

`context.md` stays the narrative contract between sessions, but some facts are
needed by the code rather than by the model: the client (for themes and
knowledge lookups) and above all the project **source**, which decides what the
brief actually is.

    source = "brief"      the client (or the functional team) hands us a
                          finished brief: it is an INPUT document, read-only
    source = "discovery"  we start from meeting transcripts and write the brief
                          ourselves: it is a DELIVERABLE (`brief.json`), with a
                          draft, a confirmation and a Word export

This is not cosmetic: it changes which skills make sense, where the brief shows
up in the document bar, and whether `brief.json` is validated or ignored.
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

META_FILE = ".project.json"

SOURCES = ("brief", "discovery")

# Projects created before the source field existed: they all had an input brief.
DEFAULT_SOURCE = "brief"


def meta_path(project_dir: Path) -> Path:
    return project_dir / META_FILE


def _client_from_context(project_dir: Path) -> str:
    """Client name as written in context.md, for projects created before
    .project.json existed."""
    ctx = project_dir / "context.md"
    if not ctx.is_file():
        return ""
    m = re.search(r"^-\s*Client:\s*(.+)$", ctx.read_text(encoding="utf-8"), re.MULTILINE)
    return m.group(1).strip() if m else ""


def load(project_dir: Path) -> dict:
    """Project metadata. If the file is missing it is rebuilt and written back, so
    old projects migrate themselves on first access instead of leaving
    compatibility code scattered across the rest of the backend."""
    f = meta_path(project_dir)
    if f.is_file():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        if data.get("source") in SOURCES:
            return data
    data = {
        "name": project_dir.name,
        "client": _client_from_context(project_dir),
        "source": DEFAULT_SOURCE,
        "created": date.today().isoformat(),
    }
    if project_dir.is_dir():
        # The migration write-back is for a project that already exists on disk but
        # predates .project.json — save() does not create the directory, so a project
        # that does not exist yet (or does not exist at all) used to raise
        # FileNotFoundError here instead of just handing back the defaults.
        save(project_dir, data)
    return data


def save(project_dir: Path, data: dict) -> None:
    meta_path(project_dir).write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def create(project_dir: Path, name: str, client: str, source: str) -> dict:
    data = {"name": name, "client": client, "source": source,
            "created": date.today().isoformat()}
    save(project_dir, data)
    return data


def source(project_dir: Path) -> str:
    return load(project_dir).get("source", DEFAULT_SOURCE)


def client(project_dir: Path) -> str:
    return load(project_dir).get("client", "")
