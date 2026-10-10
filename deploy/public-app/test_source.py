"""Ordinary-user contracts for fixed public-lane scripts; no host provisioning.

Run: python3 -B -m unittest discover -s deploy/public-app -p test_source.py -v
All host effects are mocked. HTTP uses socket pairs and a temporary Unix socket.
"""
import contextlib
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import runpy
import socket
import socketserver
import subprocess
import tempfile
import threading
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parent


def load_remote():
    spec = importlib.util.spec_from_file_location("public_remote_contract", SOURCE / "remote.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExecCaptured(Exception):
    pass


class RemoteContracts(unittest.TestCase):
    def setUp(self):
        self.remote = load_remote()

    def test_rejected_requests_never_dispatch(self):
        requests = [None, [], {}, {"op": "unknown"}, {"op": "status", "extra": True},
                    {"op": "status", "args": "oops"}, {"op": "exec", "args": [1]},
                    {"op": "exec", "args": ["x" * 4097]},
                    {"op": "exec", "args": ["echo", "nul\0value"]},
                    {"op": "exec", "args": ["echo"] * 129},
                    {"op": "exec", "args": []}, {"op": "exec", "args": ["--help"]}]
        for op in ("start", "stop", "restart", "status", "check", "deploy", "rollback", "upload"):
            requests.append({"op": op, "args": ["untrusted"]})
        for args in ([], ["/one", "/two"], ["relative"], ["//host/path"], ["https://host/"]):
            requests.append({"op": "fetch", "args": args})
        with mock.patch.object(self.remote.subprocess, "call") as call, \
             mock.patch.object(self.remote.subprocess, "run") as run, \
             mock.patch.object(self.remote.os, "execve") as execute:
            for request in requests:
                with self.subTest(request=request), self.assertRaises((AssertionError, SystemExit)):
                    self.remote.operation(request)
                call.assert_not_called()
                run.assert_not_called()
                execute.assert_not_called()

    def test_service_operations_touch_only_public_unit_and_gate_readiness(self):
        with mock.patch.object(self.remote.subprocess, "call", return_value=0) as call, \
             mock.patch.object(self.remote, "ready") as ready:
            for op in ("start", "stop", "restart", "status"):
                ready.reset_mock()
                self.assertEqual(self.remote.operation({"op": op}), 0)
                call.assert_called_with(
                    ["/usr/bin/systemctl", "--no-pager", op, "pi-stack-martine-public.service"],
                    env={"PATH": "/usr/bin:/bin", "SYSTEMD_PAGER": "cat"})
                self.assertEqual(ready.call_count, int(op in ("start", "restart")))
            call.return_value = 1
            ready.reset_mock()
            self.assertEqual(self.remote.operation({"op": "restart"}), 1)
            ready.assert_not_called()

    def test_systemd_argv_constrains_identity_resources_and_entrypoint(self):
        command = ["/bin/sh", "-c", "printf '%s' '$HOME; literal'", "--property=User=root"]
        argv = self.remote.bounded_command(command)
        boundary = argv.index("--")
        options = argv[1:boundary]
        self.assertEqual(argv[0], "/usr/bin/systemd-run")
        self.assertRegex(options[0], r"^--unit=pi-stack-public-op-[a-f0-9]{32}$")
        self.assertEqual(len(options), len(set(options)))
        required = {
            "--quiet", "--wait", "--pipe", "--collect", "--service-type=exec",
            "--uid=pi-stack-public-martine", "--gid=pi-stack-public-martine",
            "--property=NoNewPrivileges=yes", "--property=CapabilityBoundingSet=",
            "--property=AmbientCapabilities=", "--property=Slice=pi-stack-public-martine.slice",
            "--property=MemoryMax=1G", "--property=TasksMax=128", "--property=CPUQuota=100%",
            "--property=RuntimeMaxSec=900", "--property=KillMode=control-group",
            "--property=TimeoutStopSec=5",
        }
        self.assertEqual(set(options[1:]), required)
        self.assertEqual(argv[boundary + 1:], ["/usr/local/libexec/pi-stack-public-sandbox", *command])
        self.assertNotEqual(argv[1], self.remote.bounded_command(command)[1])

    def test_exec_and_child_use_bounded_launcher_and_clean_environment(self):
        command = ["/usr/bin/printf", "%s", "literal with spaces; $(not-a-shell)"]
        with mock.patch.object(self.remote.os, "execve", side_effect=ExecCaptured) as execute:
            with self.assertRaises(ExecCaptured):
                self.remote.operation({"op": "exec", "args": command})
            binary, argv, env = execute.call_args.args
            self.assertEqual(binary, "/usr/bin/systemd-run")
            self.assertEqual(argv[argv.index("--") + 1:],
                             ["/usr/local/libexec/pi-stack-public-sandbox", *command])
            self.assertEqual(env, {"PATH": "/usr/bin:/bin"})
        with mock.patch.object(self.remote.subprocess, "run") as run:
            self.remote.sandbox_child(command, stdin=0, stdout=7)
            self.assertEqual(run.call_args.kwargs,
                             dict(env={"PATH": "/usr/bin:/bin"}, stdin=0, stdout=7,
                                  timeout=180, check=True))
            argv = run.call_args.args[0]
            self.assertEqual(argv[argv.index("--") + 1:],
                             ["/usr/local/libexec/pi-stack-public-sandbox", *command])

    def test_fetch_and_check_select_fixed_sandbox_programs(self):
        with mock.patch.object(self.remote, "drop_exec", side_effect=ExecCaptured) as execute:
            with self.assertRaises(ExecCaptured):
                self.remote.operation({"op": "fetch", "args": ["/some/path?x=1"]})
            command = execute.call_args.args[0]
            self.assertEqual(command[:3], ["/usr/bin/python3", "-I", "-c"])
            self.assertEqual(command[-1], "/some/path?x=1")
            with self.assertRaises(ExecCaptured):
                self.remote.operation({"op": "check"})
            execute.assert_called_with(["/usr/bin/python3", "-I", "/check.py"])

    def test_deployment_only_restarts_after_successful_sandbox_child(self):
        with mock.patch.object(self.remote, "sandbox_child") as child, \
             mock.patch.object(self.remote.subprocess, "call", return_value=0) as call, \
             mock.patch.object(self.remote, "ready") as ready:
            for op, code in (("deploy", self.remote.SNAPSHOT), ("rollback", self.remote.ROLLBACK),
                             ("upload", self.remote.UPLOAD)):
                self.assertEqual(self.remote.operation({"op": op}), 0)
                child.assert_called_with(["/usr/bin/python3", "-I", "-c", code],
                                         stdin=0 if op == "upload" else subprocess.DEVNULL)
                call.assert_called_with(["/usr/bin/systemctl", "restart", "pi-stack-martine-public.service"],
                                        env={"PATH": "/usr/bin:/bin"})
            call.reset_mock()
            ready.reset_mock()
            child.side_effect = subprocess.CalledProcessError(1, "mocked sandbox")
            with self.assertRaises(subprocess.CalledProcessError):
                self.remote.operation({"op": "upload"})
            call.assert_not_called()
            ready.assert_not_called()


class ControlContracts(unittest.TestCase):
    def test_invalid_cli_never_loads_privileged_bridge_or_launches_ssh(self):
        cases = [[], ["other", "status"], ["gmktec", "upload"], ["converge", "exec"],
                 ["converge", "exec", "--flag"], ["converge", "fetch", "//other/"],
                 ["converge", "fetch", "/a", "/b"], ["converge", "fetch", "relative"],
                 ["converge", "exec", "x" * 4097], ["converge", "exec", *(["x"] * 129)]]
        cases += [["converge", op, "extra"] for op in
                  ("check", "deploy", "rollback", "start", "stop", "restart", "status", "sync")]
        with mock.patch("os.geteuid", return_value=0), \
             mock.patch("pwd.getpwnam", return_value=types.SimpleNamespace(pw_uid=1004)), \
             mock.patch.dict(os.environ, {"SUDO_UID": "1004"}, clear=True), \
             mock.patch("importlib.util.spec_from_file_location") as loader, \
             mock.patch("subprocess.Popen") as popen:
            for args in cases:
                with self.subTest(args=args), mock.patch.object(os.sys, "argv", ["control.py", *args]), \
                     self.assertRaises(SystemExit):
                    runpy.run_path(str(SOURCE / "control.py"))
                loader.assert_not_called()
                popen.assert_not_called()


class SandboxContracts(unittest.TestCase):
    def sandbox(self, command, *, uid=4321, config=None, fds="1", pid="123", prctl=0, lib64=False):
        config = config if config is not None else {"uid": 4321, "workspace": "/srv/pi-public/martine", "port": 8899}
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch("pathlib.Path.read_text", return_value=json.dumps(config)))
            stack.enter_context(mock.patch("pwd.getpwnam", return_value=types.SimpleNamespace(pw_uid=4321)))
            stack.enter_context(mock.patch("os.getuid", return_value=uid))
            stack.enter_context(mock.patch("os.getpid", return_value=123))
            stack.enter_context(mock.patch("ctypes.CDLL", return_value=types.SimpleNamespace(prctl=mock.Mock(return_value=prctl))))
            stack.enter_context(mock.patch("os.path.isdir", return_value=lib64))
            stack.enter_context(mock.patch("os.path.realpath", side_effect=lambda path: "/resolved/" + Path(path).name))
            stack.enter_context(mock.patch.dict(os.environ, {"LISTEN_FDS": fds, "LISTEN_PID": pid}, clear=True))
            stack.enter_context(mock.patch.object(os.sys, "argv", ["sandbox.py", *command]))
            execute = stack.enter_context(mock.patch("os.execve", side_effect=ExecCaptured))
            dup = stack.enter_context(mock.patch("os.dup2"))
            close = stack.enter_context(mock.patch("os.close"))
            try:
                runpy.run_path(str(SOURCE / "sandbox.py"))
            except ExecCaptured:
                return execute.call_args.args, dup.call_args_list, close.call_args_list
            except AssertionError:
                execute.assert_not_called()
                dup.assert_not_called()
                close.assert_not_called()
                raise
            self.fail("sandbox must reject or exec")

    def assert_namespace(self, execution):
        binary, argv, env = execution
        self.assertEqual(binary, "/usr/bin/bwrap")
        self.assertEqual(env, {"PATH": "/usr/bin:/bin"})
        self.assertEqual(argv[:9], [binary, "--unshare-all", "--new-session", "--die-with-parent",
                                    "--cap-drop", "ALL", "--clearenv", "--ro-bind", "/usr/bin"])
        self.assertNotIn("--share-net", argv)
        self.assertNotIn("--unshare-user-try", argv)
        return argv

    @staticmethod
    def mounts(argv):
        return [(flag, argv[i + 1], argv[i + 2]) for i, flag in enumerate(argv[:argv.index("--")])
                if flag in ("--bind", "--ro-bind")]

    def test_application_view_and_literal_command(self):
        command = ["/usr/local/bin/node", "entry.js", "spaces; shell is not involved"]
        execution, dup, close = self.sandbox(command)
        argv = self.assert_namespace(execution)
        self.assertEqual(argv[argv.index("--") + 1:], command)
        self.assertEqual(self.mounts(argv), [
            ("--ro-bind", "/usr/bin", "/usr/bin"), ("--ro-bind", "/usr/lib", "/usr/lib"),
            ("--ro-bind", "/resolved/node", "/usr/local/bin/node"),
            ("--ro-bind", "/resolved/bun", "/usr/local/bin/bun"),
            ("--bind", "/srv/pi-public/martine", "/work"),
            ("--ro-bind", "/usr/local/libexec/pi-stack-public-check", "/check.py")])
        self.assertEqual(argv[argv.index("--chdir") + 1], "/work/application")
        self.assertEqual(dup, [])
        self.assertEqual(close, [])

    def test_application_entrypoint_and_optional_library_mount(self):
        execution, _, _ = self.sandbox([], lib64=True)
        argv = self.assert_namespace(execution)
        self.assertEqual(argv[argv.index("--") + 1:], ["/bin/sh", "/work/state/current/run"])
        self.assertIn(("--ro-bind", "/usr/lib64", "/usr/lib64"), self.mounts(argv))

    def test_gateway_has_only_readonly_ingress_and_fixed_code(self):
        execution, dup, close = self.sandbox(["--gateway"])
        argv = self.assert_namespace(execution)
        self.assertEqual(self.mounts(argv), [
            ("--ro-bind", "/usr/bin", "/usr/bin"), ("--ro-bind", "/usr/lib", "/usr/lib"),
            ("--ro-bind", "/srv/pi-public/martine/ingress", "/upstream"),
            ("--ro-bind", "/usr/local/libexec/pi-stack-public-gateway", "/gateway.py")])
        self.assertEqual(argv[argv.index("--") + 1:], ["/usr/bin/python3", "-I", "/gateway.py"])
        self.assertEqual(argv[argv.index("--chdir") + 1], "/")
        self.assertEqual(dup, [mock.call(3, 0, inheritable=True)])
        self.assertEqual(close, [mock.call(3)])

    def test_identity_config_prctl_and_socket_activation_fail_closed(self):
        cases = [dict(uid=0), dict(config={"uid": 4322, "workspace": "/srv/pi-public/martine", "port": 8899}),
                 dict(config={"uid": 4321, "workspace": "/home/private", "port": 8899}),
                 dict(config={"uid": 4321, "workspace": "/srv/pi-public/martine", "port": 3000}),
                 dict(prctl=-1), dict(fds="0"), dict(fds="2"), dict(pid="124")]
        for kwargs in cases:
            with self.subTest(kwargs=kwargs), self.assertRaises(AssertionError):
                self.sandbox(["--gateway"], **kwargs)


def load_gateway():
    # Stop the script at its inherited-listener boundary, not inside admission logic.
    def inert_init(server, *args, **kwargs):
        server.socket = mock.Mock()
    with mock.patch.object(http.server.ThreadingHTTPServer, "__init__", inert_init), \
         mock.patch.object(http.server.ThreadingHTTPServer, "serve_forever"), \
         mock.patch("socket.socket") as inherited_socket:
        module = runpy.run_path(str(SOURCE / "gateway.py"))
        inherited_socket.assert_called_once_with(fileno=0)
        return module


class GatewayContracts(unittest.TestCase):
    def setUp(self):
        self.module = load_gateway()
        self.handler = self.module["Handler"]
        self.temporary = tempfile.TemporaryDirectory(prefix="public-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.path = str(Path(self.temporary.name) / "app.sock")
        self.requests = []
        self.response = b"public result"
        self.kind = "text/html; charset=utf-8"
        fixture = self

        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                fixture.requests.append((self.command, self.path, dict(self.headers), body))
                self.send_response(201)
                for name, value in (("Content-Type", fixture.kind), ("Content-Length", str(len(fixture.response))),
                                    ("Set-Cookie", "secret=yes"), ("Location", "https://private.invalid/"),
                                    ("Access-Control-Allow-Origin", "*"), ("X-Frame-Options", "ALLOWALL"),
                                    ("Content-Security-Policy", "default-src *")):
                    self.send_header(name, value)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(fixture.response)

            do_GET = do_HEAD = do_POST

        self.upstream = socketserver.UnixStreamServer(self.path, Upstream)
        self.upstream_thread = threading.Thread(target=lambda: self.upstream.serve_forever(poll_interval=0.01))
        self.upstream_thread.start()
        self.addCleanup(self.stop_upstream)

        def connect(connection):
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(1)
            connection.sock.connect(self.path)
        self.connection_patch = mock.patch.object(self.module["UnixHTTP"], "connect", connect)
        self.connection_patch.start()
        self.addCleanup(self.connection_patch.stop)

    def stop_upstream(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        self.upstream_thread.join(1)
        self.assertFalse(self.upstream_thread.is_alive())

    def request(self, raw, *, method="GET"):
        incoming, client = socket.socketpair()
        client.settimeout(2)
        errors = []

        def handle():
            try:
                self.handler(incoming, ("127.0.0.1", 1), types.SimpleNamespace())
            except BaseException as error:
                errors.append(error)
            finally:
                incoming.close()

        worker = threading.Thread(target=handle)
        worker.start()
        try:
            client.sendall(raw)
            client.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(client, method=method)
            response.begin()
            status, headers, body = response.status, dict(response.getheaders()), response.read()
            response.close()
            return status, headers, body
        finally:
            client.close()
            worker.join(2)
            self.assertFalse(worker.is_alive(), "gateway request exceeded fixture bound")
            self.assertEqual(errors, [])

    def test_admission_rejects_without_contacting_upstream(self):
        cases = [(400, b""), (400, b"Host: private.invalid\r\n"),
                 (400, b"Host: 127.0.0.1:8899\r\nHost: localhost:8899\r\n")]
        host = b"Host: 127.0.0.1:8899\r\n"
        cases += [(400, host + name + b": present\r\n") for name in
                  (b"Authorization", b"Cookie", b"Proxy-Authorization", b"Transfer-Encoding", b"Upgrade")]
        cases += [(403, host + b"Origin: http://localhost:8899\r\n"),
                  (403, host + b"Sec-Fetch-Site: cross-site\r\n"),
                  (403, host + b"Sec-Fetch-Site: same-site\r\n"),
                  (400, host + b"Content-Length: 0\r\nContent-Length: 0\r\n"),
                  (400, host + b"Content-Length: -1\r\n"),
                  (400, host + b"Content-Length: unknown\r\n"),
                  (413, host + b"Content-Length: 1048577\r\n")]
        for expected, headers in cases:
            with self.subTest(headers=headers):
                status, _, _ = self.request(b"GET / HTTP/1.1\r\n" + headers + b"\r\n")
                self.assertEqual(status, expected)
                self.assertEqual(self.requests, [])
        for target in (b"relative", b"http://private.invalid/"):
            with self.subTest(target=target):
                status, _, _ = self.request(b"GET " + target + b" HTTP/1.1\r\n" + host + b"\r\n")
                self.assertEqual(status, 400)
                self.assertEqual(self.requests, [])
        status, _, _ = self.request(b"TRACE / HTTP/1.1\r\n" + host + b"\r\n", method="TRACE")
        self.assertEqual(status, 501)
        self.assertEqual(self.requests, [])

    def test_actual_forwarding_strips_untrusted_headers_in_both_directions(self):
        raw = (b"POST /submit?q=literal HTTP/1.1\r\nHost: localhost:8899\r\n"
               b"Sec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\nContent-Length: 2\r\n"
               b"X-Private-Token: do-not-forward\r\nX-Forwarded-Host: private.invalid\r\n\r\n{}")
        status, headers, body = self.request(raw, method="POST")
        self.assertEqual((status, body), (201, self.response))
        method, path, forwarded, body = self.requests[0]
        self.assertEqual((method, path, body), ("POST", "/submit?q=literal", b"{}"))
        self.assertEqual(forwarded["Host"], "public-application")
        self.assertEqual(forwarded["Content-Type"], "application/json")
        self.assertEqual(forwarded["Content-Length"], "2")
        self.assertEqual(set(forwarded) - {"Accept-Encoding"}, {"Host", "Content-Length", "Content-Type"})
        for name in ("Set-Cookie", "Location", "Access-Control-Allow-Origin"):
            self.assertNotIn(name, headers)
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("connect-src 'none'", headers["Content-Security-Policy"])
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_long_content_type_is_not_forwarded_and_unknown_response_type_is_not_active(self):
        self.kind = "image/svg+xml"
        raw = b"GET / HTTP/1.0\r\nHost: localhost:8899\r\nContent-Type: " + b"x" * 160 + b"\r\n\r\n"
        status, headers, _ = self.request(raw)
        self.assertEqual(status, 201)
        self.assertNotIn("Content-Type", self.requests[0][2])
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_response_limit_and_unavailable_upstream_are_explicit_errors(self):
        self.assertEqual(self.module["MAX_BODY"], 1024 * 1024)
        self.assertEqual(self.module["MAX_RESPONSE"], 8 * 1024 * 1024)
        raw = b"GET / HTTP/1.0\r\nHost: localhost:8899\r\n\r\n"
        self.response = b"x" * 33
        with mock.patch.dict(self.handler.handle_app.__globals__, {"MAX_RESPONSE": 32}):
            status, _, body = self.request(raw)
            self.assertEqual(status, 502)
            self.assertNotEqual(body, self.response)
        with mock.patch.object(self.module["UnixHTTP"], "connect", side_effect=OSError("fixture unavailable")):
            status, _, _ = self.request(raw)
            self.assertEqual(status, 503)

    def test_head_has_no_response_body(self):
        status, _, body = self.request(b"HEAD / HTTP/1.0\r\nHost: localhost:8899\r\n\r\n", method="HEAD")
        self.assertEqual((status, body), (201, b""))

    def test_thread_capacity_closes_excess_connections_and_releases_slot_on_failure(self):
        server = self.module["Server"].__new__(self.module["Server"])
        server.slots = threading.BoundedSemaphore(1)
        server.slots.acquire()
        request = mock.Mock()
        with mock.patch.object(http.server.ThreadingHTTPServer, "process_request") as dispatch:
            server.process_request(request, ("127.0.0.1", 1))
            request.close.assert_called_once_with()
            dispatch.assert_not_called()
        with mock.patch.object(http.server.ThreadingHTTPServer, "process_request_thread", side_effect=RuntimeError("fixture")):
            with self.assertRaises(RuntimeError):
                server.process_request_thread(request, ("127.0.0.1", 1))
        with mock.patch.object(http.server.ThreadingHTTPServer, "process_request") as dispatch:
            server.process_request(request, ("127.0.0.1", 1))
            dispatch.assert_called_once_with(request, ("127.0.0.1", 1))
        self.assertFalse(server.slots.acquire(False))
        server.slots.release()


if __name__ == "__main__":
    unittest.main()
