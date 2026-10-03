// The worker is sent as code; the only session data it receives is one operation on stdin.
export const CONVERGE_WORKER = String.raw`
import json, os, selectors, signal, subprocess, sys, tempfile, time

MAX_BYTES = 50 * 1024

def shell(request):
    timeout = request.get("timeout", 55)
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 1800:
        raise ValueError("timeout must be between 0 and 1800 seconds")
    cwd = request.get("cwd") or os.path.expanduser("~")
    if not os.path.isabs(cwd): raise ValueError("cwd must be absolute")
    child = subprocess.Popen(["bash", "-lc", request["command"]], cwd=cwd,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output, total, stopped, output_open = bytearray(), 0, None, True
    deadline = time.monotonic() + timeout
    poll = selectors.DefaultSelector()
    poll.register(child.stdout, selectors.EVENT_READ, "output")
    poll.register(sys.stdin, selectors.EVENT_READ, "connection")
    try:
        while True:
            if not output_open and child.poll() is not None:
                return {"output": output.decode("utf-8", "replace"), "exitCode": child.returncode,
                    "truncated": total > MAX_BYTES, "stopped": stopped}
            if stopped is None and time.monotonic() >= deadline:
                stopped = "timeout"
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            events = poll.select(0.05)
            for key, _ in events:
                if key.data == "connection":
                    if not os.read(sys.stdin.fileno(), 1):
                        stopped = stopped or "cancelled"
                        try: os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        poll.unregister(sys.stdin)
                else:
                    chunk = os.read(child.stdout.fileno(), 8192)
                    if not chunk:
                        output_open = False
                        poll.unregister(child.stdout)
                        continue
                    total += len(chunk)
                    output.extend(chunk)
                    if len(output) > MAX_BYTES: del output[:-MAX_BYTES]
    finally:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait()
        child.stdout.close()
        poll.close()

def path_for(request):
    path = os.path.expanduser(request["path"])
    if not os.path.isabs(path):
        cwd = request.get("cwd") or os.path.expanduser("~")
        if not os.path.isabs(cwd): raise ValueError("cwd must be absolute")
        path = os.path.join(cwd, path)
    return os.path.realpath(path)

def read(request):
    offset, limit = request.get("offset", 1), request.get("limit", 2000)
    if not isinstance(offset, int) or offset < 1 or not isinstance(limit, int) or not 1 <= limit <= 2000:
        raise ValueError("offset must be positive; limit must be 1..2000")
    lines, size, clipped = [], 0, False
    with open(path_for(request), "rb") as file:
        for _ in range(offset - 1):
            if not file.readline(): break
        for _ in range(limit):
            line = file.readline(MAX_BYTES - size + 1)
            if not line: break
            if len(line) + size > MAX_BYTES:
                lines.append(line[:MAX_BYTES - size])
                clipped = True
                break
            lines.append(line)
            size += len(line)
        truncated = clipped or bool(file.read(1))
    data = b"".join(lines)
    if b"\x00" in data: raise ValueError("Binary file; use bash to inspect or convert it")
    return {"text": data.decode("utf-8", "replace"), "offset": offset, "truncated": truncated,
        "nextOffset": offset + len(lines) - int(clipped), "partialLine": clipped}

def replace_file(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    fd, temporary = tempfile.mkstemp(prefix=".pi-converge-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def file_operation(request):
    path = path_for(request)
    if request["action"] == "write":
        text = request["content"]
    else:
        with open(path, "rb") as file: original = file.read().decode("utf-8")
        edits = request["edits"]
        if not edits: raise ValueError("At least one edit is required")
        matches = []
        for edit in edits:
            old = edit["oldText"]
            if not old: raise ValueError("oldText must not be empty")
            start = original.find(old)
            if start < 0 or original.find(old, start + 1) >= 0:
                raise ValueError("Every oldText must match exactly once; file was not changed")
            matches.append((start, start + len(old), edit["newText"]))
        matches.sort()
        if any(matches[i][1] > matches[i+1][0] for i in range(len(matches)-1)):
            raise ValueError("Edits overlap; file was not changed")
        text = original
        for start, end, new in reversed(matches): text = text[:start] + new + text[end:]
    data = text.encode("utf-8")
    replace_file(path, data)
    return {"path": path, "bytesWritten": len(data)}

try:
    request = json.loads(sys.stdin.buffer.readline())
    action = request["action"]
    value = shell(request) if action == "bash" else read(request) if action == "read" else file_operation(request) if action in ("write", "edit") else None
    if value is None: raise ValueError("Unknown action")
    print(json.dumps({"ok": True, "value": value}), flush=True)
except Exception as error:
    print(json.dumps({"ok": False, "error": {"code": "remote_operation", "message": str(error)}}), flush=True)
`;
