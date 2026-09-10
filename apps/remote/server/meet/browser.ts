import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { MeetResult } from "./protocol";

export class MeetBrowser {
  frame: Buffer | null = null;
  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly endpoint: string,
    private readonly directory: string,
    private readonly cdp: CDPSession,
  ) {}

  static async open(): Promise<MeetResult<MeetBrowser>> {
    const executablePath = process.env.PI_MEET_CHROMIUM || Bun.which("chromium") || Bun.which("google-chrome");
    if (!executablePath) return { ok: false, error: "PiStack Meet needs Chromium on the host PATH or PI_MEET_CHROMIUM" };
    const directory = await mkdtemp(join(tmpdir(), "pi-meet-"));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(directory, {
        executablePath, headless: true, viewport: { width: 1280, height: 720 }, timeout: 15_000,
        args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      });
      const port = Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      if (!Number.isInteger(port) || port < 1) throw new Error("Chromium did not publish its control port");
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(15_000);
      const cdp = await context.newCDPSession(page);
      const browser = new MeetBrowser(context, page, `http://127.0.0.1:${port}`, directory, cdp);
      cdp.on("Page.screencastFrame", (event) => {
        browser.frame = Buffer.from(event.data, "base64");
        void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => { browser.frame = null; });
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
      browser.frame = await page.screenshot({ type: "jpeg", quality: 75 });
      return { ok: true, value: browser };
    } catch (cause) {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
      return { ok: false, error: `Meet browser: ${String(cause)}` };
    }
  }

  async navigate(url: string): Promise<MeetResult<string>> {
    try {
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol)) return { ok: false, error: "Use an http or https browser URL" };
      await this.page.goto(target.href, { waitUntil: "domcontentloaded" });
      this.frame = await this.page.screenshot({ type: "jpeg", quality: 75 });
      return { ok: true, value: this.page.url() };
    } catch (cause) { return { ok: false, error: `Navigation failed: ${String(cause)}` }; }
  }

  async close() {
    this.frame = null;
    await this.context.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}
