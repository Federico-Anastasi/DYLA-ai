"""Tests for server/engine_setup.py: unpacking the downloaded llama-server archive.

The archive comes from a GitHub release download, not directly from the user — but
"we chose the URL" is not the same as "we control the bytes", and extractall() on an
untrusted zip/tar is the textbook path-traversal primitive (Zip Slip). These tests build
malicious archives by hand and check they cannot write outside the target directory.

Run with: python -m pytest server/tests/test_engine_setup.py
"""
import tarfile
import zipfile

import pytest

from server import engine_setup


def _zip_with_member(path, member_name: str, content: bytes = b"x") -> None:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(member_name, content)


def test_unpack_refuses_a_zip_member_that_escapes_the_target_dir(tmp_path):
    archive = tmp_path / "evil.zip"
    _zip_with_member(archive, "../../outside.txt")
    into = tmp_path / "install"
    into.mkdir()

    with pytest.raises(engine_setup.EngineDownloadFailed, match="unsafe path"):
        engine_setup._unpack(archive, into)
    assert not (tmp_path.parent / "outside.txt").exists()


def test_unpack_refuses_a_zip_member_with_an_absolute_path(tmp_path):
    archive = tmp_path / "evil2.zip"
    # zipfile stores this as-is; extractall would otherwise honour the absolute path.
    _zip_with_member(archive, "/etc/evil.txt")
    into = tmp_path / "install2"
    into.mkdir()

    with pytest.raises(engine_setup.EngineDownloadFailed, match="unsafe path"):
        engine_setup._unpack(archive, into)


def test_unpack_still_extracts_a_normal_zip(tmp_path):
    archive = tmp_path / "good.zip"
    _zip_with_member(archive, "llama-server.exe", b"binary")
    into = tmp_path / "install3"
    into.mkdir()

    engine_setup._unpack(archive, into)
    assert (into / "llama-server.exe").read_bytes() == b"binary"


def test_unpack_refuses_a_tar_member_that_escapes_the_target_dir(tmp_path):
    archive = tmp_path / "evil.tar.gz"
    with tarfile.open(archive, "w:gz") as t:
        info = tarfile.TarInfo(name="../../outside.txt")
        data = b"x"
        info.size = len(data)
        import io
        t.addfile(info, io.BytesIO(data))
    into = tmp_path / "install4"
    into.mkdir()

    with pytest.raises(tarfile.TarError):
        engine_setup._unpack(archive, into)
    assert not (tmp_path.parent / "outside.txt").exists()


def test_unpack_still_extracts_a_normal_tar(tmp_path):
    import io
    archive = tmp_path / "good.tar.gz"
    with tarfile.open(archive, "w:gz") as t:
        data = b"binary"
        info = tarfile.TarInfo(name="llama-server")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    into = tmp_path / "install5"
    into.mkdir()

    engine_setup._unpack(archive, into)
    assert (into / "llama-server").read_bytes() == b"binary"
