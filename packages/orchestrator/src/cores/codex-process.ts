import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";

export class CodexProcessError extends Error {}
export interface CodexProcess {
  child: ChildProcessWithoutNullStreams;
  readonly startupFailure?: string;
  stop(): Promise<void>;
}
export interface CodexProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
function executable(binary: string, options: CodexProcessOptions): string {
  const candidates = isAbsolute(binary) ? [binary] : binary.includes("/") ? [resolve(options.cwd, binary)]
    : (options.env.PATH ?? "").split(delimiter).map(directory => join(directory, binary));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Continue executable lookup. */ }
  }
  throw new CodexProcessError(`Codex executable is unavailable: ${binary}`);
}

// The private control socket is the owner's lifeline, not model stdin. Only this
// subreaper retains its child end. Its descendants inherit ordinary stdio, cwd,
// environment and namespaces, but cannot keep the owner lifeline alive.
const supervisor = String.raw`
import ctypes, os, selectors, signal, subprocess, sys, time

control = 3
os.set_inheritable(control, False)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    os.write(control, b"error:Linux child subreaper unavailable\n")
    sys.exit(125)
if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    os.write(control, b"error:Linux pidfd support unavailable\n")
    sys.exit(125)
# A terminal/process-group signal must not kill the reaper before it can clean up.
os.setsid()
wake_r, wake_w = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
signal.set_wakeup_fd(wake_w)
stopping = False
def stop_signal(signum, frame):
    global stopping
    stopping = True
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, stop_signal)
signal.signal(signal.SIGCHLD, lambda signum, frame: None)

def children(pid):
    found = set()
    try:
        for tid in os.listdir('/proc/%d/task' % pid):
            try:
                with open('/proc/%d/task/%s/children' % (pid, tid)) as source:
                    found.update(int(value) for value in source.read().split())
            except FileNotFoundError:
                pass
    except FileNotFoundError:
        pass
    return found

def cleanup():
    # Freeze parents before enumerating children. pidfds prevent signalling a
    # reused PID, and stopping each parent closes its fork/enumeration race.
    deadline = time.monotonic() + 8
    while True:
        owned = children(os.getpid())
        handles = []
        seen = set()
        try:
            while owned:
                pid = owned.pop()
                if pid in seen:
                    continue
                seen.add(pid)
                try:
                    fd = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                handles.append(fd)
                try:
                    signal.pidfd_send_signal(fd, signal.SIGSTOP)
                    while True:
                        try:
                            with open('/proc/%d/stat' % pid) as source:
                                state = source.read().rsplit(') ', 1)[1][0]
                        except FileNotFoundError:
                            break
                        if state in ('T', 't', 'Z', 'X'):
                            break
                        if time.monotonic() > deadline:
                            raise RuntimeError('owned process did not stop')
                        time.sleep(0.001)
                    owned.update(children(pid))
                except ProcessLookupError:
                    pass
            for fd in reversed(handles):
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            for fd in handles:
                os.close(fd)
        # Orphans, including double forks, are adopted here rather than by init.
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                return
        if time.monotonic() > deadline:
            raise RuntimeError('owned descendants could not be reaped')
        time.sleep(0.001)

code = 125
child = None
try:
    selector = selectors.DefaultSelector()
    selector.register(control, selectors.EVENT_READ)
    selector.register(wake_r, selectors.EVENT_READ)
    # Check before spawning so a stop racing launch cannot leave late work.
    if selector.select(0) or stopping:
        code = 0
    else:
        child = subprocess.Popen(sys.argv[1:], close_fds=True)
        child_fd = os.pidfd_open(child.pid)
        selector.register(child_fd, selectors.EVENT_READ)
        os.write(control, b"ready\n")
        while not stopping:
            events = selector.select()
            if any(key.fd == child_fd for key, _ in events):
                code = child.wait()
                break
            if any(key.fd == control for key, _ in events):
                code = 0
                break
            if any(key.fd == wake_r for key, _ in events):
                os.read(wake_r, 4096)
        if stopping:
            code = 0
except (BrokenPipeError, ConnectionResetError):
    code = 0
except BaseException:
    try:
        os.write(control, b"error:Codex namespace-inheriting supervisor failed\n")
    except OSError:
        pass
finally:
    # Let app-server flush native history before the final descendant sweep.
    if child is not None and child.poll() is None:
        try:
            child.terminate()
            child.wait(timeout=0.2)
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        cleanup()
    except BaseException:
        try:
            os.write(control, b"error:Codex owned process cleanup failed\n")
        except OSError:
            pass
        # Stay alive as subreaper and retain ownership rather than orphaning work.
        while True:
            try:
                cleanup()
                break
            except BaseException:
                time.sleep(0.1)
        code = 125
sys.exit(code if code >= 0 else 128 - code)
`;

/** No manager-mediated execution: this process inherits the caller's namespace. */
export function openCodexProcess(options: CodexProcessOptions): CodexProcess {
  if (process.platform !== "linux") throw new CodexProcessError("Codex process ownership requires Linux subreaper and pidfd support");
  const child = spawn(executable("python3", options), ["-I", "-c", supervisor, executable(options.binary, options), ...options.args], {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const control = child.stdio[3] as Duplex;
  let exited = false, registered = false, failure: string | undefined, buffer = "";
  control.on("data", chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line === "ready") registered = true;
      else if (line.startsWith("error:")) failure = line.slice(6);
    }
  });
  control.on("error", () => { /* EOF also triggers cleanup in the supervisor. */ });
  child.on("error", () => { failure = "Codex process supervisor could not start"; });
  const done = new Promise<void>(resolveDone => child.once("close", () => { exited = true; resolveDone(); }));
  let stopPromise: Promise<void> | undefined;
  return { child: child as ChildProcessWithoutNullStreams, get startupFailure() {
    return failure ?? (exited && !registered ? "Codex process supervisor exited before launch" : undefined);
  }, stop() {
    return stopPromise ??= (async () => {
      // Destroy closes both directions. Neither the model nor its tools owns fd 3.
      control.destroy();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([done, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CodexProcessError("Codex owned process cleanup did not finish; supervisor retained")), 10_000);
        })]);
        if (failure) throw new CodexProcessError(failure);
      } finally { clearTimeout(timer); }
    })();
  } };
}
