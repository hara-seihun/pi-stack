#!/usr/bin/python3
"""Supervised shell operation; result custody is independent of a Pi observation."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def commit(directory, result):
    path = directory / "result.next"
    with path.open("w") as file:
        json.dump(result, file)
        file.flush()
        os.fsync(file.fileno())
    path.rename(directory / "result.json")
    fd = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main(directory):
    invocation = json.loads((directory / "invocation.json").read_text())
    spec = importlib.util.spec_from_file_location("shell_owner", Path(__file__).with_name("pi-shell-owner.py"))
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    owner.prctl(36, 1)
    signals = {signal.SIGCHLD, signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    deadline = None if invocation["timeout"] is None else time.monotonic() + invocation["timeout"]
    result = {"exitCode": None, "cancelled": False, "timedOut": False, "cleanupError": None}
    with (directory / "output.log").open("ab", buffering=0) as output:
        child = subprocess.Popen(["bash", "-c", invocation["command"]], cwd=invocation["cwd"], env=invocation["env"],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True,
                                 preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_UNBLOCK, signals))
        status = None
        try:
            while status is None:
                status = owner.reap(child.pid, status)
                if status is not None:
                    break
                if (directory / "cancel").exists():
                    result["cancelled"] = True
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    result["timedOut"] = True
                    break
                event = signal.sigtimedwait(signals, 0.1)
                if event is not None and event.si_signo != signal.SIGCHLD:
                    result["cancelled"] = True
                    break
        finally:
            try:
                status = owner.close_descendants(child.pid, status)
            except (OSError, owner.OwnershipError) as error:
                result["cleanupError"] = str(error)
        if status is not None:
            result["exitCode"] = os.waitstatus_to_exitcode(status)
        os.fsync(output.fileno())
    commit(directory, result)


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    try:
        main(directory)
    except Exception as error:
        commit(directory, {"exitCode": None, "cancelled": False, "timedOut": False, "cleanupError": str(error)})
        sys.exit(125)
