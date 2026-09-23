import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function webBundleBytes(apk) {
  const scratch = mkdtempSync(join(tmpdir(), "kenan-web-bundle-"));
  const options = { env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 };
  try {
    execFileSync("unzip", ["-q", "-o", apk, "assets/public/*", "-d", scratch], options);
    const root = join(scratch, "assets/public");
    if (!existsSync(join(root, "index.html"))) throw new Error("APK has no packaged web client");
    const files = [];
    const collect = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) collect(path, `${name}/`);
        else if (entry.isFile() && !/[\r\n]/.test(name)) {
          chmodSync(path, 0o644);
          utimesSync(path, 315532800, 315532800);
          files.push(`./${name}`);
        } else throw new Error(`Unsupported web bundle entry: ${name}`);
      }
    };
    collect(root);
    const zip = join(scratch, "bundle.zip");
    // Extraction creates directories with wall-clock mtimes. Publish only sorted files,
    // with fixed ZIP metadata, so a repeated preparation retains the same byte identity.
    execFileSync("zip", ["-X", "-q", "-D", zip, "-@"], { ...options, cwd: root, input: `${files.sort().join("\n")}\n` });
    return readFileSync(zip);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
