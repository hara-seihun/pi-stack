import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set(["node_modules", "dist", "build", "vendor", ".gradle", ".git", "__pycache__"]);
export function switchDefaults(source, filename) {
  const defects = [];
  if (/\.[cm]?[jt]sx?$/.test(filename)) {
    const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isDefaultClause(node)) {
        const at = file.getLineAndCharacterOfPosition(node.getStart(file));
        defects.push({ line: at.line + 1, message: "Switch dispatch must enumerate its states; use a post-switch exhaustiveness assertion or explicit invalid-input rejection." });
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  if (/\.(?:java|c|h|cpp|hpp)$/.test(filename)) {
    // Remove comments and literals while retaining line positions; object/export defaults are not switch clauses.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, token => token.replace(/[^\n]/g, " "));
    for (const match of code.matchAll(/\bdefault\s*(?::|->)/g)) defects.push({ line: code.slice(0, match.index).split("\n").length, message: "Native state dispatch must enumerate cases and reject invalid inputs explicitly." });
  }
  return defects;
}
export function checkStateDispatch(base = root) {
  const defects = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const name = resolve(path, entry.name);
      if (entry.isDirectory()) { walk(name); continue; }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|java|c|h|cpp|hpp)$/.test(name) || /(?:\.test\.|\/tests?\/|\.min\.js$)/.test(name)) continue;
      for (const defect of switchDefaults(readFileSync(name, "utf8"), name)) defects.push({ path: relative(base, name), ...defect });
    }
  }
  for (const area of ["apps", "packages"]) walk(resolve(base, area));
  return defects;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const defects = checkStateDispatch();
  for (const defect of defects) console.error(`${defect.path}:${defect.line}: ${defect.message}`);
  if (defects.length) process.exitCode = 1;
  else console.log("First-party app/package dispatch has no switch default clauses.");
}
