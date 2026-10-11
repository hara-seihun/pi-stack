#!/usr/bin/python3
"""One Linux subreaper owns one shell invocation, independent of process groups."""
import array
import ctypes
import os
import json
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time


class OwnershipError(RuntimeError):
    pass


class CleanupError(OwnershipError):
    def __init__(self, error, shell_status, was_cancelled):
        super().__init__(str(error))
        self.exit_code = None if shell_status is None else os.waitstatus_to_exitcode(shell_status)
        self.was_cancelled = was_cancelled


cancelled = False


def prctl(option, value):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(option, value, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OwnershipError(f"prctl({option}): {os.strerror(code)}")


def children(pid):
    result = set()
    try:
        tasks = list(Path(f"/proc/{pid}/task").iterdir())
    except FileNotFoundError:
        return result
    for task in tasks:
        try:
            result.update(int(value) for value in (task / "children").read_text().split())
        except FileNotFoundError:
            continue
    return result


def parent(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None
    return int(stat[stat.rindex(")") + 2:].split()[1])


def pinned_pid(fd):
    for line in Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines():
        if line.startswith("Pid:"):
            return int(line.split()[1])
    raise OwnershipError("cleanup descriptor is not a pidfd")


def privileged_cleanup():
    if os.geteuid() != 0:
        raise OwnershipError("owned-child signal mediation requires root")
    with socket.socket(fileno=0) as channel:
        channel.settimeout(0.5)
        peer_pid, peer_uid, _ = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        invoking_uid = int(os.environ["SUDO_UID"]) if "SUDO_UID" in os.environ else os.getuid()
        if peer_uid != invoking_uid:
            raise OwnershipError("cleanup peer is not the invoking UID")
        data, ancillary, flags, _ = channel.recvmsg(1, socket.CMSG_SPACE(2 * array.array("i").itemsize))
        descriptors = array.array("i")
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                descriptors.frombytes(payload)
        try:
            if data != b"K" or flags or len(descriptors) != 2:
                raise OwnershipError("cleanup requires exactly two pinned process descriptors")
            owner_fd, child_fd = descriptors
            owner_pid = pinned_pid(owner_fd)
            child_pid = pinned_pid(child_fd)
            if owner_pid != peer_pid or owner_pid <= 0:
                raise OwnershipError("cleanup owner is no longer the socket peer")
            if child_pid == -1:
                return
            if parent(child_pid) != owner_pid:
                raise OwnershipError("cleanup target is not the peer's direct child")
            # Re-read the pinned identities after /proc validation. An exited pidfd
            # cannot accidentally authorize the new occupant of its former PID.
            if pinned_pid(owner_fd) != owner_pid or pinned_pid(child_fd) != child_pid:
                return
            try:
                signal.pidfd_send_signal(child_fd, signal.SIGSTOP)
                signal.pidfd_send_signal(child_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
        finally:
            for fd in descriptors:
                os.close(fd)


def mediate_owned_signal(fd, deadline):
    owner_fd = os.pidfd_open(os.getpid())
    try:
        sender, receiver = socket.socketpair()
        with sender, receiver:
            sender.sendmsg([b"K"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [owner_fd, fd]))])
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OwnershipError("owned-child mediation exceeded the cleanup budget")
            try:
                result = subprocess.run(["/usr/bin/sudo", "-n", "--", "/usr/bin/python3", "-I", "-B",
                                         str(Path(__file__).resolve()), "--privileged-cleanup"],
                                        stdin=receiver, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                        timeout=remaining, text=True,
                                        preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, set()))
            except subprocess.TimeoutExpired:
                raise OwnershipError("owned-child mediation exceeded the cleanup budget") from None
            if result.returncode != 0:
                raise OwnershipError(f"owned-child signal authority unavailable: {result.stderr.strip()}")
    finally:
        os.close(owner_fd)


def signal_owned(pid, owner, signum, deadline):
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        # A stale /proc children entry must never signal a reused peer PID.
        if parent(pid) != owner or pinned_pid(fd) != pid:
            return
        try:
            signal.pidfd_send_signal(fd, signum)
        except ProcessLookupError:
            pass
        except PermissionError:
            mediate_owned_signal(fd, deadline)
    finally:
        os.close(fd)


def reap(shell_pid, shell_status):
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return shell_status
        if pid == 0:
            return shell_status
        if pid == shell_pid:
            shell_status = status


def close_descendants(shell_pid, shell_status):
    deadline = time.monotonic() + 2
    while True:
        shell_status = reap(shell_pid, shell_status)
        remaining = children(os.getpid())
        if not remaining:
            return shell_status
        for pid in remaining:
            if time.monotonic() >= deadline:
                raise OwnershipError(f"descendant cleanup exceeded 2 seconds: {sorted(remaining)}")
            signal_owned(pid, os.getpid(), signal.SIGSTOP, deadline)
            signal_owned(pid, os.getpid(), signal.SIGKILL, deadline)
        if time.monotonic() >= deadline:
            raise OwnershipError(f"descendants did not exit within 2 seconds: {sorted(remaining)}")
        time.sleep(0.005)


def main():
    global cancelled
    if len(sys.argv) < 3:
        raise OwnershipError("missing owner PID or shell executable")
    signals = {signal.SIGCHLD, signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    owner = int(sys.argv[1])
    prctl(36, 1)  # PR_SET_CHILD_SUBREAPER keeps double-forked descendants here.
    prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG also closes tools on runner loss.
    if os.getppid() != owner or cancelled:
        return 143
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise OwnershipError("Python pidfd support is required")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
        Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children").read_text()
    finally:
        os.close(fd)
    os.write(3, b'{"ready":true}\n')
    child = subprocess.Popen(sys.argv[2:], start_new_session=True,
                             preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_UNBLOCK, signals))
    shell_status = None
    try:
        while not cancelled and shell_status is None:
            shell_status = reap(child.pid, shell_status)
            if shell_status is None:
                cancelled = signal.sigwait(signals) != signal.SIGCHLD
    finally:
        try:
            shell_status = close_descendants(child.pid, shell_status)
        except (OSError, OwnershipError) as error:
            raise CleanupError(error, shell_status, cancelled) from None
    if cancelled:
        return 143
    if shell_status is None:
        raise OwnershipError("shell exited without a wait status")
    code = os.waitstatus_to_exitcode(shell_status)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    if sys.argv[1:] == ["--privileged-cleanup"]:
        try:
            privileged_cleanup()
        except (OSError, OwnershipError, ValueError) as error:
            print(f"Pi owned-child signal mediation failed: {error}", file=sys.stderr)
            sys.exit(125)
        sys.exit(0)
    try:
        code = main()
        os.write(3, b'{"ok":true}\n')
    except CleanupError as error:
        message = f"Pi shell ownership failure: {error}"
        print(message, file=sys.stderr, flush=True)
        receipt = {"ok": False, "error": message, "cancelled": error.was_cancelled, "exitCode": error.exit_code}
        os.write(3, (json.dumps(receipt) + "\n").encode())
        code = 143 if error.was_cancelled else 125 if error.exit_code is None else error.exit_code if error.exit_code >= 0 else 128 - error.exit_code
    except (OSError, OwnershipError) as error:
        message = f"Pi shell ownership failure: {error}"
        print(message, file=sys.stderr, flush=True)
        os.write(3, (json.dumps({"ok": False, "error": message}) + "\n").encode())
        code = 125
    sys.exit(code)
