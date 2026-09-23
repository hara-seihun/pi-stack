import { spawn } from "node:child_process";

const MAX_SVG_BYTES = 4 * 1024 * 1024;

/**
 * Render a device-link URI as inline SVG using the host's qrencode. The URI
 * goes over stdin so it never appears in process arguments. A host without
 * qrencode returns null; the client then shows the URI itself, which a phone
 * can open directly.
 */
export function qrSvg(value: string): Promise<string | null> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn("qrencode", ["--type=SVG", "--level=M", "--margin=2", "--output=-"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch { resolve(null); return; }
    let output = "";
    let done = false;
    const settle = (svg: string | null) => { if (!done) { done = true; resolve(svg); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); settle(null); }, 10_000);
    child.on("error", () => { clearTimeout(timer); settle(null); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_SVG_BYTES) { child.kill("SIGKILL"); clearTimeout(timer); settle(null); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(value);
    child.on("close", code => {
      clearTimeout(timer);
      settle(code === 0 ? element(output) : null);
    });
  });
}

/** Keep only the svg element, without the XML prologue, and let CSS size it. */
function element(output: string): string | null {
  const start = output.indexOf("<svg");
  const end = output.lastIndexOf("</svg>");
  if (start < 0 || end < start) return null;
  const svg = output.slice(start, end + "</svg>".length);
  if (/<(?:script|foreignObject|image|a)\b/i.test(svg)) return null;
  return svg.replace(/^<svg[^>]*>/, tag => tag.replace(/\s(?:width|height)="[^"]*"/g, ""));
}
