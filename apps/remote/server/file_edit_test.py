"""Disposable filesystem proofs; run: python3 -m unittest discover -s apps/remote/server -p file_edit_test.py."""
import base64
import errno
import importlib.util
import json
import os
from pathlib import Path
import select
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


HELPER = Path(__file__).with_name("file-edit.py")
SPEC = importlib.util.spec_from_file_location("file_edit", HELPER)
edit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(edit)


class FileEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="file-edit-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "document.txt"
        self.original = b"original text with a longer tail\n"
        self.target.write_bytes(self.original)
        self.backups = self.root / "backups"
        self.before = self.target.stat()
        self.version = self.read()["revision"]

    def read(self, path=None):
        return edit.edit_file({"operation": "read", "path": str(path or self.target)}, str(self.backups))

    def body(self, content="new\n", path=None, revision=None):
        return {"operation": "save", "path": str(path or self.target),
                "revision": revision or self.version, "content": content}

    def save(self, **kwargs):
        return edit.edit_file(self.body(**kwargs), str(self.backups))

    def cli(self, body):
        process = subprocess.run([sys.executable, str(HELPER), str(self.backups)],
                                 input=json.dumps(body), text=True, capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads(process.stdout)

    def assert_status(self, status, function):
        with self.assertRaises(edit.EditError) as raised:
            function()
        self.assertEqual(raised.exception.status, status)
        return str(raised.exception)

    def assert_original(self):
        self.assertEqual(self.target.read_bytes(), self.original)
        now = self.target.stat()
        self.assertEqual((now.st_dev, now.st_ino, now.st_uid, now.st_gid, now.st_mode),
                         (self.before.st_dev, self.before.st_ino, self.before.st_uid,
                          self.before.st_gid, self.before.st_mode))

    def assert_no_backups(self):
        self.assertEqual(list(self.backups.glob("*")), [])

    def is_target(self, fd):
        info = os.fstat(fd)
        return (info.st_dev, info.st_ino) == (self.before.st_dev, self.before.st_ino)

    def test_save_preserves_inode_owner_mode_hardlinks_and_symlink(self):
        os.chmod(self.target, 0o640)
        hardlink = self.root / "hardlink"
        symlink = self.root / "symlink"
        os.link(self.target, hardlink)
        symlink.symlink_to(self.target.name)
        before = self.target.stat()
        link_before = symlink.lstat()
        version = self.read(symlink)["revision"]
        result = self.save(path=symlink, revision=version, content="short\n")
        after = self.target.stat()
        self.assertEqual((after.st_dev, after.st_ino, after.st_uid, after.st_gid,
                          after.st_mode, after.st_nlink),
                         (before.st_dev, before.st_ino, before.st_uid, before.st_gid,
                          before.st_mode, before.st_nlink))
        self.assertEqual(symlink.lstat().st_ino, link_before.st_ino)
        self.assertEqual(os.readlink(symlink), self.target.name)
        self.assertEqual(hardlink.read_bytes(), b"short\n")
        self.assertEqual(result["revision"], self.read(symlink)["revision"])
        self.assertNotEqual(result["revision"], version)
        self.assert_no_backups()

    def test_save_preserves_user_xattr(self):
        try:
            os.setxattr(self.target, "user.file_edit_fixture", b"preserve me")
        except OSError as failure:
            if failure.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
                self.skipTest("fixture filesystem lacks user xattrs")
            raise
        version = self.read()["revision"]
        self.save(revision=version)
        self.assertEqual(os.getxattr(self.target, "user.file_edit_fixture"), b"preserve me")

    def test_save_preserves_posix_acl(self):
        # Linux ACL xattr: version, owner, named user, group, mask, other.
        acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in (
            (1, 6, 0xffffffff), (2, 4, os.getuid() + 10000),
            (4, 4, 0xffffffff), (16, 4, 0xffffffff), (32, 0, 0xffffffff)))
        try:
            os.setxattr(self.target, "system.posix_acl_access", acl)
        except OSError as failure:
            if failure.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
                self.skipTest("fixture filesystem lacks POSIX ACLs")
            raise
        before = self.target.stat()
        acl = os.getxattr(self.target, "system.posix_acl_access")
        self.save(revision=self.read()["revision"])
        self.assertEqual(os.getxattr(self.target, "system.posix_acl_access"), acl)
        self.assertEqual(self.target.stat().st_mode, before.st_mode)

    def test_read_and_save_permission_denial_do_not_mutate(self):
        if os.geteuid() == 0:
            self.skipTest("permission proof requires an unprivileged Unix identity")
        os.chmod(self.target, 0o400)
        for body in ({"operation": "read", "path": str(self.target)}, self.body()):
            with self.subTest(operation=body["operation"]):
                result = self.cli(body)
                self.assertFalse(result["ok"])
                self.assertEqual(result["status"], 403)
                self.assertEqual(self.target.read_bytes(), self.original)
        self.assert_no_backups()

    def test_independent_process_lock_contention_then_stale_revision(self):
        alias = self.root / "contender-hardlink"
        os.link(self.target, alias)
        self.version = self.read()["revision"]
        alias_version = self.read(alias)["revision"]
        contender_body = self.body("second\n", path=alias, revision=alias_version)
        ready_read, ready_write = os.pipe()
        release_read, release_write = os.pipe()
        for fd in (ready_read, ready_write, release_read, release_write):
            self.addCleanup(os.close, fd)
        runner = """
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('helper', sys.argv[1])
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
flock = helper.fcntl.flock
def gated_flock(fd, flags):
    flock(fd, flags)
    os.write(int(sys.argv[3]), b'locked')
    os.read(int(sys.argv[4]), 1)
helper.fcntl.flock = gated_flock
print(json.dumps(helper.edit_file(json.loads(sys.argv[5]), sys.argv[2])))
"""
        first = subprocess.Popen([sys.executable, "-c", runner, str(HELPER), str(self.backups),
                                  str(ready_write), str(release_read), json.dumps(self.body("first\n"))],
                                 pass_fds=(ready_write, release_read), text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def stop_child():
            if first.poll() is None:
                first.kill()
            first.communicate(timeout=5)
        self.addCleanup(stop_child)
        self.assertTrue(select.select([ready_read], [], [], 5)[0], "child did not acquire flock")
        self.assertEqual(os.read(ready_read, 6), b"locked")
        contender = self.cli(contender_body)
        self.assertFalse(contender["ok"])
        self.assertEqual(contender["status"], 409)
        self.assert_original()
        os.write(release_write, b"1")
        stdout, stderr = first.communicate(timeout=5)
        self.assertEqual(first.returncode, 0, stderr)
        self.assertEqual(json.loads(stdout)["content"], "first\n")
        stale = self.cli(contender_body)
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["status"], 409)
        self.assertEqual(self.target.read_bytes(), b"first\n")
        self.assert_no_backups()

    def test_path_and_requested_symlink_retarget_before_write_rejected(self):
        for use_symlink in (False, True):
            with self.subTest(symlink=use_symlink), tempfile.TemporaryDirectory(dir=self.root) as folder:
                folder = Path(folder)
                target = folder / "target"
                other = folder / "other"
                target.write_bytes(self.original)
                other.write_bytes(b"other file\n")
                requested = folder / "link" if use_symlink else target
                if use_symlink:
                    requested.symlink_to(target)
                version = self.read(requested)["revision"]
                backup = edit.save_backup
                moved = folder / "moved"
                def retarget(*args):
                    result = backup(*args)
                    if use_symlink:
                        requested.unlink()
                        requested.symlink_to(other)
                    else:
                        target.rename(moved)
                        other.rename(target)
                    return result
                with patch.object(edit, "save_backup", side_effect=retarget):
                    self.assert_status(409, lambda: self.save(path=requested, revision=version))
                self.assertEqual((target if use_symlink else moved).read_bytes(), self.original)
                self.assertEqual((other if use_symlink else target).read_bytes(), b"other file\n")
                self.assert_no_backups()

    def test_canonical_directory_symlink_replacement_never_opened(self):
        directory = self.root / "canonical-dir"
        directory.mkdir()
        target = directory / "document"
        target.write_bytes(self.original)
        victim_dir = self.root / "victim-dir"
        victim_dir.mkdir()
        victim = victim_dir / "document"
        victim.write_bytes(self.original)
        version = self.read(target)["revision"]
        opened = os.open
        moved = self.root / "moved-dir"
        def replace_directory(path, flags, *args, **kwargs):
            if path == directory.name and flags & os.O_DIRECTORY:
                directory.rename(moved)
                directory.symlink_to(victim_dir, target_is_directory=True)
            return opened(path, flags, *args, **kwargs)
        with patch.object(edit.os, "open", side_effect=replace_directory):
            with self.assertRaises(OSError) as raised:
                self.save(path=target, revision=version)
            self.assertIn(raised.exception.errno, (errno.ENOTDIR, errno.ELOOP))
        self.assertEqual(victim.read_bytes(), self.original)
        self.assertEqual((moved / "document").read_bytes(), self.original)
        self.assert_no_backups()

    def test_pinned_directory_retarget_to_same_inode_hardlink_rejected(self):
        directory = self.root / "canonical-dir"
        directory.mkdir()
        target = directory / "document"
        target.write_bytes(self.original)
        alternate = self.root / "alternate"
        alternate.mkdir()
        os.link(target, alternate / target.name)
        version = self.read(target)["revision"]
        backup = edit.save_backup
        moved = self.root / "moved-dir"
        def retarget(*args):
            result = backup(*args)
            directory.rename(moved)
            directory.symlink_to(alternate, target_is_directory=True)
            return result
        with patch.object(edit, "save_backup", side_effect=retarget):
            self.assert_status(409, lambda: self.save(path=target, revision=version))
        self.assertEqual(target.read_bytes(), self.original)
        self.assertEqual((moved / target.name).read_bytes(), self.original)
        self.assert_no_backups()

    def test_backup_failures_leave_original_unchanged(self):
        for syscall in ("pwrite", "ftruncate", "fsync"):
            with self.subTest(syscall=syscall):
                real = getattr(os, syscall)
                def fail_backup(fd, *args):
                    if not self.is_target(fd):
                        raise OSError(errno.ENOSPC, "injected backup failure")
                    return real(fd, *args)
                with patch.object(edit.os, syscall, side_effect=fail_backup):
                    with self.assertRaises(OSError):
                        self.save()
                self.assert_original()
                self.assert_no_backups()

    def test_failed_target_write_truncate_and_fsync_restore_original(self):
        for syscall in ("pwrite", "ftruncate", "fsync"):
            with self.subTest(syscall=syscall):
                # Rollback changes timestamps, so each attempt uses a fresh revision.
                self.version = self.read()["revision"]
                real = getattr(os, syscall)
                failed = False
                def fail_once(fd, *args):
                    nonlocal failed
                    if self.is_target(fd) and not failed:
                        failed = True
                        if syscall == "pwrite":
                            real(fd, args[0][:2], args[1])
                        raise OSError(errno.EIO, "injected target failure")
                    return real(fd, *args)
                with patch.object(edit.os, syscall, side_effect=fail_once):
                    message = self.assert_status(500, self.save)
                self.assertIn("restored", message)
                self.assertTrue(failed)
                self.assert_original()
                self.assert_no_backups()

    def test_partial_writes_complete_and_zero_writes_rollback(self):
        real = os.pwrite
        def partial(fd, content, offset):
            return real(fd, content[:3], offset)
        with patch.object(edit.os, "pwrite", side_effect=partial):
            self.save(content="a longer replacement\n")
        self.assertEqual(self.target.read_bytes(), b"a longer replacement\n")
        version = self.read()["revision"]
        failed = False
        def zero_once(fd, content, offset):
            nonlocal failed
            if self.is_target(fd) and not failed:
                failed = True
                return 0
            return real(fd, content, offset)
        with patch.object(edit.os, "pwrite", side_effect=zero_once):
            self.assert_status(500, lambda: self.save(revision=version))
        self.assertEqual(self.target.read_bytes(), b"a longer replacement\n")
        self.assert_no_backups()

    def test_failed_rollback_retains_recovery_backup_and_blocks_retry(self):
        real = os.pwrite
        def always_fail_target(fd, content, offset):
            if self.is_target(fd):
                real(fd, content[:2], offset)
                raise OSError(errno.EIO, "injected save and rollback failure")
            return real(fd, content, offset)
        with patch.object(edit.os, "pwrite", side_effect=always_fail_target):
            message = self.assert_status(500, self.save)
        backups = list(self.backups.glob("*.json"))
        self.assertEqual(len(backups), 1)
        payload = json.loads(backups[0].read_text())
        self.assertEqual(base64.b64decode(payload["original"]), self.original)
        self.assertEqual(payload["inode"], self.before.st_ino)
        self.assertEqual(payload["path"], str(self.target))
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertIn(str(backups[0]), message)
        self.assert_status(409, self.read)
        self.assert_status(409, self.save)
        self.assertTrue(backups[0].exists())

    def test_process_crash_retains_backup_without_claiming_atomicity(self):
        runner = """
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('helper', sys.argv[1])
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
real = os.pwrite
inode = os.stat(sys.argv[3]).st_ino
def crash(fd, content, offset):
    if os.fstat(fd).st_ino == inode:
        real(fd, content[:2], offset)
        os._exit(73)
    return real(fd, content, offset)
helper.os.pwrite = crash
helper.edit_file(json.loads(sys.argv[4]), sys.argv[2])
"""
        process = subprocess.run([sys.executable, "-c", runner, str(HELPER), str(self.backups),
                                  str(self.target), json.dumps(self.body())], timeout=5)
        self.assertEqual(process.returncode, 73)
        self.assertNotEqual(self.target.read_bytes(), self.original)
        backups = list(self.backups.glob("*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(base64.b64decode(json.loads(backups[0].read_text())["original"]), self.original)
        self.assert_status(409, self.read)
        self.assert_status(409, self.save)

    def test_interrupted_save_blocks_hardlink_alias_read_and_save(self):
        alias = self.root / "alias"
        os.link(self.target, alias)
        self.version = self.read()["revision"]
        alias_version = self.read(alias)["revision"]
        edit.save_backup(str(self.backups), str(self.target), self.target.stat(), self.original)
        self.assert_status(409, lambda: self.read(alias))
        self.assert_status(409, lambda: self.save(path=alias, revision=alias_version))
        self.assert_original()
        self.assertEqual(len(list(self.backups.glob("*.json"))), 1)

    def test_pending_recovery_reported_even_when_crash_left_invalid_utf8(self):
        backup = edit.save_backup(str(self.backups), str(self.target), self.target.stat(), self.original)
        self.target.write_bytes(b"\xe2(incomplete UTF-8")
        for operation in (self.read, self.save):
            message = self.assert_status(409, operation)
            self.assertIn(backup, message)
        self.assertTrue(Path(backup).exists())
        self.assertEqual(self.target.read_bytes(), b"\xe2(incomplete UTF-8")

    def test_backup_directory_fsync_failure_prevents_target_write(self):
        real = os.fsync
        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EIO, "injected backup directory fsync failure")
            return real(fd)
        with patch.object(edit.os, "fsync", side_effect=fail_directory):
            with self.assertRaises(OSError):
                self.save()
        self.assert_original()
        self.assert_no_backups()

    def test_requested_symlink_retarget_after_write_restores_pinned_inode(self):
        alias = self.root / "alias"
        alias.symlink_to(self.target)
        other = self.root / "other"
        other.write_bytes(b"other file\n")
        version = self.read(alias)["revision"]
        real = os.pwrite
        retargeted = False
        def retarget_after_write(fd, content, offset):
            nonlocal retargeted
            result = real(fd, content, offset)
            if self.is_target(fd) and not retargeted:
                retargeted = True
                alias.unlink()
                alias.symlink_to(other)
            return result
        with patch.object(edit.os, "pwrite", side_effect=retarget_after_write):
            message = self.assert_status(500, lambda: self.save(path=alias, revision=version))
        self.assertIn("restored", message)
        self.assert_original()
        self.assertEqual(other.read_bytes(), b"other file\n")
        self.assert_no_backups()

    def test_backup_directory_symlink_cannot_receive_original_plaintext(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.backups.symlink_to(outside, target_is_directory=True)
        real = os.pwrite
        leaked = []
        def inspect(fd, content, offset):
            if not self.is_target(fd):
                leaked.append(content)
            return real(fd, content, offset)
        with patch.object(edit.os, "pwrite", side_effect=inspect):
            with self.assertRaises((OSError, edit.EditError)):
                self.save()
        self.assertEqual(leaked, [], "backup bytes written through a directory symlink")
        self.assert_original()
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
