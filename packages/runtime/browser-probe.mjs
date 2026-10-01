import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Keep the isolated-script contract, but batch the recurring linear checks. Each
// wrapper call otherwise repeats session-policy and page probes before its CLI.
export async function probeBrowser(tool, { url, title, visibleTextCheck, frameValue, screenshotPath, downloadPath, downloadContent, record = () => {} }) {
  const execute = async (phase, input) => {
    const started = performance.now();
    const answer = await tool.execute(randomUUID(), { timeoutMs: 20000, ...input }, AbortSignal.timeout(25000));
    record({ phase, elapsedMs: Math.round(performance.now() - started), result: answer });
    assert.equal(answer.details.resultCategory, "success", JSON.stringify(answer));
    return answer.details;
  };
  const script = await execute("isolated-script", { script: `
    const opened = await browser({ args: ["open", ${JSON.stringify(url)}] });
    if (!opened.ok) throw new Error(opened.error);
    const snapshot = await browser({ args: ["snapshot", "-i"] });
    if (!snapshot.ok) throw new Error(snapshot.error);
    emit({ refs: Object.keys(snapshot.data.refs).length });
  ` });
  assert.ok(script.data.refs >= 3);
  assert.equal(script.scriptSession.cleanup, "closed", "the isolated probe browser must be closed");

  const ownerName = `doctor-host-${randomUUID()}`;
  const attachedName = `doctor-attach-${randomUUID()}`;
  let cdpUrl;
  let attachAttempted = false;
  const ownerArgs = ["--session", ownerName];
  const attachedArgs = () => ["--session", attachedName, "--cdp", cdpUrl];
  const batch = async (phase, prefix, steps) => {
    const details = await execute(phase, { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify(steps) });
    assert.equal(details.data.length, steps.length, `${phase}: every command must finish`);
    for (const row of details.data) assert.equal(row.success, true, JSON.stringify(row));
    return details;
  };
  const frameSteps = (selector) => [
    ["frame", selector], ["snapshot", "-i"], ["fill", "#frame-input", frameValue],
    ["get", "value", "#frame-input"], ["eval", "location.hostname"], ["get", "url"],
  ];
  const checkFrame = (rows, label) => {
    assert.equal(rows[3].result.value, frameValue, `${label} fill must reach the input`);
    assert.equal(rows[4].result.result, "localhost", `${label} eval must run in the selected frame`);
  };
  try {
    const page = await batch("page-and-artifacts", ownerArgs, [
      ["open", url], ["snapshot", "-i"], visibleTextCheck,
      ["get", "title"], ["screenshot", screenshotPath], ["get", "cdp-url"],
    ]);
    assert.equal(page.data[3].result.title, title);
    const refs = page.data[1].result.refs;
    assert.ok(Object.keys(refs).length >= 3);
    const downloadRef = Object.entries(refs).find(([, ref]) => ref.name === "Download probe")?.[0];
    assert.ok(downloadRef, "Download probe ref missing");
    assert.equal(page.artifactVerification.verified, true, "the native screenshot artifact must be verified");
    assert.equal(readFileSync(screenshotPath).subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the native screenshot must be a PNG");
    cdpUrl = page.data[5].result.cdpUrl;
    assert.ok(cdpUrl, "the owner must expose its CDP endpoint");

    const frames = await batch("download-and-frames", ownerArgs, [
      ["download", `@${downloadRef}`, downloadPath],
      ...frameSteps("iframe[title='Secure payment input frame']"),
      ["frame", "main"],
      ["eval", `new Promise(resolve => { const f = document.createElement('iframe'); f.id = 'dynamic-frame'; f.src = ${JSON.stringify(new URL("/frame", url).href.replace("127.0.0.1", "localhost"))}; f.onload = () => resolve(true); document.body.append(f); })`],
      ["get", "url"],
      ...frameSteps("#dynamic-frame"),
    ]);
    assert.equal(frames.artifactVerification.verified, true, "the native download artifact must be verified");
    assert.equal(readFileSync(downloadPath, "utf8"), downloadContent, "the native download must preserve file bytes");
    checkFrame(frames.data.slice(1, 7), "cross-origin frame");
    checkFrame(frames.data.slice(10, 16), "dynamically injected cross-origin frame");

    // Attach only after the owner's OOPIF exists: startup events must survive
    // BrowserManager -> daemon handoff, independently of local navigation.
    attachAttempted = true;
    const attached = await batch("remote-existing-frame", attachedArgs(), [
      ["get", "url"], ...frameSteps("iframe[title='Secure payment input frame']"),
    ]);
    checkFrame(attached.data.slice(1), "remote existing frame");
  } finally {
    try {
      if (attachAttempted) await execute("attached-cleanup", { args: [...attachedArgs(), "close"] });
    } finally {
      await execute("owner-cleanup", { args: [...ownerArgs, "close"] });
    }
  }
}
