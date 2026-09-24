import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteRange, fileContentType, inlineSafe, localFileResponse } from "./files";

const directory = mkdtempSync(join(tmpdir(), "pi-remote-files-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("byte ranges include open and suffix forms", () => {
  expect(byteRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
  expect(byteRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
  expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  expect(byteRange("bytes=-30", 10)).toEqual({ start: 0, end: 9 });
  expect(byteRange("bytes=-", 10)).toBeNull();
  expect(byteRange("bytes=-0", 10)).toBeNull();
  expect(byteRange("bytes=10-", 10)).toBeNull();
});

test("media types use their standard names", () => {
  expect(fileContentType("/x/memo.m4a", "audio/x-m4a")).toBe("audio/mp4");
  expect(fileContentType("/x/clip.mp4", "video/mp4")).toBe("video/mp4");
  expect(fileContentType("/x/blob", "")).toBe("application/octet-stream");
  expect(inlineSafe("audio/mp4")).toBe(true);
  expect(inlineSafe("application/pdf")).toBe(true);
  expect(inlineSafe("image/svg+xml")).toBe(false);
  expect(inlineSafe("text/html")).toBe(false);
});

test("inline=1 displays safe types in place and never scriptable ones", async () => {
  const pdf = join(directory, "report.pdf");
  const page = join(directory, "page.html");
  const audio = join(directory, "memo.m4a");
  writeFileSync(pdf, "%PDF-1.4");
  writeFileSync(page, "<script>alert(1)</script>");
  writeFileSync(audio, "0123456789");
  const get = (path: string, query = "", headers: Record<string, string> = {}) =>
    localFileResponse(path, "GET", new Request(`http://host/v1/files?path=${encodeURIComponent(path)}${query}`, { headers }));
  expect(get(pdf, "&inline=1").headers.get("content-disposition")).toStartWith("inline;");
  expect(get(pdf).headers.get("content-disposition")).toStartWith("attachment;");
  expect(get(page, "&inline=1").headers.get("content-disposition")).toStartWith("attachment;");
  const tail = get(audio, "", { range: "bytes=-4" });
  expect(tail.status).toBe(206);
  expect(tail.headers.get("content-type")).toBe("audio/mp4");
  expect(tail.headers.get("content-range")).toBe("bytes 6-9/10");
  expect(await tail.text()).toBe("6789");
});
