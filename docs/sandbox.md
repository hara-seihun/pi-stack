# Sandbox profile

Sandbox is a raw model conversation with exactly four upstream Pi tools: `bash`, `read`, `write`, and `edit`. It loads no skills, instruction files, prompt templates, discovered extensions, thread/delegation tools, or Remote harness prompt. Provider routing, usage accounting and context reporting remain outside the model's workspace. Like Raw, the effective system prompt is empty; a provider may require its own minimal default instruction.

## Use

Choose **Sandbox** in Remote's new-chat picker, then choose the model. Each thread receives a fresh persistent folder. Inside all four tools it is `/workspace`, also the shell's home. Files, caches and user-installed packages remain there across turns and session restarts. Use `pwd`, relative paths, Python virtual environments and npm local installs normally. The bash description lists runtime and installation details.

The thread owner allocates `<sessionsDir>/sandboxes/<thread-id>`; callers cannot replace that with an arbitrary host directory. The native transcript and credentials stay outside this folder. Separate threads do not share their folders. The owner can stage inputs directly into the folder or retrieve outputs from it. Attaching a host filename does not grant the sandbox access to that file.

Stopping a tool cancels its subprocess tree. Closing or hiding a chat does not delete its workspace. To remove a test's files, stop the thread, retain any wanted outputs, then remove that thread's sandbox directory. Never remove the enclosing sessions directory: it owns native history.

## Boundary

All four tools execute filesystem operations inside a Bubblewrap namespace, not through host-path prefix checks. The workspace is writable; the declared base runtime is read-only. The namespace has its own processes, network and temporary filesystem. Host homes, credentials, service sockets, host processes and undeclared files are absent. Absolute paths and symlinks resolve in that namespace. No privileged execution or host shell RPC is available. Sandbox execution metadata is immutable, cannot be combined with an application context, root-repair or a thread mode, and cannot create workers. Inline image tags do not submit image generation from these threads.

The read-only base runtime is the necessary exception to “only its folder”: a shell and installed language runtime must be able to read and execute their own binaries/libraries. This profile is for internal tests, not a VM or resource quota. It shares the host kernel and consumes host CPU, memory and disk.

[Package downloads](../packages/orchestrator/docs/sandbox-egress.md) use HTTP/HTTPS proxy variables inside the private network namespace. The host-side proxy accepts public destinations, resolves and pins addresses, and rejects loopback, private LAN, link-local, Tailscale, metadata and local host addresses. It supplies no credentials. Tools that ignore HTTP proxy settings have no direct network route. This permits user-space package installation without making the host's service APIs another tool surface.

## Benchmark egress profile

Evaluation harnesses select the immutable boundary when creating a thread:

```json
{"raw":true,"sandbox":true,"sandboxProfile":"benchmark","sandboxGateway":{"socketPath":"/host/private/research-gateways/CASE.sock"}}
```

The host runtime manifest declares `gatewayRoot`, an absolute host-owned directory. The gateway socket must resolve beneath that root and outside the workspace; missing configuration, unknown profiles and invalid sockets fail closed. The harness creates one private Unix HTTP socket per case. Requests to `http://research.gateway/PATH` through the namespace's `HTTP_PROXY` become ordinary origin-form HTTP requests to that socket. No other authority (including explicit ports), CONNECT, direct network route, DNS or package downloads is available. The gateway socket itself is not mounted inside the namespace. A redirect cannot expand the allow-list.

The case gateway owns provider keys, cutoff, budgets and audit state outside the workspace. Its socket fixes case identity: requests and edited client scripts cannot supply a different policy. Keep the gateway alive while a case can resume, and remove its socket only after the thread is stopped or cannot resume. The model provider and Orchestrator control traffic run on the host, never through the sandbox network. Ordinary sandboxes without a profile retain public downloads.

Run `runBenchmarkSandboxAcceptance()` from the same module as the ordinary acceptance below for a real namespace proof of HTTPS/provider/HTTP/direct-IP/DNS denial, key/socket absence and search/read forwarding to a host-policy fixture. The fixture does not prove any research provider or real point-in-time implementation: those belong to the harness acceptance.

## Host configuration

Hosts provide Bubblewrap and a reviewed runtime manifest at `/etc/pi-stack/sandbox-runtime.json`; `PI_SANDBOX_RUNTIME_CONFIG` can select a fixture manifest. The manifest and mounted runtime files are trusted host configuration, not workspace content. Missing configuration or unavailable isolation fails before a model turn; there is no unsandboxed fallback. See `packages/orchestrator/src/threads/pi-sandbox.ts` for the validated manifest contract. NixOS hosts expose only selected runtime closures, not the whole Nix store. Other Linux hosts declare explicit read-only runtime mounts.

To offer the profile to an existing person, add `sandbox` to `environment.PI_REMOTE_DESTINATIONS` and add a destination to `environment.PI_REMOTE_THREAD_DESTINATIONS`:

```json
{
  "id": "sandbox",
  "label": "SANDBOX",
  "icon": "sandbox",
  "accent": "#d29922",
  "workspaceId": "home",
  "raw": true,
  "sandbox": true,
  "thinkingLevel": "high",
  "models": ["astra", "sol", "luna", "fable", "opus"],
  "defaultModel": "astra"
}
```

Use `pi-remote person update USER` with the full preserved person JSON on stdin. Activate with a normal host release; do not restart live meetings merely to change the picker. New registrations include the definition. Hosts must provision the runtime before enabling it.

## Focused checks

The thread-service and Pi-session tests prove workspace allocation, immutable policy and the exact model-facing tool set. The `pi-sandbox` tests exercise actual namespace operations, escape denial and user installs; the egress tests cover destination validation. No model subscription request is needed for these checks. Run the maintained acceptance against a built or deployed Orchestrator module:

```sh
node --input-type=module -e 'import {runSandboxAcceptance} from "/srv/pi/pi-orchestrator/dist/threads/pi-sandbox-acceptance.js"; console.log(JSON.stringify(await runSandboxAcceptance()))'
```

It creates and cleans a temporary workspace, exercises the four tools and denied escapes, and installs small pinned npm/Python packages through the proxy. The local namespace test is explicitly enabled with `PI_SANDBOX_TEST=1 npm test --workspace=pi-orchestrator -- tests/pi-sandbox.test.ts`. Runtime manifests and host activation receipts belong to each machine's handbook.
