// Precompressed twins for the built client. Every browser load of the router
// used to transfer about a megabyte of uncompressed JavaScript, CSS and vendor
// script; Bun's file responses do not compress on the fly, so the build writes
// `.br` and `.gz` beside each text asset and `webResponse` picks one per
// request. Compression happens once here instead of once per request, at the
// highest quality both formats offer.
//
// Output is deterministic: zlib's brotli and gzip encoders are stable for the
// same input and settings, and Node writes MTIME 0 into the gzip header, so a
// rebuild of unchanged input produces byte-identical twins.
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Text formats worth compressing. Fonts, images and archives are already compressed. */
const COMPRESSIBLE = /\.(?:js|mjs|cjs|css|html|svg|json|webmanifest|map|txt|xml|ico)$/i;

/** Below this, the twin costs more in round trips and inodes than it saves. */
const MINIMUM_BYTES = 1024;

const TWIN = /\.(?:br|gz)$/;

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * Writes `.br` and `.gz` beside every compressible file in `directory`, and
 * removes twins left behind for files that no longer exist. Returns a summary
 * of what it wrote.
 */
export function compressDirectory(directory) {
  const root = resolve(directory);
  if (!existsSync(root)) throw new Error(`No such directory to compress: ${root}`);
  const written = [];
  let original = 0;
  let brotli = 0;
  for (const path of files(root)) {
    if (TWIN.test(path)) {
      if (!existsSync(path.replace(TWIN, ""))) rmSync(path, { force: true });
      continue;
    }
    if (!COMPRESSIBLE.test(path)) continue;
    const source = readFileSync(path);
    if (source.byteLength < MINIMUM_BYTES) continue;
    const encoded = {
      br: brotliCompressSync(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
        },
      }),
      gz: gzipSync(source, { level: 9 }),
    };
    original += source.byteLength;
    brotli += encoded.br.byteLength;
    for (const [extension, body] of Object.entries(encoded)) {
      const twin = `${path}.${extension}`;
      // A twin that grew is worse than the original; drop any stale copy too.
      if (body.byteLength >= source.byteLength) { rmSync(twin, { force: true }); continue; }
      writeFileSync(twin, body);
      written.push(twin);
    }
  }
  return { root, written, original, brotli };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, "web/dist");
  const { written, original, brotli } = compressDirectory(target);
  const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
  console.log(`compressed ${written.length / 2} assets: ${kb(original)} to ${kb(brotli)} brotli`);
  // Largest first, so a regression in bundle size is visible in the build log.
  const largest = written.filter((path) => path.endsWith(".br")).map((path) => ({ path, size: statSync(path).size }))
    .sort((left, right) => right.size - left.size).slice(0, 5);
  for (const entry of largest) console.log(`  ${kb(entry.size)}\t${entry.path.slice(target.length + 1)}`);
}
