#!/usr/bin/python3
"""One Linux subreaper owns one shell invocation, independent of process groups."""
import ctypes
import os
import json
from pathlib import Path
import signal
import subprocess
import sys
import time


class OwnershipError(RuntimeError):
    pass


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


def signal_owned(pid, owner, signum):
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        # A stale /proc children entry must never signal a reused peer PID.
        if parent(pid) not in (owner, os.getpid()):
            return
        try:
            signal.pidfd_send_signal(fd, signum)
        except ProcessLookupError:
            pass
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
            signal_owned(pid, os.getpid(), signal.SIGSTOP)
            signal_owned(pid, os.getpid(), signal.SIGKILL)
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
        shell_status = close_descendants(child.pid, shell_status)
    if cancelled:
        return 143
    if shell_status is None:
        raise OwnershipError("shell exited without a wait status")
    code = os.waitstatus_to_exitcode(shell_status)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    try:
        code = main()
        os.write(3, b'{"ok":true}\n')
    except (OSError, OwnershipError) as error:
        message = f"Pi shell ownership failure: {error}"
        print(message, file=sys.stderr, flush=True)
        os.write(3, (json.dumps({"ok": False, "error": message}) + "\n").encode())
        code = 125
    sys.exit(code)
