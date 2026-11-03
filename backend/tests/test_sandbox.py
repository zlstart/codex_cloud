import os

import pytest
from app.sandbox import (
    SandboxError,
    open_safe_file,
    read_text_file,
    regular_files,
    safe_path,
    workspace_usage,
    write_text_file,
)


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "workspace"
    (root / "uploads").mkdir(parents=True)
    (root / "outputs").mkdir()
    return root


@pytest.mark.parametrize("path", ["../secret", "/etc/passwd", "outputs/../../secret", "outputs\\bad", "\x00"])
def test_rejects_traversal(workspace, path):
    with pytest.raises(SandboxError):
        safe_path(workspace, path)


def test_host_file_operations_reject_links(workspace, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("outside")
    (workspace / "outputs" / "link.txt").symlink_to(secret)
    (workspace / "outputs" / "directory").symlink_to(tmp_path, target_is_directory=True)
    for path in ("outputs/link.txt", "outputs/directory/secret.txt"):
        with pytest.raises(SandboxError):
            read_text_file(workspace, path)
        with pytest.raises(SandboxError):
            write_text_file(workspace, path, "changed")
    assert secret.read_text() == "outside"
    assert regular_files(workspace) == []


def test_does_not_truncate_hardlink_target(workspace, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("preserve")
    os.link(secret, workspace / "outputs" / "linked.txt")
    with pytest.raises(SandboxError):
        write_text_file(workspace, "outputs/linked.txt", "erase")
    assert secret.read_text() == "preserve"


def test_quota_counts_hardlinks_and_stops_on_directory_budget(workspace):
    file = workspace / "outputs" / "data.bin"
    file.write_bytes(b"x" * 4096)
    os.link(file, workspace / "outputs" / "linked.bin")
    assert regular_files(workspace) == []
    count, size = workspace_usage(workspace)
    assert count == 4 and size >= 4096
    for index in range(25):
        (workspace / "outputs" / f"empty{index}").mkdir()
    count, _ = workspace_usage(workspace, max_entries=10)
    assert count == 11


def test_file_descriptor_stays_bound_when_directory_is_swapped(workspace, tmp_path):
    folder = workspace / "outputs" / "documents"
    folder.mkdir()
    (folder / "report.txt").write_text("owned file")
    opened = open_safe_file(workspace, "outputs/documents/report.txt")
    folder.rename(workspace / "outputs" / "old")
    folder.symlink_to(tmp_path, target_is_directory=True)
    (tmp_path / "report.txt").write_text("outside secret")
    with os.fdopen(opened) as file:
        assert file.read() == "owned file"


def test_read_write_nested_and_binary_limit(workspace):
    written = write_text_file(workspace, "outputs/reports/brief.md", "# 报告\n数据已核实")
    assert written == "outputs/reports/brief.md"
    assert read_text_file(workspace, "/workspace/" + written).startswith("# 报告")
    with pytest.raises(SandboxError):
        write_text_file(workspace, "uploads/changed.txt", "forbidden")
    (workspace / "uploads" / "big.txt").write_bytes(b"x" * 100)
    assert "截断" in read_text_file(workspace, "uploads/big.txt", max_bytes=10)
