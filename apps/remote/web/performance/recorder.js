(() => {
  if (window.piClientTiming) return { state: "already-installed" };
  const records = [];
  const longTasks = [];
  const animationFrames = [];
  const events = [];
  const fetches = [];
  let active = null;
  const observers = [];
  const supported = PerformanceObserver.supportedEntryTypes;
  for (const [type, into] of [["longtask", longTasks], ["long-animation-frame", animationFrames], ["event", events]]) {
    if (!supported.includes(type)) continue;
    const observer = new PerformanceObserver(list => into.push(...list.getEntries()));
    observer.observe(type === "event" ? { type, durationThreshold: 16, buffered: true } : { type, buffered: true });
    observers.push(observer);
  }
  const publicSegments = new Set("items placement instructions admission images meeting browser frame answer context commands children questions bodies heads transcript-window context-window color command reactions unarchive archive abort resume prompt fork events timeline reconcile health actions errors diagnostics loop-lag requests governor-controls speech speech-engines utterances workspaces uploads init messaging conversations v1 remote orchestrator threads thread sessions session transcript history entries messages message queue inspector control bootstrap dashboard notifications network environment unlock auth calendar settings events subscriptions refresh files roots directory tree content life goals commitments preferences needs-you coverage policy agents models providers capabilities phone devices extension-governor ui-errors".split(" "));
  function route(raw) {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return ":external";
    if (url.pathname.startsWith("/assets/")) return "/assets/:bundle";
    return url.pathname.split("/").map(part => !part || publicSegments.has(part) ? part : ":id").join("/");
  }
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const start = performance.now();
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    const path = route(input instanceof Request ? input.url : String(input));
    const request = { start, method, route: path, state: "pending", status: null, headersMs: null, error: null };
    fetches.push(request);
    try {
      const response = await originalFetch.call(this, input, init);
      Object.assign(request, { state: "completed", status: response.status, headersMs: performance.now() - start });
      return response;
    } catch (error) {
      Object.assign(request, { state: "rejected", error: "fetch-rejected", headersMs: performance.now() - start });
      throw error;
    }
  };
  function visible(selector) {
    return [...document.querySelectorAll(selector)].some(element => element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }));
  }
  function usable(spec) {
    const loading = spec.loading === null ? false : [...document.querySelectorAll(spec.loading.selector)].some(element => element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) && spec.loading.texts.includes(element.textContent.trim()));
    return visible(spec.ready) && (spec.absent === null || !visible(spec.absent)) && !loading;
  }
  function resource(entry) {
    return { route: route(entry.name), initiator: entry.initiatorType, startMs: entry.startTime, durationMs: entry.duration,
      firstByteMs: entry.responseStart ? entry.responseStart - entry.startTime : null,
      serverWaitMs: entry.requestStart && entry.responseStart ? entry.responseStart - entry.requestStart : null,
      bodyMs: entry.responseStart ? entry.responseEnd - entry.responseStart : null,
      transferBytes: entry.transferSize, encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize,
      status: typeof entry.responseStatus === "number" ? entry.responseStatus : null };
  }
  function finish(measurement, state) {
    measurement.observer.disconnect();
    cancelAnimationFrame(measurement.raf);
    clearTimeout(measurement.timer);
    const end = performance.now();
    const tasks = longTasks.filter(entry => entry.startTime >= measurement.start && entry.startTime <= end);
    const frames = animationFrames.filter(entry => entry.startTime >= measurement.start && entry.startTime <= end);
    const inputEvents = events.filter(entry => entry.startTime >= measurement.start - 2 && entry.startTime <= end);
    const result = {
      name: measurement.spec.name, cache: measurement.spec.cache, state, triggerEvent: measurement.triggerEvent,
      firstRenderMs: measurement.firstRender, usableMs: measurement.firstUsable, settledMs: state === "settled" ? end - measurement.start : null,
      observationMs: end - measurement.start, mutations: measurement.mutations,
      frames: { count: measurement.gaps.length, maxGapMs: measurement.gaps.length ? Math.max(...measurement.gaps) : null, over50Ms: measurement.gaps.filter(value => value > 50).length },
      longTasks: { count: tasks.length, totalMs: tasks.reduce((sum, entry) => sum + entry.duration, 0), maxMs: tasks.length ? Math.max(...tasks.map(entry => entry.duration)) : 0 },
      js: { supported: supported.includes("long-animation-frame"), frameCount: frames.length, durationMs: frames.reduce((sum, entry) => sum + entry.duration, 0), blockingMs: frames.reduce((sum, entry) => sum + entry.blockingDuration, 0), scriptMs: frames.reduce((sum, entry) => sum + entry.scripts.reduce((total, script) => total + script.duration, 0), 0) },
      input: inputEvents.map(entry => ({ type: entry.name, durationMs: entry.duration, delayMs: entry.processingStart - entry.startTime, processingMs: entry.processingEnd - entry.processingStart })),
      requests: fetches.filter(entry => entry.start >= measurement.start && entry.start <= end).map(({start, ...entry}) => ({...entry, startMs: start - measurement.start})),
      resources: performance.getEntriesByType("resource").filter(entry => entry.startTime >= measurement.start && entry.startTime <= end).map(entry => ({...resource(entry), startMs: entry.startTime - measurement.start})),
    };
    records.push(result);
    active = null;
    measurement.resolve(result);
  }
  function start(event) {
    if (!active || active.start !== null) return;
    const measurement = active;
    if (!event.target.closest(measurement.spec.trigger)) return;
    measurement.triggerEvent = event.type;
    measurement.start = performance.now();
    measurement.lastMutation = measurement.start;
    measurement.previousFrame = measurement.start;
    measurement.observer = new MutationObserver(mutations => {
      measurement.mutations += mutations.length;
      measurement.lastMutation = performance.now();
      if (measurement.firstMutation === null) measurement.firstMutation = measurement.lastMutation;
    });
    const scope = document.querySelector(measurement.spec.scope);
    if (!scope) return finish(measurement, "missing-scope");
    measurement.observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true });
    const tick = now => {
      measurement.gaps.push(now - measurement.previousFrame);
      measurement.previousFrame = now;
      if (measurement.firstMutation !== null && measurement.firstRender === null) measurement.firstRender = now - measurement.start;
      if (usable(measurement.spec) && measurement.firstUsable === null) measurement.firstUsable = now - measurement.start;
      const latestResource = performance.getEntriesByType("resource").filter(entry => entry.startTime >= measurement.start).reduce((latest, entry) => Math.max(latest, entry.responseEnd), measurement.start);
      const pending = fetches.some(entry => entry.start >= measurement.start && entry.state === "pending");
      if (!pending && measurement.firstUsable !== null && now - Math.max(measurement.lastMutation, latestResource) >= measurement.spec.quietMs) return finish(measurement, "settled");
      measurement.raf = requestAnimationFrame(tick);
    };
    measurement.raf = requestAnimationFrame(tick);
    measurement.timer = setTimeout(() => finish(measurement, "settle-timeout"), measurement.spec.timeoutMs);
  }
  document.addEventListener("pointerdown", start, true);
  document.addEventListener("click", start, true);
  document.addEventListener("input", start, true);
  window.piClientTiming = {
    arm(spec) {
      if (active) return { ok: false, error: "measurement-active" };
      if (!spec || !["name", "cache", "trigger", "scope", "ready"].every(key => typeof spec[key] === "string") || !(spec.absent === null || typeof spec.absent === "string") || !(spec.loading === null || (typeof spec.loading?.selector === "string" && Array.isArray(spec.loading.texts))) || !(spec.quietMs > 0) || !(spec.timeoutMs > spec.quietMs)) return { ok: false, error: "invalid-spec" };
      try {
        for (const selector of [spec.trigger, spec.scope, spec.ready, spec.absent, spec.loading?.selector].filter(value => value !== null && value !== undefined)) document.querySelector(selector);
      } catch { return { ok: false, error: "invalid-selector" }; }
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      active = { spec, start: null, firstMutation: null, firstRender: null, firstUsable: null, mutations: 0, gaps: [], promise, resolve, observer: new MutationObserver(() => {}) };
      return { ok: true };
    },
    async take() {
      if (active) return active.start === null ? { state: "not-triggered" } : active.promise;
      return records.length ? records.at(-1) : { state: "no-measurement" };
    },
    all() { return records; },
    navigation() {
      return {
        navigation: performance.getEntriesByType("navigation").map(entry => ({durationMs: entry.duration, firstByteMs: entry.responseStart, bodyMs: entry.responseEnd - entry.responseStart, interactiveMs: entry.domInteractive, contentLoadedMs: entry.domContentLoadedEventEnd, loadMs: entry.loadEventEnd})),
        resources: performance.getEntriesByType("resource").map(resource),
        paint: performance.getEntriesByType("paint").map(entry => ({ name: entry.name, startMs: entry.startTime })),
        longTasks: longTasks.map(entry => ({ startMs: entry.startTime, durationMs: entry.duration })),
        js: animationFrames.map(entry => ({ startMs: entry.startTime, durationMs: entry.duration, blockingMs: entry.blockingDuration, scriptMs: entry.scripts.reduce((sum, script) => sum + script.duration, 0) })),
        supported,
      };
    },
    dispose() {
      if (active !== null) {
        if (active.start !== null) finish(active, "disposed");
        else { active.resolve({ state: "disposed-before-input" }); active = null; }
      }
      document.removeEventListener("pointerdown", start, true);
      document.removeEventListener("click", start, true);
      document.removeEventListener("input", start, true);
      observers.forEach(observer => observer.disconnect());
      window.fetch = originalFetch;
      delete window.piClientTiming;
      return { state: "disposed" };
    },
  };
  return { state: "installed", supported };
})()
