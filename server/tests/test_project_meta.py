"""Tests for server/project_meta.py: reading and migrating .project.json.

Run with: python -m pytest server/tests/test_project_meta.py
"""
from pathlib import Path

from server import project_meta


def test_load_migrates_an_old_project_and_writes_the_file_back(tmp_path):
    """Projects created before .project.json existed all had an input brief: load()
    rebuilds the file so the rest of the backend never has to special-case them."""
    project = tmp_path / "legacy"
    project.mkdir()
    (project / "context.md").write_text("- Client: Acme\n", encoding="utf-8")

    data = project_meta.load(project)

    assert data["source"] == project_meta.DEFAULT_SOURCE
    assert data["client"] == "Acme"
    assert (project / project_meta.META_FILE).is_file()


def test_load_returns_defaults_for_a_project_that_does_not_exist_yet():
    """save() does not create directories: load() on a project folder that is not there
    (yet, or at all) used to raise FileNotFoundError instead of just answering with the
    defaults it would otherwise write back."""
    missing = Path("this/does/not/exist/on/disk")
    data = project_meta.load(missing)
    assert data["source"] == project_meta.DEFAULT_SOURCE
    assert data["name"] == "disk"  # Path.name of the (nonexistent) directory
    assert not missing.exists(), "must not have been created as a side effect"


def test_load_reads_back_what_it_wrote(tmp_path):
    project = tmp_path / "p"
    project.mkdir()
    written = project_meta.create(project, "p", "Acme", "discovery")
    assert project_meta.load(project) == written


def test_source_and_client_helpers(tmp_path):
    project = tmp_path / "p"
    project.mkdir()
    project_meta.create(project, "p", "Acme", "discovery")
    assert project_meta.source(project) == "discovery"
    assert project_meta.client(project) == "Acme"
