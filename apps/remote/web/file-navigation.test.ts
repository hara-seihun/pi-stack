import { describe, expect, test } from "bun:test";
import { breadcrumbSegments, parentDirectory, rootShortcuts, routePath } from "./src/features/files/file-navigation";

describe("file navigation", () => {
  test("uses one root route and keeps a file name out of its parent breadcrumbs", () => {
    const directory = parentDirectory("/home/kenan/report.md");
    expect(directory).toBe("/home/kenan");
    expect(breadcrumbSegments(directory)).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "kenan", path: "/home/kenan" },
    ]);
    expect(routePath("/")).toBeNull();
  });

  test("deduplicates places by destination and omits root and the current folder", () => {
    expect(rootShortcuts([
      { label: "Root", path: "/" },
      { label: "Home", path: "/home/kenan/" },
      { label: "Current session", path: "/home/kenan" },
      { label: "Work", path: "/home/kenan/work" },
    ], "/home/kenan")).toEqual([{ label: "Work", path: "/home/kenan/work" }]);
  });

  test("returns root as the parent of a top-level file", () => {
    expect(parentDirectory("/notes.txt")).toBe("/");
  });
});
