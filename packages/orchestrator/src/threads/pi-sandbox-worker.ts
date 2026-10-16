export const sandboxFileWorker = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const constants = require('node:fs').constants;
async function checked(target, allowMissing = false) {
  if (target !== '/workspace' && !target.startsWith('/workspace/')) throw Error('Path must be inside /workspace');
  let cursor = target;
  while (true) {
    try {
      const resolved = await fs.realpath(cursor);
      if (resolved !== '/workspace' && !resolved.startsWith('/workspace/')) throw Error('Symlink leaves /workspace');
      return target;
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT' || cursor === '/workspace') throw error;
      // A dangling symlink is not a missing directory: do not follow it during creation.
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw Error('Dangling symlink'); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      cursor = path.dirname(cursor);
    }
  }
}
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const target = await checked(request.path, request.operation === 'mkdir' || request.operation === 'write');
  if (request.operation === 'read') process.stdout.write(await fs.readFile(target));
  else if (request.operation === 'access') await fs.access(target, request.write ? constants.R_OK | constants.W_OK : constants.R_OK);
  else if (request.operation === 'mkdir') await fs.mkdir(target, {recursive:true});
  else if (request.operation === 'write') await fs.writeFile(target, request.content);
  else if (request.operation === 'mime') {
    const handle = await fs.open(target, 'r');
    try {
      const bytes = Buffer.alloc(16);
      await handle.read(bytes, 0, bytes.length, 0);
      let mime = '';
      if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
      else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
      else if (/^GIF8[79]a/.test(bytes.toString('ascii',0,6))) mime = 'image/gif';
      else if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') mime = 'image/webp';
      else if (bytes.toString('ascii',0,2) === 'BM') mime = 'image/bmp';
      process.stdout.write(mime);
    } finally { await handle.close(); }
  } else throw Error('Unknown sandbox operation');
}
main().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;

// The upstream bash accumulator writes spills on the host. Keep its input below
// both thresholds, while preserving the complete output inside the namespace.
export const sandboxBashWorker = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const {shell, command} = JSON.parse(input);
  const sockets = new Set();
  const proxy = net.createServer(client => {
    const upstream = net.connect('/run/package-proxy.sock');
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(3128, '127.0.0.1', resolve); });
  const outputPath = '/workspace/.pi-output-' + randomUUID() + '.log';
  const fd = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let tail = Buffer.alloc(0), total = 0, lines = 0;
  const collect = chunk => {
    fs.writeSync(fd, chunk);
    total += chunk.length;
    for (const byte of chunk) if (byte === 10) lines++;
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > 40000) tail = tail.subarray(tail.length - 40000);
  };
  const child = spawn(shell, ['--noprofile', '--norc', '-c', command], {stdio:['ignore','pipe','pipe'], env:process.env});
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code === null ? 128 + (require('node:os').constants.signals[signal] || 1) : code));
  });
  fs.closeSync(fd);
  let text = tail.toString('utf8');
  // Malformed UTF-8 expands to replacement characters, so bound decoded bytes too.
  while (Buffer.byteLength(text) > 40000) text = text.slice(Math.ceil(text.length / 8));
  const parts = text.split('\n');
  if (parts.length > 1500) text = parts.slice(-1500).join('\n');
  if (total > 40000 || lines >= 1500 || parts.length > 1500) text += '\n\n[Output truncated. Full output: ' + outputPath + ']';
  else fs.unlinkSync(outputPath);
  process.stdout.write(text);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  process.exitCode = code;
}
main().catch(error => { process.stderr.write(error.message); process.exit(1); });
`;
