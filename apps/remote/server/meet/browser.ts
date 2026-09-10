import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { MeetResult } from "./protocol";

function reportTabFocus() {
  if (window !== window.top) return;
  const report = () => {
    if (document.visibilityState === "visible") void (window as any).__piMeetFocus();
  };
  window.addEventListener("focus", report);
  document.addEventListener("visibilitychange", report);
  report();
}

export class MeetBrowser {
  frame: Buffer | null = null;
  error: string | null = null;
  watchPath: string | null = null;
  watchError: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchedPage: Page | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloads = Promise.resolve();
  private watchGeneration = 0;
  private closed = false;
  private cdp: CDPSession | null = null;
  private switches = Promise.resolve();
  private desiredPage: Page;

  private constructor(
    readonly context: BrowserContext,
    public page: Page,
    readonly endpoint: string,
    private readonly directory: string,
  ) { this.desiredPage = page; }

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
      const browser = new MeetBrowser(context, page, `http://127.0.0.1:${port}`, directory);
      await context.exposeBinding("__piMeetFocus", ({ page, frame }) => frame === page.mainFrame() ? browser.show(page) : undefined);
      await context.addInitScript(reportTabFocus);
      context.on("page", (page) => { browser.track(page); void browser.show(page); });
      for (const existing of context.pages()) {
        browser.track(existing);
        await existing.evaluate(reportTabFocus);
      }
      const shown = await browser.show(page);
      if (!shown.ok) { await browser.close(); return shown; }
      return { ok: true, value: browser };
    } catch (cause) {
      try { await context?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
      return { ok: false, error: `Meet browser: ${String(cause)}` };
    }
  }

  private track(page: Page) {
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    page.on("close", () => {
      if (this.closed) return;
      if (page === this.watchedPage) {
        this.stopWatching();
        this.watchError = "Project watching stopped because its browser tab closed";
      }
      if (page !== this.desiredPage && page !== this.page) return;
      const remaining = this.context.pages().filter((candidate) => !candidate.isClosed());
      const next = this.desiredPage.isClosed() ? remaining.at(-1) : this.desiredPage;
      if (next) void this.show(next);
      else { this.frame = null; this.error = "All shared browser tabs are closed"; }
    });
  }

  private show(page: Page): Promise<MeetResult<void>> {
    this.desiredPage = page;
    const operation = this.switches.then(async (): Promise<MeetResult<void>> => {
      if (this.closed || page.isClosed() || page !== this.desiredPage) return { ok: true, value: undefined };
      if (page === this.page && this.cdp && !this.error) return { ok: true, value: undefined };
      let candidate: CDPSession | null = null;
      try {
        const previous = this.cdp;
        if (previous && !this.page.isClosed()) {
          try { await previous.detach(); }
          catch (cause) { if (!this.closed && !this.page.isClosed()) throw cause; }
        }
        this.cdp = null;
        candidate = await this.context.newCDPSession(page);
        if (this.closed || page.isClosed() || page !== this.desiredPage) {
          if (!this.closed && !page.isClosed()) await candidate.detach();
          return { ok: true, value: undefined };
        }
        const cdp = candidate;
        this.page = page;
        this.cdp = cdp;
        this.error = null;
        cdp.on("Page.screencastFrame", (event) => {
          if (this.cdp === cdp && !this.closed) this.frame = Buffer.from(event.data, "base64");
          void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch((cause) => {
            if (this.cdp === cdp && !this.closed && !page.isClosed()) {
              this.frame = null;
              this.error = `Browser sharing stopped: ${String(cause)}`;
            }
          });
        });
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
        const capture = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 75, captureBeyondViewport: false });
        if (this.cdp === cdp && !this.closed) this.frame = Buffer.from(capture.data, "base64");
        return { ok: true, value: undefined };
      } catch (cause) {
        const error = `Browser tab sharing failed: ${String(cause)}`;
        if (!this.closed && page === this.desiredPage) { this.frame = null; this.error = error; }
        return { ok: false, error };
      }
    });
    this.switches = operation.then(() => {});
    return operation;
  }

  async navigate(url: string): Promise<MeetResult<string>> {
    try {
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol)) return { ok: false, error: "Use an http or https browser URL" };
      if (this.closed) return { ok: false, error: "The shared browser has closed" };
      const page = this.page.isClosed() ? await this.context.newPage() : this.page;
      await page.bringToFront();
      const shown = await this.show(page);
      if (!shown.ok) return shown;
      await page.goto(target.href, { waitUntil: "domcontentloaded" });
      return { ok: true, value: page.url() };
    } catch (cause) { return { ok: false, error: `Navigation failed: ${String(cause)}` }; }
  }

  async setWatch(directory: string | null): Promise<MeetResult<string | null>> {
    if (this.closed) return { ok: false, error: "The shared browser has closed" };
    if (directory === null) {
      this.stopWatching();
      this.watchError = null;
      return { ok: true, value: null };
    }
    const page = this.page;
    let candidate: FSWatcher | null = null;
    try {
      if (page.isClosed() || !/^https?:/.test(page.url())) return { ok: false, error: "Open the app URL before watching its files" };
      directory = directory.replace(/^@/, "");
      if (!isAbsolute(directory) || !(await stat(directory)).isDirectory()) return { ok: false, error: "watch must be an absolute directory path" };
      directory = resolve(directory);
      candidate = watch(directory, { recursive: true });
    } catch (cause) { return { ok: false, error: `Could not watch project: ${String(cause)}` }; }
    if (this.closed || page.isClosed()) {
      candidate?.close();
      return { ok: false, error: "The project tab closed while starting its watcher" };
    }
    this.stopWatching();
    this.watcher = candidate;
    this.watchedPage = candidate ? page : null;
    this.watchPath = directory;
    this.watchError = null;
    const generation = this.watchGeneration;
    const origin = new URL(page.url()).origin;
    candidate?.on("change", (_event, filename) => {
      if (!filename || /(^|[/\\])(?:node_modules|\.git|dist|build|\.next|\.cache|coverage)([/\\]|$)|\.(?:log|sqlite(?:3)?(?:-wal|-shm)?)$/.test(String(filename))) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        this.reloads = this.reloads.then(async () => {
          if (generation !== this.watchGeneration || page.isClosed() || new URL(page.url()).origin !== origin) return;
          try {
            await page.reload({ waitUntil: "domcontentloaded" });
            this.watchError = null;
          } catch (cause) { this.watchError = `Project reload failed: ${String(cause)}`; }
        });
      }, 250);
    });
    candidate?.on("error", (cause) => {
      if (generation !== this.watchGeneration) return;
      this.stopWatching();
      this.watchError = `Project watcher stopped: ${String(cause)}`;
    });
    return { ok: true, value: directory };
  }

  private stopWatching() {
    this.watchGeneration++;
    this.watcher?.close();
    this.watcher = null;
    this.watchedPage = null;
    this.watchPath = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  async close() {
    this.closed = true;
    this.stopWatching();
    this.frame = null;
    try { await this.context.close(); }
    finally { await rm(this.directory, { recursive: true, force: true }); }
  }
}
