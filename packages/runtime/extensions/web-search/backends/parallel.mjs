import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function resolveCommand(command, environment = process.env) {
  const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
  if (command.includes("/")) return executable(command) ? command : undefined;
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory && executable(join(directory, command))) return join(directory, command);
  }
  return undefined;
}

export function parallelRequest(request) {
  return { query: request.query, numResults: request.numResults, text: request.text === true,
    ...(request.category ? { category: request.category } : {}),
    ...(request.includeDomains?.length ? { includeDomains: request.includeDomains } : {}),
    ...(request.excludeDomains?.length ? { excludeDomains: request.excludeDomains } : {}),
    ...(request.startPublishedDate ? { startPublishedDate: request.startPublishedDate } : {}) };
}

export function parallelResults(response) {
  if (!response || !Array.isArray(response.results) || response.notes !== undefined && (!Array.isArray(response.notes) || response.notes.some(note => typeof note !== "string"))) throw new Error("Parallel transport returned an invalid search receipt");
  return response.results.map(result => {
    if (!result || typeof result.title !== "string" || typeof result.url !== "string" || typeof result.snippet !== "string"
      || result.text !== undefined && typeof result.text !== "string" || result.publishedDate !== undefined && typeof result.publishedDate !== "string") throw new Error("Parallel transport returned an invalid result");
    const url = new URL(result.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Parallel result requires a public HTTP URL");
    return { title: result.title, url: result.url, snippet: result.snippet,
      ...(result.text === undefined ? {} : { text: result.text }), ...(result.publishedDate === undefined ? {} : { publishedDate: result.publishedDate }) };
  });
}

export function runTransport(command, body, { signal, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Parallel transport exceeded its 45 second deadline")), 45_000);
    const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"], env: environment,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    let stdout = "", stderr = "", bytes = 0;
    let force, failure;
    const stop = () => { force ??= setTimeout(() => child.kill("SIGKILL"), 1000); force.unref(); };
    controller.signal.addEventListener("abort", stop, { once: true });
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); controller.signal.removeEventListener("abort", stop); signal?.removeEventListener("abort", stop); };
    const collect = target => chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 12 * 1024 * 1024) { controller.abort(new Error("Parallel transport exceeded its 12 MiB receipt bound")); return; }
      if (target === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.on("error", error => { failure = controller.signal.aborted ? controller.signal.reason : error; });
    child.on("close", code => { cleanup(); if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on("error", error => { controller.abort(error); });
    child.stdin.end(`${JSON.stringify(body)}\n`);
  });
}

export default {
  id: "parallel", label: "Parallel", summary: "Parallel Web Systems Search and Extract",
  async status({ options = {}, environment = process.env } = {}) {
    const command = options.command ?? "parallel-search";
    if (typeof command !== "string" || !command) return { available: false, reason: "Parallel transport command is invalid" };
    const resolved = resolveCommand(command, environment);
    return resolved ? { available: true, detail: resolved } : { available: false, reason: `${command} is not executable on PATH; this account has no configured Parallel transport` };
  },
  async search(request, { options = {}, environment = process.env, signal } = {}) {
    const command = options.command ?? "parallel-search", resolved = typeof command === "string" && command ? resolveCommand(command, environment) : undefined;
    if (!resolved) throw new Error("Parallel transport is not configured for this account");
    const { code, stdout, stderr } = await runTransport(resolved, parallelRequest(request), { signal, environment });
    if (code !== 0) throw new Error(`Parallel search failed: ${(stderr.trim() || stdout.trim() || `exit ${code}`).slice(0, 2000)}`);
    let receipt;
    try { receipt = JSON.parse(stdout); } catch { throw new Error("Parallel transport returned non-JSON"); }
    if (receipt?.error) throw new Error(`Parallel search failed: ${typeof receipt.error === "string" ? receipt.error : JSON.stringify(receipt.error)}`);
    return { results: parallelResults(receipt), notes: [...(receipt.notes ?? []), ...(stderr.trim() ? [stderr.trim().slice(0, 500)] : [])],
      ...(receipt.requestId === undefined ? {} : { requestId: receipt.requestId }), ...(receipt.usage === undefined ? {} : { usage: receipt.usage }) };
  },
};
