"""From a meeting recording to a transcript in `meetings/`.

`/meeting` starts from a transcript, but until now nobody produced one: you reached
the skill holding an audio file and nothing to hand it. This module closes that gap.

## Why a job and not a request

Half an hour of audio with `large-v3` on CPU is tens of minutes: that does not fit in
an HTTP request, and it should not. You upload the file, the work starts in the
background, you come back when it is ready. It is exactly that asynchrony that lets us
pick the big model — whoever is not waiting does not pay for the wait (see
`transcription.py`).

## One job at a time

Jobs queue up on a single worker. Two `large-v3` transcriptions in parallel fight over
the same CPU and both finish later than they would have in a queue, with twice the RAM
taken.

## What survives what

Jobs live in memory: if the server restarts halfway through, the job is lost. The audio
is not — that is on disk — so you start over without having lost anything you cannot
get back. Persisting job state would not be worth the complexity.

The audio stays in `.audio/` (a hidden folder: outside `/files`, outside versioning and
outside the extracts) until the transcript is confirmed. It is the only way to check a
doubtful passage: without the original, an uncertain line stays uncertain forever. On
confirmation it is deleted — it is tens of MB per meeting.
"""
from __future__ import annotations

import queue
import re
import threading
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import preferences
from . import transcription

AUDIO_DIR = ".audio"
MEETINGS_DIR = "meetings"

# The formats we know how to open. Decoding is done by PyAV, which faster-whisper
# ships with the ffmpeg libraries inside: no separate ffmpeg install needed.
# The list is wider than what is really needed — better to accept than to explain.
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".opus", ".flac",
             ".wma", ".webm", ".amr", ".3gp", ".mkv", ".mov"}

PROFILE = "meeting"


class MeetingError(RuntimeError):
    """Usage error: unsupported format, missing job, wrong state."""


@dataclass
class Job:
    id: str
    project: str
    title: str
    date: str
    audio: str          # path relative to the project folder
    status: str = "queued"   # queued | running | done | error | cancelled
    progress: float = 0.0    # 0.0-1.0, measured against the audio running time
    file: str | None = None  # transcript produced, relative to the project
    error: str | None = None
    _stop: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self) -> dict:
        return {"id": self.id, "project": self.project, "title": self.title,
                "date": self.date, "audio": self.audio, "status": self.status,
                "progress": round(self.progress, 3), "file": self.file,
                "error": self.error}


_jobs: dict[str, Job] = {}
_queue: "queue.Queue[str]" = queue.Queue()
_lock = threading.Lock()
_worker: threading.Thread | None = None
_counter = 0

# _jobs lives in memory for as long as the process does (see the module docstring), and
# nothing used to take anything back out of it except discard() — confirm() marks a job
# done and clears its audio but leaves the entry sitting there forever. Over a server that
# stays up for weeks that is an unbounded dict. Only finished jobs are ever pruned: one
# still queued or running is never thrown away just for being old, that would silently
# orphan work in progress.
MAX_JOBS = 200


# --- file names ---

def slug(text: str) -> str:
    """Title -> a piece of a file name. Accents are dropped on purpose: these names
    end up in paths that travel between Windows, git and the browser."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = re.sub(r"[\s_-]+", "-", text).strip("-")
    return text[:60] or "meeting"


def _title_from_file(filename: str) -> str:
    """The file name is almost always the title already, just badly written."""
    stem = Path(filename or "").stem
    stem = re.sub(r"^\d{4}[-_]?\d{2}[-_]?\d{2}[\s_-]*", "", stem)  # leading date
    stem = re.sub(r"[_-]+", " ", stem).strip()
    return stem or "Meeting"


def _destination(d: Path, when: str, title: str) -> Path:
    """`meetings/YYYY-MM-DD-title.md`, never overwriting a transcript that already
    exists: two meetings on the same day about the same topic do happen."""
    folder = d / MEETINGS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    base = f"{when}-{slug(title)}"
    dest = folder / f"{base}.md"
    n = 2
    while dest.exists():
        dest = folder / f"{base}-{n}.md"
        n += 1
    return dest


def _header(title: str, when: str, audio: Path, duration_note: str) -> str:
    model = transcription.PROFILES[PROFILE].model
    return (
        f"# Meeting — {title}\n\n"
        f"- Date: {when}\n"
        f"- Source: automatic transcription of `{audio.name}`{duration_note}\n"
        f"- Model: faster-whisper `{model}`, running locally\n"
        f"- Speakers are not separated: names have to be attributed by hand\n\n"
        f"---\n\n"
    )


# --- queue ---

def _ensure_worker() -> None:
    global _worker
    if _worker is not None and _worker.is_alive():
        return
    _worker = threading.Thread(target=_loop, name="meeting-transcription", daemon=True)
    _worker.start()


def _loop() -> None:
    while True:
        job_id = _queue.get()
        try:
            job = _jobs.get(job_id)
            if job is not None and job.status == "queued":
                _run(job)
        finally:
            _queue.task_done()
            # The big model leaves memory as soon as the queue drains: keeping it
            # resident would cost 3 GB between one meeting and the next.
            if _queue.empty():
                transcription.unload(PROFILE)


def _run(job: Job) -> None:
    from .config import PROJECTS_DIR
    d = PROJECTS_DIR / job.project
    audio = d / job.audio
    job.status = "running"
    try:
        if not audio.is_file():
            raise MeetingError(f"audio not found: {job.audio}")

        def progress(fraction: float) -> None:
            job.progress = fraction

        text = transcription.transcribe_with_timestamps(
            audio, language=preferences.whisper_language(), profile=PROFILE,
            progress=progress, interrupted=job._stop.is_set)

        if job._stop.is_set():
            job.status = "cancelled"
            return
        if not text.strip():
            raise MeetingError("no speech recognised in the recording")

        dest = _destination(d, job.date, job.title)
        duration = _duration_note(audio)
        dest.write_text(_header(job.title, job.date, audio, duration) + text + "\n",
                        encoding="utf-8")
        job.file = str(dest.relative_to(d)).replace("\\", "/")
        job.status = "done"
    except transcription.TranscriptionUnavailable as e:
        job.status, job.error = "error", str(e)
    except Exception as e:  # the worker must not die over one bad job
        job.status, job.error = "error", f"{type(e).__name__}: {e}"


def _duration_note(audio: Path) -> str:
    mb = audio.stat().st_size / (1024 * 1024)
    return f" ({mb:.0f} MB)" if mb >= 1 else ""


# --- module API ---

def start(project: str, d: Path, filename: str, content, *,
          title: str | None = None, when: str | None = None) -> Job:
    """Saves the audio and queues the transcription. `content` is a file-like object."""
    import shutil

    ext = Path(filename or "").suffix.lower()
    if ext not in AUDIO_EXT:
        raise MeetingError(
            f"unsupported audio format: '{ext or filename}' "
            f"(expected: {', '.join(sorted(AUDIO_EXT))})")

    when = when or date.today().isoformat()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", when):
        raise MeetingError(f"invalid date: '{when}' (expected YYYY-MM-DD)")
    title = (title or "").strip() or _title_from_file(filename)

    folder = d / AUDIO_DIR
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{when}-{slug(title)}{ext}"
    n = 2
    while dest.exists():
        dest = folder / f"{when}-{slug(title)}-{n}{ext}"
        n += 1
    with dest.open("wb") as out:
        shutil.copyfileobj(content, out)

    global _counter
    with _lock:
        _counter += 1
        job = Job(id=f"t{_counter}", project=project, title=title, date=when,
                  audio=str(dest.relative_to(d)).replace("\\", "/"))
        _jobs[job.id] = job
        _prune()
        _ensure_worker()
    _queue.put(job.id)
    return job


def jobs(project: str) -> list[dict]:
    """A project's jobs, most recent first."""
    return [j.public() for j in reversed(list(_jobs.values()))
            if j.project == project]


def _prune() -> None:
    """Keeps _jobs from growing for the whole life of the process (see MAX_JOBS above).
    Called from start(), under _lock, so it only ever runs alongside another mutation."""
    if len(_jobs) <= MAX_JOBS:
        return
    finished = [jid for jid, j in _jobs.items() if j.status in ("done", "error", "cancelled")]
    finished.sort(key=lambda jid: int(jid[1:]))  # "t<n>": assigned in order, oldest first
    for jid in finished[:len(_jobs) - MAX_JOBS]:
        _jobs.pop(jid, None)


def read(job_id: str, project: str | None = None) -> Job:
    """The job, or MeetingError if it does not exist — or if `project` is given and does
    not match the job's own project: the route for project A must not be able to touch a
    job that belongs to project B, and answering "not found" rather than "not yours" does
    not leak whether the id exists elsewhere."""
    job = _jobs.get(job_id)
    if job is None or (project is not None and job.project != project):
        raise MeetingError(f"transcription '{job_id}' not found")
    return job


def cancel(job_id: str, project: str | None = None) -> Job:
    """Stops a job. If it has not started yet it leaves the queue; if it is running it
    stops at the next segment, writing nothing."""
    job = read(job_id, project)
    if job.status in ("done", "error", "cancelled"):
        return job
    job._stop.set()
    if job.status == "queued":
        job.status = "cancelled"
    return job


def confirm(job_id: str, project: str, d: Path) -> Job:
    """The transcript has been re-read and it is fine: the audio is no longer needed."""
    job = read(job_id, project)
    if job.status != "done":
        raise MeetingError("you confirm a completed transcription, not "
                           f"one in state '{job.status}'")
    (d / job.audio).unlink(missing_ok=True)
    job.audio = ""
    return job


def discard(job_id: str, project: str, d: Path) -> str:
    """Throws away the job, the audio and the transcript produced: the recording was
    wrong or the result unusable."""
    job = read(job_id, project)
    job._stop.set()
    if job.audio:
        (d / job.audio).unlink(missing_ok=True)
    if job.file:
        (d / job.file).unlink(missing_ok=True)
    _jobs.pop(job_id, None)
    return job_id


def reset() -> None:
    """Tests only: empties the job registry."""
    _jobs.clear()
