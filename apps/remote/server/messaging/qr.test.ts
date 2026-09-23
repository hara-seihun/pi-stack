import { expect, test } from "bun:test";
import { qrSvg } from "./qr";

const uri = "sgnl://linkdevice?uuid=8b2a0c1e&pub_key=Zm9vYmFyYmF6";

test("a device link URI renders as inline SVG the client can size itself", async () => {
  const svg = await qrSvg(uri);
  if (!Bun.which("qrencode")) { expect(svg).toBeNull(); return; }
  expect(svg?.startsWith("<svg")).toBe(true);
  expect(svg?.endsWith("</svg>")).toBe(true);
  expect(svg).toContain("viewBox");
  expect(svg?.slice(0, svg.indexOf(">"))).not.toContain("width=");
  expect(svg).not.toContain("<?xml");
  expect(svg).not.toContain("<script");
  // Longer payloads produce a denser symbol, so the encoder saw the whole URI.
  const long = await qrSvg(`${uri}&extra=${"a".repeat(400)}`);
  expect(Number(/viewBox="0 0 (\d+)/.exec(long ?? "")?.[1])).toBeGreaterThan(Number(/viewBox="0 0 (\d+)/.exec(svg ?? "")?.[1]));
});

test("a host without qrencode reports no QR instead of failing the link", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try { expect(await qrSvg(uri)).toBeNull(); }
  finally { process.env.PATH = path; }
});
