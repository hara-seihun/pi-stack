import { expect, test } from "bun:test";
import { fileKind } from "./src/features/files/file-kind";

test("classifies known file names", () => {
  expect(fileKind("/work/photo.JPG")).toBe("image");
  expect(fileKind("/work/notes.md")).toBe("markdown");
  expect(fileKind("/work/guide.pdf")).toBe("pdf");
  expect(fileKind("/work/config.yaml")).toBe("text");
  expect(fileKind("/work/.gitignore")).toBe("text");
  expect(fileKind("/work/Makefile")).toBe("text");
  expect(fileKind("/work/release.tar.gz")).toBe("binary");
});

test("uses content type when a name gives no answer", () => {
  expect(fileKind("/work/blob", "image/webp")).toBe("image");
  expect(fileKind("/work/blob", "text/markdown; charset=utf-8")).toBe("markdown");
  expect(fileKind("/work/blob", "application/json")).toBe("text");
  expect(fileKind("/work/blob", "application/pdf")).toBe("pdf");
  expect(fileKind("/work/blob", "application/octet-stream")).toBe("binary");
});
