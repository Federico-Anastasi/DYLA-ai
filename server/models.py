"""Which model Dyla runs locally, and where it comes from.

Three ways a model gets here, and they are deliberately different in weight:

- **suggested** — the short list below. These are the ones we run ourselves, so we can
  say something honest about each. Downloaded from Hugging Face on request.
- **found** — any .gguf already sitting in the models folder. Someone who has been
  running local models for a while has a folder full of them and should not have to
  re-download anything to use one here.
- **added** — a file anywhere on disk, or any Hugging Face repo. This is the escape
  hatch that keeps the suggested list from being a cage: our recommendation is a
  starting point, not the boundary of what Dyla supports.

The chosen model is recorded in `runtime/models.json`, next to the user data, because
it describes this installation and not the project.
"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .config import RUNTIME_DIR

STATE_FILE = RUNTIME_DIR / "models.json"
HF_API = "https://huggingface.co/api/models/"

# Where downloaded models land when MODELS_DIR is not set. Keeping them under runtime/
# means they are already excluded from git and from backups.
DEFAULT_DIR = RUNTIME_DIR / "models"


class ModelError(RuntimeError):
    """The model cannot be fetched or is not where it was said to be."""


def file_id(path: Path | str) -> str:
    """A stable id for a file on disk.

    Not the path itself: these ids travel in URLs and JSON, and a Windows path carries
    backslashes and a drive colon that break both. A short digest of the path keeps it
    stable across restarts while staying safe to put anywhere."""
    digest = hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:12]
    return f"file:{digest}"


@dataclass
class Suggested:
    id: str
    label: str
    repo: str            # Hugging Face repository
    quant: str           # the fragment that picks one file among the repo's GGUFs
    size_gb: float
    needs_gb: int        # RAM or VRAM the thing wants to be comfortable in
    note: str            # when this one is the right choice — and when it is not
    mmproj: bool = False  # a separate projector file for images


# Kept short on purpose: a list of thirty models is a way of avoiding the question.
#
# Nothing below 12B. Smaller models demo well and then fall apart at the actual job,
# which is holding a document and a set of instructions in mind at the same time while
# producing something that validates against a schema. Suggesting them would be
# setting people up to conclude that local models do not work.
#
# Every size was read off the repository, not estimated: a download that turns out to
# be twice what was promised is how people stop trusting the rest of what you tell
# them.
#
# On quantisation: IQ4_NL rather than the more common IQ4_XS. Non-linear four-bit
# follows the actual distribution of the weights instead of assuming an even one, and
# on these repos it costs between nothing and three hundred megabytes. Once you have
# found room for seventeen gigabytes there is no reason to take the worse one. UD
# builds where unsloth provides them, for the same reason: better calibration at the
# same file size.
#
# All from unsloth's mirrors rather than the original vendors': the official Qwen GGUF
# repo is gated and answers 401 without a token, which would turn "click to download"
# into "go and make an account somewhere".
SUGGESTED: list[Suggested] = [
    Suggested(
        id="gemma4-12b",
        label="Gemma 4 12B",
        repo="unsloth/gemma-4-12b-it-GGUF",
        quant="Q4_K_M",
        size_gb=7.1,
        needs_gb=12,
        note="The smallest model worth putting inside a real workflow. Below this size "
             "they stop holding a document and a set of instructions in mind at the "
             "same time, which is the whole job here.",
    ),
    Suggested(
        id="gemma4-26b-a4b",
        label="Gemma 4 26B-A4B",
        repo="unsloth/gemma-4-26B-A4B-it-GGUF",
        quant="UD-IQ4_NL",
        size_gb=13.6,
        needs_gb=18,
        note="Mixture of experts: 26B of knowledge, 4B active per token, so it answers "
             "at the speed of a much smaller model. The best ratio of quality to "
             "hardware on this list.",
    ),
    Suggested(
        id="gemma4-31b",
        label="Gemma 4 31B",
        repo="unsloth/gemma-4-31B-it-GGUF",
        quant="IQ4_NL",
        size_gb=17.3,
        needs_gb=22,
        note="Dense, so every parameter works on every token: slower than the 26B "
             "mixture but steadier on long reasoning. Worth it if you have the memory "
             "and can wait.",
    ),
    Suggested(
        id="qwen36-35b-a3b",
        label="Qwen3.6 35B-A3B",
        repo="unsloth/Qwen3.6-35B-A3B-GGUF",
        quant="UD-IQ4_NL",
        size_gb=18.0,
        needs_gb=24,
        note="35B of knowledge with 3B active per token. This is the one we run: it is "
             "the model that made a local setup stop feeling like a compromise, and "
             "everything in Dyla is shaped around what it can do.",
    ),
    Suggested(
        id="qwen36-35b-a3b-mxfp4",
        label="Qwen3.6 35B-A3B (MXFP4)",
        repo="unsloth/Qwen3.6-35B-A3B-GGUF",
        quant="MXFP4_MOE",
        size_gb=21.7,
        needs_gb=28,
        note="The four-bit floating point format, built for mixtures of experts and "
             "the most faithful four-bit build in this repository. Worth the extra "
             "four gigabytes on a recent NVIDIA card, which runs it natively; on older "
             "hardware it is unpacked on the fly, so you pay the size without the "
             "speed.",
    ),
    Suggested(
        id="qwen36-35b-a3b-iq3",
        label="Qwen3.6 35B-A3B (compressed)",
        repo="unsloth/Qwen3.6-35B-A3B-GGUF",
        quant="UD-IQ3_XXS",
        size_gb=13.2,
        needs_gb=18,
        note="The same model at three bits per weight: four and a half gigabytes less, "
             "and it fits where the full one does not. Compression costs most on long "
             "careful answers, which is what you want this model for — but running it "
             "compressed beats not running it.",
    ),
]


def _state() -> dict:
    if not STATE_FILE.is_file():
        return {"active": None, "added": []}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"active": None, "added": []}


def _save(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def models_dir() -> Path:
    """Where the .gguf files live. MODELS_DIR when set — people who already collect
    models have a folder for them — otherwise ours."""
    import os
    env = os.environ.get("MODELS_DIR")
    return Path(env) if env else DEFAULT_DIR


def _found_on_disk() -> list[dict]:
    """Every .gguf in the models folder. Projector files are not models on their own,
    so they do not get listed as if they were."""
    d = models_dir()
    if not d.is_dir():
        return []
    return [
        {"id": file_id(p), "label": p.stem, "path": str(p),
         "size_gb": round(p.stat().st_size / 1e9, 1), "origin": "found"}
        for p in sorted(d.rglob("*.gguf")) if "mmproj" not in p.name.lower()
    ]


def catalog() -> dict:
    """Everything that can be picked, and what is already downloaded."""
    on_disk = {m["path"] for m in _found_on_disk()}
    suggested = []
    for s in SUGGESTED:
        path = models_dir() / s.repo.split("/")[-1] / f"{s.quant}.gguf"
        suggested.append({
            "id": s.id, "label": s.label, "repo": s.repo, "quant": s.quant,
            "size_gb": s.size_gb, "needs_gb": s.needs_gb, "note": s.note,
            "origin": "suggested",
            "path": str(path),
            "installed": str(path) in on_disk or path.is_file(),
        })
    state = _state()
    return {
        "suggested": suggested,
        "found": _found_on_disk(),
        "added": state.get("added", []),
        "active": state.get("active"),
        "models_dir": str(models_dir()),
    }


def active_path() -> str | None:
    """The .gguf the local profile should load, or None if nothing is chosen yet."""
    state = _state()
    chosen = state.get("active")
    if not chosen:
        return None
    for group in ("suggested", "found", "added"):
        for m in catalog()[group]:
            if m["id"] == chosen:
                path = m.get("path")
                return path if path and Path(path).is_file() else None
    return None


def set_active(model_id: str) -> str:
    """Chooses the model. It has to be on disk: pointing the engine at a file that is
    not there would fail later, at the first message, where the cause is invisible."""
    known = {m["id"]: m for group in ("suggested", "found", "added")
             for m in catalog()[group]}
    m = known.get(model_id)
    if not m:
        raise ModelError(f"unknown model: {model_id}")
    if not (m.get("path") and Path(m["path"]).is_file()):
        raise ModelError(f"'{m['label']}' is not downloaded yet")
    state = _state()
    state["active"] = model_id
    _save(state)
    return m["path"]


def add_local(path: str, label: str | None = None) -> dict:
    """Registers a .gguf the user already has, wherever it is on their disk."""
    p = Path(path).expanduser()
    if not p.is_file():
        raise ModelError(f"no file at {p}")
    if p.suffix.lower() != ".gguf":
        raise ModelError("a local model must be a .gguf file")
    entry = {"id": file_id(p), "label": label or p.stem, "path": str(p),
             "size_gb": round(p.stat().st_size / 1e9, 1), "origin": "added"}
    state = _state()
    state["added"] = [m for m in state.get("added", []) if m["id"] != entry["id"]]
    state["added"].append(entry)
    _save(state)
    return entry


def remove_added(model_id: str) -> None:
    """Forgets a model that was added by hand. The file itself is left alone: we did
    not put it there and it is not ours to delete."""
    state = _state()
    state["added"] = [m for m in state.get("added", []) if m["id"] != model_id]
    if state.get("active") == model_id:
        state["active"] = None
    _save(state)


# --- downloading from Hugging Face ---

def _repo_files(repo: str) -> list[dict]:
    try:
        with urllib.request.urlopen(HF_API + urllib.parse.quote(repo), timeout=30) as r:
            info = json.load(r)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        raise ModelError(f"cannot read the repository '{repo}': {e}") from e
    return [f for f in info.get("siblings", [])
            if f.get("rfilename", "").lower().endswith(".gguf")]


_SPLIT_GGUF_RE = re.compile(r"-\d{5}-of-\d{5}\.gguf$", re.IGNORECASE)


def _pick_file(files: list[dict], quant: str) -> str:
    """The file matching the wanted quantisation. Big models come split into parts —
    named "…-00001-of-00002.gguf" and so on — and we take the first one."""
    matching = [f["rfilename"] for f in files if quant.lower() in f["rfilename"].lower()]
    if not matching:
        raise ModelError(f"no '{quant}' file in this repository")
    return sorted(matching)[0]


def download(model_id: str, progress=None) -> str:
    """Fetches a suggested model. Returns the path of the file on disk."""
    s = next((x for x in SUGGESTED if x.id == model_id), None)
    if not s:
        raise ModelError(f"'{model_id}' is not one of the suggested models")

    filename = _pick_file(_repo_files(s.repo), s.quant)
    if _SPLIT_GGUF_RE.search(filename):
        # llama.cpp finds the other parts of a split GGUF by their exact sibling
        # filenames ("…-00001-of-00002.gguf" next to "…-00002-of-00002.gguf") — it does
        # NOT find them "by itself" the way the old comment here assumed. This code only
        # ever fetches the one file _pick_file returned and then renames it to
        # "{quant}.gguf", which throws away the "-00001-of-00002" suffix and never
        # downloads the remaining parts at all. set_active()'s is_file() check on that
        # renamed lone part passes, and the model dies at the first real message instead
        # of at download time, which is a much worse place to find out.
        raise ModelError(
            f"'{s.label}' is published as a split GGUF ({filename}) and this app cannot "
            "download and reassemble multi-part GGUF files yet. Download every part by "
            "hand (e.g. with huggingface-cli or hf_hub_download), keep the original "
            "filenames next to each other, and add the first part as a local model "
            "instead.")
    dest_dir = models_dir() / s.repo.split("/")[-1]
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{s.quant}.gguf"
    if dest.is_file():
        return str(dest)

    url = f"https://huggingface.co/{s.repo}/resolve/main/{urllib.parse.quote(filename)}"
    # Downloaded to a temporary name and renamed at the end: a half-finished file with
    # the right name would look installed and fail when loaded.
    tmp = dest.with_suffix(".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as r, tmp.open("wb") as out:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while chunk := r.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                if progress and total:
                    progress(min(1.0, done / total))
    except (urllib.error.URLError, OSError) as e:
        tmp.unlink(missing_ok=True)
        raise ModelError(f"download failed: {e}") from e
    tmp.replace(dest)
    if progress:
        progress(1.0)
    return str(dest)


# --- context size ---
#
# The context is the one setting that decides whether a model loads at all: the KV
# cache grows linearly with it, and it is allocated up front. Too big and llama-server
# dies on startup; too small and long documents stop fitting. Which value is right
# depends on the machine, so it cannot be a constant in a config file — and it is not
# something we can work out for the user either, because it also depends on what else
# they are running.

CONTEXT_CHOICES = [16384, 32768, 65536, 131072]

# Dyla drives the model through Claude Code, whose system prompt alone is around
# 27k tokens before your first word. Below 64k the conversation starts getting
# compacted almost immediately, which is why anything smaller is offered as a fallback
# rather than a choice: take it when the engine will not start otherwise.
RECOMMENDED_CONTEXT = 65536

# How much memory a context costs, in GB per 32k tokens, with the KV cache quantised
# to 8 bits. Measured, not derived: our own 17.7 GB model runs at 128k inside 23.6 GB
# of VRAM, so cache and compute buffers together take about 5.9 GB — 1.2 GB per 32k.
# The compute buffers are already inside that number, which is why nothing else gets
# added for them. It is a rough figure and meant to be: it decides which value to try
# first, not whether to trust the answer.
GB_PER_32K = 1.2

# A little room left over, because a machine is never doing only this.
OVERHEAD_GB = 0.5


def suggest_context(model_size_gb: float, available_gb: float) -> dict:
    """The largest context worth trying on this machine, and the one to fall back to.

    Deliberately approximate. The honest promise is not "this will fit" but "start
    here, and if the engine refuses to start, drop to the next one" — which is how
    people find the right value anyway, only without the guessing.
    """
    room = available_gb - model_size_gb - OVERHEAD_GB
    fits = [c for c in CONTEXT_CHOICES if (c / 32768) * GB_PER_32K <= room]
    if not fits:
        # Not even the smallest fits: the model itself is the problem, not the context.
        return {"try": CONTEXT_CHOICES[0], "fallback": None, "tight": True}
    best = max(fits)
    smaller = [c for c in CONTEXT_CHOICES if c < best]
    return {"try": best, "fallback": max(smaller) if smaller else None,
            "tight": best < RECOMMENDED_CONTEXT}


def context_size(default: int) -> int:
    """The context the user chose, or the platform default when they have not."""
    chosen = _state().get("context")
    return chosen if chosen in CONTEXT_CHOICES else default


def set_context(size: int) -> int:
    if size not in CONTEXT_CHOICES:
        raise ModelError(f"context must be one of {CONTEXT_CHOICES}")
    state = _state()
    state["context"] = size
    _save(state)
    return size
