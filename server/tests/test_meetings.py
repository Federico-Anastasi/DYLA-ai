"""From a recording to a transcript in `meetings/`.

Whisper does not run in the tests: it is slow and would pull down 3 GB of model. What
needs guarding is not the quality of the transcription (that is not ours) but everything
around it, where the mistakes would be ours: where the file lands, how overwrites are
avoided, what is left on disk after confirmation, and that one bad job does not kill the
worker.

Run with: python -m pytest server/tests/test_meetings.py
"""
import io

import pytest
from fastapi.testclient import TestClient

from server import config, main, meetings, transcription


@pytest.fixture
def project(tmp_path, monkeypatch):
    """An empty project inside a temporary folder."""
    projects = tmp_path / "projects"
    (projects / "acme").mkdir(parents=True)
    monkeypatch.setattr(main, "PROJECTS_DIR", projects)
    monkeypatch.setattr(config, "PROJECTS_DIR", projects)
    meetings.reset()
    return projects / "acme"


@pytest.fixture
def client(project):
    return TestClient(main.app)


@pytest.fixture
def fake_whisper(monkeypatch):
    """Replaces the real transcription. Returns the list of calls made."""
    calls = []

    def fake(path, language="en", profile="meeting", progress=None, interrupted=None):
        calls.append(str(path))
        if progress:
            progress(0.5)
            progress(1.0)
        return "[00:00] Good morning.\n[00:04] Let's start with the reconciliation."

    monkeypatch.setattr(transcription, "transcribe_with_timestamps", fake)
    return calls


def _upload(client, name="meeting.m4a", **fields):
    return client.post("/api/projects/acme/transcriptions",
                       files={"audio": (name, io.BytesIO(b"fake-audio"), "audio/mp4")},
                       data=fields)


def _wait(client, job_id, expected="done", rounds=200):
    """The job runs on another thread: we wait for it to get to the end."""
    import time
    for _ in range(rounds):
        jobs = client.get("/api/projects/acme/transcriptions").json()["jobs"]
        job = next(j for j in jobs if j["id"] == job_id)
        if job["status"] == expected:
            return job
        time.sleep(0.02)
    pytest.fail(f"job stuck in state '{job['status']}', expected '{expected}'")


# --- file names ---

@pytest.mark.parametrize("text,expected", [
    ("Kick-off Booking Portal", "kick-off-booking-portal"),
    ("Meeting because yes", "meeting-because-yes"),
    ("  multiple   spaces  ", "multiple-spaces"),
    ("!!!", "meeting"),  # no usable character: we do not produce an empty name
])
def test_slug(text, expected):
    assert meetings.slug(text) == expected


@pytest.mark.parametrize("filename,expected", [
    ("2026-07-20 Weekly status.m4a", "Weekly status"),
    ("20260720_kickoff_acme.mp3", "kickoff acme"),
    ("recording.wav", "recording"),
])
def test_title_from_filename(filename, expected):
    """The file name is almost always the title already: the leading date has to go."""
    assert meetings._title_from_file(filename) == expected


# --- meetings are transcribed in the user's chosen language, not hard-coded English ---

def test_the_language_preference_reaches_the_transcription(client, project, monkeypatch):
    """transcribe_with_timestamps used to be called with no language argument at all,
    which meant its own default ("en") decided — every meeting was transcribed as
    English regardless of the user's language preference."""
    from server import preferences

    captured = {}

    def fake(path, language=None, profile="meeting", progress=None, interrupted=None):
        captured["language"] = language
        return "[00:00] Buongiorno."
    monkeypatch.setattr(transcription, "transcribe_with_timestamps", fake)
    monkeypatch.setattr(preferences, "whisper_language", lambda: "it")

    job_id = _upload(client, "riunione.m4a").json()["id"]
    _wait(client, job_id)
    assert captured["language"] == "it"


# --- a job belongs to one project ---------------------------------------------

def test_cancel_cannot_touch_a_job_from_another_project(client, project, fake_whisper, monkeypatch):
    (project.parent / "beta").mkdir()
    job_id = _upload(client, "meeting.m4a").json()["id"]
    r = client.post(f"/api/projects/beta/transcriptions/{job_id}/cancel")
    assert r.status_code == 404


def test_confirm_cannot_touch_a_job_from_another_project(client, project, fake_whisper):
    (project.parent / "beta").mkdir()
    job_id = _upload(client, "meeting.m4a").json()["id"]
    _wait(client, job_id)
    r = client.post(f"/api/projects/beta/transcriptions/{job_id}/confirm")
    assert r.status_code == 409  # "not found" surfaces as MeetingError -> 409 on this route
    # And it is still confirmable from its own project — nothing about it was corrupted.
    assert client.post(f"/api/projects/acme/transcriptions/{job_id}/confirm").status_code == 200


def test_discard_cannot_touch_a_job_from_another_project(client, project, fake_whisper):
    (project.parent / "beta").mkdir()
    job_id = _upload(client, "meeting.m4a").json()["id"]
    r = client.delete(f"/api/projects/beta/transcriptions/{job_id}")
    assert r.status_code == 404
    assert meetings.read(job_id, "acme").id == job_id, "the job is untouched"


# --- _jobs must not grow forever -----------------------------------------------

def test_prune_removes_only_finished_jobs_past_the_cap(monkeypatch):
    meetings.reset()
    monkeypatch.setattr(meetings, "MAX_JOBS", 3)
    for i in range(1, 5):
        meetings._jobs[f"t{i}"] = meetings.Job(id=f"t{i}", project="acme", title="x",
                                                date="2026-07-20", audio="", status="done")
    # A job still running must never be evicted just for the dict being over the cap.
    meetings._jobs["t5"] = meetings.Job(id="t5", project="acme", title="x",
                                        date="2026-07-20", audio="", status="running")
    meetings._prune()
    assert set(meetings._jobs) == {"t3", "t4", "t5"}, "oldest finished jobs go first"


# --- lifecycle ---

def test_the_transcript_lands_in_meetings(client, project, fake_whisper):
    r = _upload(client, "kickoff.m4a", title="Kick-off Acme", date="2026-07-20")
    assert r.status_code == 202
    job = _wait(client, r.json()["id"])

    assert job["file"] == "meetings/2026-07-20-kick-off-acme.md"
    text = (project / job["file"]).read_text(encoding="utf-8")
    assert "# Meeting — Kick-off Acme" in text
    assert "[00:04] Let's start with the reconciliation." in text
    # The header has to say how the file came about: whoever reads the transcript in six
    # months must not mistake a model's output for minutes somebody wrote.
    assert "large-v3" in text and "Speakers are not separated" in text


def test_the_audio_is_kept_until_confirmation(client, project, fake_whisper):
    r = _upload(client, "status.mp3", title="Status", date="2026-07-20")
    job = _wait(client, r.json()["id"])
    audio = project / job["audio"]
    assert audio.is_file(), "the audio is what lets you check the doubtful passages"

    confirm = client.post(f"/api/projects/acme/transcriptions/{job['id']}/confirm")
    assert confirm.status_code == 200
    assert not audio.exists(), "once the transcript is confirmed the audio is dead weight"
    assert (project / job["file"]).is_file()


def test_discarding_takes_everything_with_it(client, project, fake_whisper):
    r = _upload(client, "wrong.wav")
    job = _wait(client, r.json()["id"])
    client.delete(f"/api/projects/acme/transcriptions/{job['id']}")
    assert not (project / job["audio"]).exists()
    assert not (project / job["file"]).exists()
    assert client.get("/api/projects/acme/transcriptions").json()["jobs"] == []


def test_two_meetings_same_day_same_title(client, project, fake_whisper):
    """Two status meetings on the same day must not overwrite each other."""
    first = _wait(client, _upload(client, "a.m4a", title="Status", date="2026-07-20").json()["id"])
    second = _wait(client, _upload(client, "b.m4a", title="Status", date="2026-07-20").json()["id"])
    assert first["file"] == "meetings/2026-07-20-status.md"
    assert second["file"] == "meetings/2026-07-20-status-2.md"
    assert first["audio"] != second["audio"]


def test_a_transcript_is_a_project_document(client, fake_whisper):
    """It has to show up among the documents (that is where /meeting finds it); the audio
    must not: that is working material, not a document of the project."""
    job = _wait(client, _upload(client, "x.m4a", title="Discovery", date="2026-07-20").json()["id"])
    docs = client.get("/api/projects/acme/documents").json()
    files = [d["file"] for d in docs]
    assert job["file"] in files
    assert not any(f.startswith(".audio") for f in files)


# --- errors ---

def test_a_non_audio_format_is_rejected(client):
    r = _upload(client, "notes.docx")
    assert r.status_code == 400
    assert "unsupported audio format" in r.json()["detail"]


def test_an_invalid_date_is_rejected(client):
    assert _upload(client, "a.m4a", date="20 July").status_code == 400


def test_silence_is_an_error_not_an_empty_file(client, project, monkeypatch):
    monkeypatch.setattr(transcription, "transcribe_with_timestamps", lambda *a, **k: "   ")
    job = _wait(client, _upload(client, "silent.m4a").json()["id"], expected="error")
    assert "no speech recognised" in job["error"]
    assert not (project / "meetings").exists(), "no speech, no file"


def _fake_ok(path, language="en", profile="meeting", progress=None, interrupted=None):
    return "[00:00] The worker is alive."


def test_a_missing_model_does_not_kill_the_worker(client, monkeypatch):
    """A job that blows up must not stop the ones after it from running: the queue has a
    single worker, and if it dies everything stops in silence."""
    def explode(*a, **k):
        raise transcription.TranscriptionUnavailable("model cannot be downloaded")

    monkeypatch.setattr(transcription, "transcribe_with_timestamps", explode)
    broken = _wait(client, _upload(client, "one.m4a").json()["id"], expected="error")
    assert "cannot be downloaded" in broken["error"]

    monkeypatch.setattr(transcription, "transcribe_with_timestamps", _fake_ok)
    ok = _wait(client, _upload(client, "two.m4a").json()["id"])
    assert ok["file"]


def test_cancelling_before_anything_is_written(client, project, monkeypatch):
    """Cancelling mid-transcription must not leave half a markdown file behind."""
    def slow(path, language="en", profile="meeting", progress=None, interrupted=None):
        import time
        for _ in range(100):
            if interrupted and interrupted():
                break
            time.sleep(0.01)
        return "[00:00] a half-written fragment"

    monkeypatch.setattr(transcription, "transcribe_with_timestamps", slow)
    job_id = _upload(client, "long.m4a").json()["id"]
    client.post(f"/api/projects/acme/transcriptions/{job_id}/cancel")
    job = _wait(client, job_id, expected="cancelled")
    assert job["file"] is None
    assert not (project / "meetings").exists()


def test_you_can_only_confirm_a_completed_job(client, project, monkeypatch):
    """Confirming means throwing the audio away. On a failed job that audio is the only
    thing left: deleting it would lose the recording."""
    monkeypatch.setattr(transcription, "transcribe_with_timestamps",
                        lambda *a, **k: "   ")  # no speech -> error
    job = _wait(client, _upload(client, "a.m4a").json()["id"], expected="error")

    r = client.post(f"/api/projects/acme/transcriptions/{job['id']}/confirm")
    assert r.status_code == 409
    assert (project / job["audio"]).is_file(), "the audio of a failed job stays put"


# --- transcription profiles ---

def test_meetings_use_the_big_model_and_do_not_stay_in_memory():
    """The choice the whole module rests on: high quality because nobody is waiting, and
    no 3 GB parked in RAM for something that happens once per meeting."""
    p = transcription.PROFILES["meeting"]
    assert p.model == "large-v3"
    assert p.resident is False


def test_the_agenda_uses_the_small_resident_model():
    p = transcription.PROFILES["note"]
    assert p.model == "small"
    assert p.resident is True


def test_unload_leaves_resident_models_alone(monkeypatch):
    monkeypatch.setitem(transcription._models, "small", object())
    monkeypatch.setitem(transcription._models, "large-v3", object())
    transcription.unload("meeting")
    assert "large-v3" not in transcription._models
    transcription.unload("note")
    assert "small" in transcription._models, "the resident profile stays loaded"
