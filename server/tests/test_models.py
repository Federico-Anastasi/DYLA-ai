"""Tests for server/models.py: picking and downloading a suggested GGUF.

Run with: python -m pytest server/tests/test_models.py
"""
import pytest

from server import models


def test_pick_file_takes_the_first_match_alphabetically():
    files = [{"rfilename": "model-UD-IQ4_NL-00002-of-00002.gguf"},
             {"rfilename": "model-UD-IQ4_NL-00001-of-00002.gguf"},
             {"rfilename": "model-Q8_0.gguf"}]
    assert models._pick_file(files, "UD-IQ4_NL") == "model-UD-IQ4_NL-00001-of-00002.gguf"


def test_pick_file_raises_when_nothing_matches():
    with pytest.raises(models.ModelError, match="no 'Q9_0' file"):
        models._pick_file([{"rfilename": "model-Q8_0.gguf"}], "Q9_0")


def test_download_refuses_a_split_gguf_instead_of_producing_a_broken_model(monkeypatch, tmp_path):
    """Downloading only fetches the ONE file _pick_file returns; renaming it to
    "{quant}.gguf" throws away the "-00001-of-00002" suffix llama.cpp needs to find the
    other parts, which are never downloaded at all. The model used to pass
    set_active()'s is_file() check and die at the first real message instead."""
    monkeypatch.setattr(models, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(models, "DEFAULT_DIR", tmp_path / "models")
    monkeypatch.setattr(models, "_repo_files", lambda repo: [
        {"rfilename": "Qwen3.6-35B-A3B-MXFP4_MOE-00001-of-00002.gguf"},
        {"rfilename": "Qwen3.6-35B-A3B-MXFP4_MOE-00002-of-00002.gguf"},
    ])

    def fail_if_called(*a, **k):
        raise AssertionError("must refuse before ever opening a network connection")
    monkeypatch.setattr(models.urllib.request, "urlopen", fail_if_called)

    with pytest.raises(models.ModelError, match="split GGUF"):
        models.download("qwen36-35b-a3b-mxfp4")


def test_download_still_works_for_a_single_file_model(monkeypatch, tmp_path):
    monkeypatch.setattr(models, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(models, "DEFAULT_DIR", tmp_path / "models")
    monkeypatch.setattr(models, "models_dir", lambda: tmp_path / "models")
    monkeypatch.setattr(models, "_repo_files", lambda repo: [
        {"rfilename": "model-Q4_K_M.gguf"},
    ])

    class _FakeResponse:
        headers = {"Content-Length": "4"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, n):
            if getattr(self, "_done", False):
                return b""
            self._done = True
            return b"data"

    monkeypatch.setattr(models.urllib.request, "urlopen", lambda url, timeout=60: _FakeResponse())

    path = models.download("gemma4-12b")
    assert path.endswith("Q4_K_M.gguf")
    from pathlib import Path
    assert Path(path).read_bytes() == b"data"
