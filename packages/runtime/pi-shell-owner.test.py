import array
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('owner', HERE / 'pi-shell-owner.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
ROOT = os.environ.get('PI_TEST_ROOT_CUSTODY') == '1'


class OwnershipTest(unittest.TestCase):
    def mediate(self, target_fd, owner_fd=None):
        own_fd = os.pidfd_open(os.getpid()) if owner_fd is None else owner_fd
        sender, receiver = socket.socketpair()
        try:
            sender.sendmsg([b'K'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [own_fd, target_fd]))])
            return subprocess.run(['/usr/bin/sudo', '-n', '--', '/usr/bin/python3', '-I', '-B',
                                   str(HERE / 'pi-shell-owner.py'), '--privileged-cleanup'],
                                  stdin=receiver, capture_output=True, text=True, timeout=2)
        finally:
            sender.close()
            receiver.close()
            if owner_fd is None:
                os.close(own_fd)

    def test_stale_observation_does_not_signal_peer(self):
        peer = subprocess.Popen(['sleep', '10'])
        try:
            with patch.object(owner, 'parent', return_value=os.getpid()), patch.object(owner, 'pinned_pid', return_value=-1), \
                 patch.object(owner.signal, 'pidfd_send_signal') as send:
                owner.signal_owned(peer.pid, os.getpid(), signal.SIGKILL, time.monotonic() + 1)
                send.assert_not_called()
            self.assertIsNone(peer.poll())
        finally:
            peer.kill()
            peer.wait(timeout=1)

    @unittest.skipUnless(ROOT, 'set PI_TEST_ROOT_CUSTODY=1 for existing-sudo mediation')
    def test_root_child_cleanup_and_peer_rejection(self):
        owner.prctl(36, 1)
        # sudo exits while its root-owned session-escaped child is adopted here.
        command = "import os,time; p=os.fork(); (os._exit(0) if p else None); os.setsid(); print(os.getpid(),flush=True); time.sleep(10)"
        root = subprocess.Popen(['/usr/bin/sudo', '-n', '--', '/usr/bin/python3', '-I', '-B', '-c', command],
                                stdout=subprocess.PIPE, text=True)
        target = int(root.stdout.readline())
        root.wait(timeout=1)
        target_fd = os.pidfd_open(target)
        try:
            self.assertEqual(owner.parent(target), os.getpid())
            with self.assertRaises(PermissionError):
                signal.pidfd_send_signal(target_fd, 0)
            owner.signal_owned(target, os.getpid(), signal.SIGKILL, time.monotonic() + 2)
            self.assertEqual(os.waitpid(target, 0)[0], target)
            self.assertEqual(owner.pinned_pid(target_fd), -1)
            self.assertEqual(self.mediate(target_fd).returncode, 0, 'exited pinned target is a no-op')
        finally:
            if owner.pinned_pid(target_fd) > 0:
                self.mediate(target_fd)
                os.waitpid(target, 0)
            os.close(target_fd)
            root.stdout.close()

        peer_parent = subprocess.Popen([sys.executable, '-c',
            'import subprocess,time; c=subprocess.Popen(["sleep","10"]); print(c.pid,flush=True); c.wait()'],
            stdout=subprocess.PIPE, text=True)
        peer = int(peer_parent.stdout.readline())
        peer_fd = os.pidfd_open(peer)
        try:
            result = self.mediate(peer_fd)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('not the peer', result.stderr)
            self.assertGreater(owner.pinned_pid(peer_fd), 0)
            wrong_owner_fd = os.pidfd_open(peer_parent.pid)
            try:
                result = self.mediate(peer_fd, wrong_owner_fd)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('no longer the socket peer', result.stderr)
            finally:
                os.close(wrong_owner_fd)
        finally:
            signal.pidfd_send_signal(peer_fd, signal.SIGKILL)
            os.close(peer_fd)
            peer_parent.wait(timeout=1)
            peer_parent.stdout.close()

    @unittest.skipUnless(ROOT, 'set PI_TEST_ROOT_CUSTODY=1 for root-descendant timeout proof')
    def test_worker_timeout_retains_original_outcome(self):
        owner.prctl(36, 1)
        with tempfile.TemporaryDirectory() as path:
            directory = Path(path)
            marker = directory / 'root-pid'
            script = "import os,time; from pathlib import Path; os.umask(0o022); p=os.fork(); (os._exit(0) if p else None); os.setsid(); Path(%r).write_text(str(os.getpid())); time.sleep(10)" % str(marker)
            command = "sudo -n -- /usr/bin/python3 -I -B -c " + __import__('shlex').quote(script) + '; sleep 10'
            (directory / 'invocation.json').write_text(json.dumps({'timeout': 0.5, 'command': command, 'cwd': path, 'env': dict(os.environ)}))
            subprocess.run([sys.executable, '-B', str(HERE / 'pi-bash-worker.py'), path], check=True, timeout=4)
            result = json.loads((directory / 'result.json').read_text())
            self.assertTrue(result['timedOut'], result)
            self.assertFalse(result['cancelled'], result)
            self.assertIsNone(result['cleanupError'], result)
            self.assertFalse(Path('/proc/' + marker.read_text()).exists(), 'root descendant must be reaped, not merely killed')


if __name__ == '__main__':
    unittest.main()
