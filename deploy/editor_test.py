#!/usr/bin/python3
import importlib.machinery
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


launcher = load("editor_launcher", ROOT / "apps/remote/server/pi-editor-launch")
provisioner = load("editor_provisioner", ROOT / "deploy/editor")


class EditorBoundaryTests(unittest.TestCase):
    def test_workspace_lexical_escape_and_origin_collision(self):
        person = {"version": 1, "user": "alice", "unlock": {
            "cipherDir": "/home/alice/.private.crypt", "mountpoint": "/home/alice/private"}}
        valid = provisioner.editor_config(person, "alice", "/home/alice/private/project",
                                          "http://alice-editor.example", "http://pi.example")
        self.assertEqual(valid["workspace"], "/home/alice/private/project")
        for workspace in ("/home/alice/private-evil", "/home/alice/private/../public", "relative"):
            with self.assertRaises(provisioner.ProvisionError):
                provisioner.editor_config(person, "alice", workspace, "http://editor.example", "http://pi.example")
        for editor in ("http://pi.example", "http://editor.example/", "http://name:secret@editor.example",
                       "http://editor.example:80", "http://bad host.example", "http://editor.example\\evil"):
            with self.assertRaises(provisioner.ProvisionError):
                provisioner.editor_config(person, "alice", "/home/alice/private", editor, "http://pi.example")

    def test_missing_mount_and_resolved_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mount = root / "private"
            mount.mkdir()
            outside = root / "public"
            outside.mkdir()
            (mount / "project").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(launcher.EditorError) as missing:
                launcher.require_encrypted_mount(mount, [(mount, "ext4")])
            self.assertEqual(missing.exception.code, "person_locked")
            launcher.require_encrypted_mount(mount, [(mount, "fuse.gocryptfs")])
            with self.assertRaises(launcher.EditorError) as escaped:
                launcher.confined_directory(mount / "project", mount)
            self.assertEqual(escaped.exception.code, "outside_encrypted_mount")
            (mount / ".pi-editor").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(launcher.EditorError):
                launcher.confined_directory(mount / ".pi-editor", mount, create=True)
            self.assertEqual(list(outside.iterdir()), [])

    def test_namespace_launch_and_editor_environment_do_not_inherit_credentials(self):
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid(), pw_name="alice",
                                  pw_dir="/home/alice", pw_shell="/bin/bash")
        drop = launcher.drop_command(account, "--inside", "alice")
        self.assertIn("--init-groups", drop)
        self.assertIn("--no-new-privs", drop)
        with tempfile.TemporaryDirectory() as temporary:
            mount = Path(temporary)
            workspace = mount / "workspace"
            workspace.mkdir()
            with patch.object(launcher, "read_config", return_value=(account, mount, workspace)), \
                 patch.object(launcher, "require_encrypted_mount"), \
                 patch.object(launcher.os, "listdir", return_value=["0", "1", "2"]), \
                 patch.object(launcher.os, "chdir"), patch.object(launcher.os, "umask"), \
                 patch.dict(os.environ, {"PASSWORD": "inherited-secret", "PI_REMOTE_CONFIG": "wrong",
                                         "OPENAI_API_KEY": "inherited-secret", "NODE_OPTIONS": "unsafe"}), \
                 patch.object(launcher.os, "execve") as execute:
                launcher.launch_inside("alice")
            executable, arguments, environment = execute.call_args.args
            self.assertEqual(executable, "/usr/bin/code-server")
            self.assertEqual(environment["HOME"], account.pw_dir)
            for key in ("PASSWORD", "PI_REMOTE_CONFIG", "OPENAI_API_KEY", "NODE_OPTIONS"):
                self.assertNotIn(key, environment)
            for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"):
                self.assertTrue(Path(environment[key]).is_relative_to(mount / ".pi-editor"))
            self.assertIn("--disable-proxy", arguments)
            self.assertEqual(arguments[arguments.index("--socket-mode") + 1], "0600")
            self.assertNotIn("--bind-addr", arguments)
            self.assertEqual(arguments[-1], str(workspace))
            self.assertEqual((mount / ".pi-editor/config/code-server.yaml").read_text(), "{}\n")

    def test_mountinfo_escaped_mount_names(self):
        entries = list(launcher.mount_entries("32 20 0:42 / /home/alice/private\\040folder rw - fuse.gocryptfs gocryptfs rw"))
        self.assertEqual(entries, [(Path("/home/alice/private folder"), "fuse.gocryptfs")])


if __name__ == "__main__":
    unittest.main()
