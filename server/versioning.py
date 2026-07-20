"""Versioning of the key project files (inputs and deliverables).

Before every chat turn a snapshot is taken of the files that changed, into
projects/{name}/.versions/ ({stem}.v{N}.{ext}). That way a regeneration never
loses the previous version and can always be rolled back.
"""
import hashlib
import shutil

from .config import PROJECTS_DIR


def deliverable_files(project: str) -> list[str]:
    """Files we keep history for. Exports (xlsx, drawio, html) are not here: they
    are regenerated from the JSON whenever needed, so versioning them would just
    be noise."""
    return ["context.md",
            # the brief can be an input document (in any format) or the
            # deliverable we write ourselves: keep history either way
            "brief.md", "brief.pdf", "brief.docx", "brief.txt", "brief.json",
            "estimate.json", "data_model.json", "mockup.json", "timeline.json",
            "questions.json", "people.json", "test_plan.json", "deck.json"]


def _vdir(project: str):
    return PROJECTS_DIR / project / ".versions"


def _versions_of(project: str, fname: str) -> list[tuple[int, object]]:
    stem, ext = fname.rsplit(".", 1)
    vd = _vdir(project)
    out = []
    if vd.is_dir():
        for f in vd.iterdir():
            if f.name.startswith(f"{stem}.v") and f.name.endswith(f".{ext}"):
                try:
                    n = int(f.name[len(stem) + 2:-(len(ext) + 1)])
                except ValueError:
                    continue
                out.append((n, f))
    return sorted(out)


def snapshot(project: str) -> None:
    """Save a version of every key file that changed since the last snapshot."""
    d = PROJECTS_DIR / project
    if not d.is_dir():
        return
    for fname in deliverable_files(project):
        src = d / fname
        if not src.is_file():
            continue
        content = src.read_bytes()
        vers = _versions_of(project, fname)
        if vers and hashlib.sha256(vers[-1][1].read_bytes()).digest() == \
                hashlib.sha256(content).digest():
            continue
        _vdir(project).mkdir(exist_ok=True)
        stem, ext = fname.rsplit(".", 1)
        n = vers[-1][0] + 1 if vers else 1
        (_vdir(project) / f"{stem}.v{n}.{ext}").write_bytes(content)


def list_versions(project: str) -> dict:
    res = {}
    for fname in deliverable_files(project):
        vers = _versions_of(project, fname)
        if vers:
            res[fname] = [{"v": n, "file": f".versions/{f.name}",
                           "ts": f.stat().st_mtime} for n, f in vers]
    return res


def restore(project: str, fname: str, v: int) -> None:
    if fname not in deliverable_files(project):
        raise FileNotFoundError(fname)
    stem, ext = fname.rsplit(".", 1)
    src = _vdir(project) / f"{stem}.v{v}.{ext}"
    if not src.is_file():
        raise FileNotFoundError(fname)
    snapshot(project)   # the current state becomes a version before it is overwritten
    shutil.copy2(src, PROJECTS_DIR / project / fname)
