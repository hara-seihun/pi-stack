export type FileSelectionKind = "directory" | "file";

export interface FileSelection {
  path: string;
  kind: FileSelectionKind | "resolving";
}

export interface PathSegment {
  label: string;
  path: string;
}

export interface FileShortcut {
  label: string;
  path: string;
}

export function cleanAbsolutePath(path: string) {
  const trimmed = path.trim();
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

export function routePath(path: string) {
  return path === "/" ? null : path;
}

export function parentDirectory(path: string) {
  const clean = cleanAbsolutePath(path);
  const slash = clean.lastIndexOf("/");
  return slash > 0 ? clean.slice(0, slash) : "/";
}

export function breadcrumbSegments(path: string): PathSegment[] {
  const clean = cleanAbsolutePath(path);
  if (clean === "/") return [{ label: "/", path: "/" }];
  let current = "";
  return [{ label: "/", path: "/" }, ...clean.split("/").filter(Boolean).map(label => {
    current += `/${label}`;
    return { label, path: current };
  })];
}

export function rootShortcuts(shortcuts: FileShortcut[], currentDirectory: string) {
  const seen = new Set(["/", cleanAbsolutePath(currentDirectory)]);
  return shortcuts.flatMap(shortcut => {
    const path = cleanAbsolutePath(shortcut.path);
    if (!path.startsWith("/") || seen.has(path)) return [];
    seen.add(path);
    return [{ ...shortcut, path }];
  });
}
