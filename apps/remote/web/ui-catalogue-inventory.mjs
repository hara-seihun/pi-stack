import ts from "typescript";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "src");
const output = join(root, "ui-catalogue", "source-inventory.json");
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? entry.name === "ui-catalogue" ? [] : files(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
function hasJsx(node) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return ts.forEachChild(node, hasJsx) === true;
}
function usedComponents(node, names = new Set()) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const name = node.tagName.getText();
    if (/^[A-Z]/.test(name)) names.add(name);
  }
  ts.forEachChild(node, child => { usedComponents(child, names); });
  return [...names].sort();
}
const components = [];
const unions = [];
const fingerprints = {};
const digest = content => createHash("sha256").update(content).digest("hex");
for (const path of files(root)) {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const owner = relative(root, path);
  fingerprints[owner] = digest(text);
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node)) && node.name && /^[A-Z]/.test(node.name.getText()) && hasJsx(node)) {
      components.push({ name: node.name.getText(), path: owner, children: usedComponents(node) });
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
      const variants = node.type.types.map(type => {
        if (ts.isLiteralTypeNode(type)) return type.literal.getText();
        if (ts.isTypeLiteralNode(type)) return type.members.filter(member => ts.isPropertySignature(member) && member.type && ts.isLiteralTypeNode(member.type)).map(member => `${member.name.getText()}:${member.type.literal.getText()}`).join(",");
        return null;
      }).filter(value => value !== null && value !== "");
      if (variants.length) unions.push({ name: node.name.getText(), path: owner, variants });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
function styles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? entry.name === "ui-catalogue" ? [] : styles(path) : entry.name.endsWith(".css") ? [path] : [];
  });
}
const styleFingerprint = digest([join(root, "..", "styles.css"), ...styles(root)].sort().map(path => `${relative(root, path)}:${readFileSync(path, "utf8")}`).join("\n"));
writeFileSync(output, JSON.stringify({ components, unions, fingerprints, styleFingerprint }, null, 2) + "\n");
console.log(`${components.length} JSX owners and ${unions.length} literal union contracts inventoried; inventory is discovery, not visual evidence.`);
