import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the pinned upstream RPC protocol, replacing only process ownership
// with session-local IO. No stdin, signal handlers, or process.exit per session.
export function sharedRpcSource(source) {
  const replace = (before, after) => {
    if (!source.includes(before)) throw new Error(`Shared RPC patch no longer matches Pi: ${before.slice(0, 90)}`);
    source = source.replace(before, after);
  };
  replace('export async function runRpcMode(runtimeHost) {\n    takeOverStdout();',
    'export async function runSharedRpcMode(runtimeHost, io) {\n    const waitForRawStdoutBackpressure = () => io.drain?.() ?? Promise.resolve();');
  replace('writeRawStdout(serializeJsonLine(obj));', 'io.output(obj);');
  replace('    registerSignalHandlers();', '    // The shared runner owns process signals.');
  const begin = source.indexOf('    async function shutdown(exitCode = 0, signal) {');
  const end = source.indexOf('    async function checkShutdownRequested()', begin);
  if (begin < 0 || end < 0) throw new Error('Missing RPC shutdown boundary');
  source = source.slice(0, begin) + `    async function shutdown(exitCode = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        unsubscribe?.();
        unsubscribeBackpressure?.();
        for (const request of pendingExtensionRequests.values()) request.resolve({cancelled: true});
        pendingExtensionRequests.clear();
        await runtimeHost.session.abort();
        await runtimeHost.dispose();
        detachInput();
        io.exit(exitCode);
    }
` + source.slice(end);
  const input = source.indexOf('    const onInputEnd = () => {');
  if (input < 0 || !source.includes('    return new Promise(() => { });')) throw new Error('Missing RPC input boundary');
  source = source.slice(0, input) + `    return {
        command: value => handleInputLine(JSON.stringify(value)),
        close: () => shutdown(),
    };
}
`;
  return source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = join(process.argv[2], '@earendil-works/pi-coding-agent/dist/modes/rpc');
  const destination = join(directory, 'shared-rpc-mode.js');
  const source = sharedRpcSource(readFileSync(join(directory, 'rpc-mode.js'), 'utf8'));
  if (!existsSync(destination) || readFileSync(destination, 'utf8') !== source) {
    const temporary = `${destination}.${randomUUID()}`;
    try { writeFileSync(temporary, source); renameSync(temporary, destination); }
    finally { rmSync(temporary, { force: true }); }
  }
}
