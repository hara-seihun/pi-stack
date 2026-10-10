import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export async function settleBrowserProofs(probes) {
  const results = await Promise.allSettled(probes.map(probe => Promise.resolve().then(probe)));
  const failed = results.filter(proof => proof.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(proof => proof.reason), 'native browser proof failed');
}

// Keep the isolated-script contract, but batch the recurring linear checks. Each
// wrapper call otherwise repeats session-policy and page probes before its CLI.
export async function probeBrowser(tool, { url, title, visibleTextCheck, frameValue, screenshotPath, downloadPath, downloadContent, record = () => {} }) {
  const sensitiveValues = ["4242 4242 4242 4242", "4242424242424242", "4000 0000 0000 0077", "4000000000000077", "12/39", "937", "fixture-password-82", "681295"];
  const assertRedacted = (answer) => {
    const serialized = JSON.stringify(answer);
    for (const value of sensitiveValues) assert.ok(!serialized.includes(value), "sensitive fixture value escaped the native boundary");
  };
  const execute = async (phase, input, expectedCategory = "success") => {
    const started = performance.now();
    record({ phase, status: "running", deadlineMs: 25000, command: input });
    console.error(`browser phase=${phase} started command=${JSON.stringify(input)}`);
    let timer, answer;
    try {
      answer = await Promise.race([
        tool.execute(randomUUID(), { timeoutMs: 20000, ...input }, AbortSignal.timeout(25000)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${phase} exceeded subcommand deadline 25000ms`)), 25000); }),
      ]);
    } catch (error) {
      record({ phase, status: "failed", command: input, elapsedMs: Math.round(performance.now() - started), error: String(error) });
      throw error;
    } finally { clearTimeout(timer); }
    if (phase.startsWith("sensitive-")) assertRedacted(answer);
    record({ phase, status: "completed", elapsedMs: Math.round(performance.now() - started), result: answer });
    assert.equal(answer.details.resultCategory, expectedCategory, JSON.stringify(answer));
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

    const checkDates = async (route, date, datetime, fills) => {
      const dates = await batch(`controlled-date-inputs-${route}`, ownerArgs, [
        ...fills,
        ["get", "value", "#controlled-date"], ["get", "value", "#controlled-datetime"],
        ["eval", "JSON.parse(document.querySelector('#controlled-state').textContent)"],
      ]);
      const observed = dates.data.slice(fills.length);
      assert.equal(observed[0].result.value, date, `${route} date fill must retain the DOM value`);
      assert.equal(observed[1].result.value, datetime, `${route} datetime-local fill must retain the DOM value`);
      assert.deepEqual(observed[2].result.result, { date, datetime }, `${route} temporal fill must update React state, not only the DOM`);
    };
    await checkDates("direct", "2026-10-28", "2026-10-28T19:30", [
      ["fill", "#controlled-date", "2026-10-28"], ["fill", "#controlled-datetime", "2026-10-28T19:30"],
      ["fill", "#controlled-timezone", "Etc/UTC"],
    ]);
    await checkDates("find-label", "2030-01-01", "2030-01-01T11:00", [
      ["find", "label", "Controlled date", "fill", "2030-01-01"],
      ["find", "label", "Controlled datetime", "fill", "2030-01-01T11:00"],
      ["find", "label", "Event time zone", "fill", "UTC"],
    ]);
    await execute("controlled-date-semantic", { semanticAction: {
      action: "fill", locator: "label", value: "Controlled date", text: "2031-02-03", session: ownerName,
    } });
    await execute("controlled-datetime-semantic", { semanticAction: {
      action: "fill", locator: "label", value: "Controlled datetime", text: "2031-02-03T12:45", session: ownerName,
    } });
    await execute("controlled-timezone-semantic", { semanticAction: {
      action: "fill", locator: "label", value: "Event time zone", text: "Etc/UTC", session: ownerName,
    } });
    await checkDates("semantic", "2031-02-03", "2031-02-03T12:45", []);

    for (const [route, target] of [
      ["selector", { selector: "#controlled-timezone" }],
      ["label", { locator: "label", value: "Event time zone" }],
      ["role", { locator: "role", role: "textbox", name: "Event time zone" }],
    ]) {
      for (const text of ["0", "nonempty", ""]) {
        await execute(`semantic-fill-${route}-${JSON.stringify(text)}`, { semanticAction: {
          action: "fill", ...target, text, session: ownerName,
        } });
        const value = await batch(`semantic-fill-readback-${route}`, ownerArgs, [
          ["get", "url"], ["get", "value", "#controlled-timezone"],
          ["eval", "document.querySelector('#controlled-timezone-state').textContent"],
        ]);
        assert.equal(value.data[1].result.value, text, `${route} semantic fill must preserve empty and nonempty strings`);
        assert.equal(value.data[2].result.result, text, `${route} semantic fill must update controlled React state, including clearing`);
      }
      const missing = await execute(`semantic-fill-unset-${route}`, { semanticAction: {
        action: "fill", ...target, session: ownerName,
      } }, "failure");
      assert.equal(missing.failureCategory, "validation-error", "unset text must fail before dispatch");
      assert.equal(missing.validationError, "semanticAction.text is required for fill.");
    }

    for (const text of ["0", "nonempty", ""]) {
      const value = await batch(`raw-controlled-text-fill-${JSON.stringify(text)}`, ownerArgs, [
        ["fill", "#controlled-timezone", text], ["get", "value", "#controlled-timezone"],
        ["eval", "document.querySelector('#controlled-timezone-state').textContent"],
      ]);
      assert.equal(value.data[1].result.value, text, "raw fill must retain the DOM value");
      assert.equal(value.data[2].result.result, text, "raw fill must update controlled React state, including clearing");
    }

    for (const command of [
      ["find", "label", "Rejected datetime", "fill", "2030-01-01T11:00"],
      ["fill", "#readonly-date", "2030-01-01"],
    ]) {
      const rejected = await execute("controlled-date-rejection", {
        args: [...ownerArgs, "batch", "--bail"], stdin: JSON.stringify([["get", "url"], command]),
      }, "failure");
      assert.equal(rejected.data.length, 2, "invalid temporal fill must yield an explicit native failure");
      assert.equal(rejected.data[0].success, true);
      assert.equal(rejected.data[1].success, false, "application rejection/readonly cannot report fill success");
      if (command[0] === "find") assert.match(rejected.data[1].error, /fill_value_not_retained/);
    }
    const retained = await batch("controlled-date-rejected-values", ownerArgs, [
      ["get", "value", "#rejected-datetime"], ["get", "value", "#readonly-date"],
    ]);
    assert.equal(retained.data[0].result.value, "2026-10-02T23:00", "application rejection must retain its original controlled value");
    assert.equal(retained.data[1].result.value, "2026-10-02", "readonly rejection must not mutate the input");

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

    const sensitiveResultPath = `${screenshotPath}.sensitive.json`;
    const sensitive = await batch("sensitive-inputs", ownerArgs, [
      ["frame", "main"], ["open", new URL("/sensitive", url).href],
      ["frame", "iframe[title='Sensitive input frame']"], ["snapshot", "-i"],
      ["get", "value", "#cardnumber"], ["get", "value", "#exp-date"],
      ["get", "value", "#cvc"], ["get", "value", "#secret-password"],
      ["get", "value", "#otp"], ["get", "value", "#cardholder"],
      ["get", "text", "body"], ["get", "html", "body"],
    ]);
    assertRedacted(sensitive);
    for (const [index, kind] of [[4, "cc-number"], [5, "cc-exp"], [6, "cc-csc"], [7, "password"], [8, "one-time-code"]]) {
      assert.equal(sensitive.data[index].result.value, `[redacted: ${kind}]`, `sensitive ${kind} getter must return its classification`);
    }
    assert.equal(sensitive.data[9].result.value, "Public Test Name", "cc-name must stay readable");
    const saved = await execute("sensitive-saved-result", {
      args: [...ownerArgs, "snapshot", "-i"], outputPath: sensitiveResultPath,
    });
    assertRedacted(saved);
    assertRedacted(readFileSync(sensitiveResultPath, "utf8"));
    const unsafeImage = `${screenshotPath}.sensitive.png`;
    const unsafePdf = `${screenshotPath}.sensitive.pdf`;
    for (const command of [
      ["eval", "btoa(document.querySelector('#cardnumber').value)"],
      ["screenshot", unsafeImage], ["pdf", unsafePdf],
    ]) {
      const guarded = await execute(`sensitive-unsafe-${command[0]}`, {
        args: [...ownerArgs, "batch", "--bail"], stdin: JSON.stringify([["get", "url"], command]),
      }, "failure");
      assert.equal(guarded.data?.length, 2, "each sensitive unsafe operation must have a typed refusal");
      assert.equal(guarded.data[0].success, true, "the page must remain verifiable without eval");
      assert.equal(guarded.data[1].success, false, "unsafe operations must be refused before execution");
      assert.match(guarded.data[1].error, /^(?:Error: )?SENSITIVE_OUTPUT_UNSUPPORTED/);
    }
    assert.equal(existsSync(unsafeImage), false, "refused screenshots must not leave unprotected artifacts");
    assert.equal(existsSync(unsafePdf), false, "refused PDFs must not leave unprotected artifacts");
  } finally {
    try {
      if (attachAttempted) await execute("attached-cleanup", { args: [...attachedArgs(), "close"] });
    } finally {
      await execute("owner-cleanup", { args: [...ownerArgs, "close"] });
    }
  }
}
