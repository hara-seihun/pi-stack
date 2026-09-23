import { API } from "../../server/api";
import { meetVoiceControl } from "../../server/meet/protocol";
import { piFetch } from "./client";
import { createStreamClient } from "./stream";

  const MAX_CONTEXT_BYTES = 500;

  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function utf8Chunks(value, maxBytes = MAX_CONTEXT_BYTES) {
    const encoder = new TextEncoder();
    const chunks: string[] = [];
    let chunk = "", bytes = 0;
    for (const character of value) {
      const size = encoder.encode(character).byteLength;
      if (chunk && bytes + size > maxBytes) { chunks.push(chunk); chunk = ""; bytes = 0; }
      chunk += character; bytes += size;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }

  function secondSentenceBoundary(text) {
    const endings = [...text.matchAll(/[.!?](?:["')\]]+)?(?=\s|$)/g)];
    return endings[1]?.index === undefined ? -1 : endings[1].index + endings[1][0].length;
  }

  async function waitForReady(target, options) {
    if (options.ready()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        target.removeEventListener(options.readyEvent, ready);
        if (options.failureEvent) target.removeEventListener(options.failureEvent, failed);
        error ? reject(error) : resolve();
      };
      const ready = () => { if (options.ready()) finish(); };
      const failed = () => finish(new Error(options.failureMessage));
      const timeout = setTimeout(() => finish(new Error(options.timeoutMessage)), options.timeoutMs ?? 15_000);
      target.addEventListener(options.readyEvent, ready);
      if (options.failureEvent) target.addEventListener(options.failureEvent, failed);
    });
  }

  function waitForIce(peer) {
    return waitForReady(peer, {
      ready: () => peer.iceGatheringState === "complete",
      readyEvent: "icegatheringstatechange",
      timeoutMessage: "Voice ICE gathering timed out",
    });
  }

  function waitForChannel(channel) {
    return waitForReady(channel, {
      ready: () => channel.readyState === "open",
      readyEvent: "open",
      failureEvent: "close",
      failureMessage: "GPT-Live closed during startup",
      timeoutMessage: "GPT-Live data channel timed out",
    });
  }

  async function responseError(response, fallback) {
    const text = (await response.text()).slice(0, 2_000);
    try { return JSON.parse(text).error || fallback; }
    catch { return text || fallback; }
  }

  export class VoiceSession {
    [key: string]: any;

    constructor(options: Parameters<Window["PiRemoteVoice"]["create"]>[0]) {
      this.request = options.request || piFetch;
      this.sessionId = options.sessionId;
      this.input = options.input;
      this.onOutput = options.onOutput;
      this.meetingContext = options.meetingContext;
      this.handoffContext = options.handoffContext;
      this.onFragment = options.onFragment;
      this.onPlayback = options.onPlayback || (() => {});
      this.controlledOutput = options.outputMuted !== undefined;
      this.outputMuted = options.outputMuted ?? false;
      this.onVoiceControl = options.onVoiceControl;
      this.delegationQueue = Promise.resolve();
      this.sentTranscriptCursor = 0;
      this.transcript = [];
      this.seenEvents = new Set();
      this.events = new EventTarget();
      this.started = false;
      this.closed = false;
      this.usageSeconds = 0;
      this.closing = null;

      this.stream = null;
      this.onState = options.onState || (() => {});
      this.onNotice = options.onNotice || (() => {});
      this.onTranscript = options.onTranscript || (() => {});
      this.state = "idle";
      this.peer = null;
      this.channel = null;
      this.microphone = null;
      this.speaker = null;
      this.generation = 0;
      this.cursor = 0;
      this.liveTextValue = "";
      this.voiceId = null;
      this.usageTimer = null;
      this.delegations = [];
      this.threadWorking = false;
      this.eventCounts = {};
      this.delegationsSubmitted = 0;
      this.lastDelegationError = null;
      this.lastProtocolError = null;
      this.lastLiveText = "";
      this.messageBuffer = "";
      this.pendingAssistant = "";
      this.streamedMessage = false;
    }

    setState(state, detail = "") {
      this.state = state;
      this.onState(state, detail);
    }

    async start() {
      if (this.state === "connecting" || this.state === "live") return;
      if (this.closing) await this.closing;
      this.started = false; this.closed = false; this.suspended = false; this.startupError = "";
      this.transcript = []; this.seenEvents.clear(); this.usageSeconds = 0;
      this.sentTranscriptCursor = 0; this.delegationQueue = Promise.resolve();
      this.eventCounts = {}; this.delegationsSubmitted = 0;
      this.lastDelegationError = null; this.lastProtocolError = null;
      this.sessionOrigin = Date.now();
      const generation = ++this.generation;
      this.setState("connecting", "Connecting…");
      try {
        if (!this.input && !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable");
        const configResponse = await this.request(API.voice.path(), { cache: "no-store" });
        const config = await configResponse.json();
        if (!configResponse.ok || !config.enabled) throw new Error(config.error || "The PiStack Voice API service is unavailable");
        await this.primeCursor();
        this.setState("connecting", this.meetingContext ? "Setting agent thinking to its lowest level…" : "Setting agent thinking to medium…");
        await this.setVoiceThinking();
        if (generation !== this.generation) return;
        const microphone = this.input ? new MediaStream(this.input.getAudioTracks().map((track) => track.clone())) : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
        });
        if (generation !== this.generation) { this.stopStream(microphone); return; }
        this.microphone = microphone;
        for (const track of microphone.getAudioTracks()) track.contentHint = "speech";
        const peer = new RTCPeerConnection();
        this.peer = peer;
        for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
        peer.addEventListener("track", (event) => {
          if (generation !== this.generation) return;
          if (event.track.kind !== "audio") return;
          const stream = new MediaStream([event.track]);
          const speaker = this.speaker || new Audio();
          speaker.muted = this.outputMuted;
          speaker.autoplay = true;
          speaker.setAttribute("playsinline", "");
          speaker.onplaying = () => this.onPlayback(speaker.muted ? "muted" : "playing");
          speaker.onerror = () => {
            this.onPlayback("blocked");
            this.onNotice(`Speaker playback failed: ${speaker.error?.message || "audio output unavailable"}`);
          };
          speaker.srcObject = stream;
          this.speaker = speaker;
          this.onOutput?.(stream);
          void this.resumePlayback();
        });
        peer.addEventListener("connectionstatechange", () => {
          if (generation !== this.generation) return;
          if (["failed", "disconnected", "closed"].includes(peer.connectionState) && this.state === "live") {
            this.setState("error", `Voice ${peer.connectionState}`);
            this.stop(false);
          }
        });
        const channel = peer.createDataChannel("oai-events");
        this.channel = channel;
        channel.addEventListener("message", (event) => { if (this.channel === channel) this.handleLiveMessage(event.data); });
        channel.addEventListener("close", () => { if (this.channel === channel) this.events.dispatchEvent(new Event("disconnected")); });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIce(peer);
        const response = await this.request(API.voiceOffer.path({}, { sessionId: this.sessionId }), {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: peer.localDescription?.sdp || offer.sdp || "",
        });
        if (!response.ok) throw new Error(await responseError(response, `Voice offer failed (${response.status})`));
        const connection = await response.json();
        const voiceId = connection.session?.id;
        if (!voiceId || !connection.transport?.sdp) throw new Error("Voice API returned no session ID or SDP answer");
        if (generation !== this.generation) { await this.closeRemote(voiceId); return; }
        this.voiceId = voiceId;
        this.usageTimer = setInterval(() => void this.reportUsage(), 30_000);
        await peer.setRemoteDescription({ type: "answer", sdp: connection.transport.sdp });
        await waitForChannel(channel);
        if (this.startupError) throw new Error(this.startupError);
        await waitForReady(this.events, {
          ready: () => this.started, readyEvent: "started", failureEvent: "disconnected",
          failureMessage: "GPT-Live disconnected during startup", timeoutMessage: "GPT-Live did not emit session.started",
        });
        if (generation !== this.generation) return;
        this.setState("live", "Listening");
        if (this.meetingContext) this.appendContext(
          `You receive audio only. Pi receives available camera images with each delegation and can use computer and browser tools. Meeting voice is ${this.outputMuted ? "muted. You can hear people, but they cannot hear you" : "unmuted. People can hear you"}. Pi can change this with meet_voice.`, "commentary");
        this.openStream();
      } catch (cause) {
        if (generation !== this.generation) return;
        const message = String(cause?.message || cause);
        this.setState("error", message);
        this.onNotice(message);
        this.stop(false);
      }
    }

    suspend() {
      this.suspended = true;
      this.generation++;
      this.stopStream(this.microphone); this.microphone = null;
      if (this.speaker) { this.speaker.muted = true; this.speaker.pause(); this.speaker.srcObject = null; }
      this.onPlayback("stopped");
    }

    stop(clearState = true) {
      this.suspend();
      if (this.closing) return this.closing;
      if (clearState) this.setState("closing", "Ending voice…");
      this.stream?.stop();
      this.stream = null;
      if (this.usageTimer) clearInterval(this.usageTimer);
      this.usageTimer = null;
      this.delegations.length = 0;
      this.resetMessage();
      const voiceId = this.voiceId;
      this.closing = (async () => {
        const closed = this.started && this.channel?.readyState === "open"
          ? waitForReady(this.events, {
            ready: () => this.closed, readyEvent: "closed", failureEvent: "disconnected", timeoutMs: 15_000,
            failureMessage: "Voice disconnected before final usage arrived", timeoutMessage: "Voice final usage did not arrive",
          }).catch((cause) => this.onNotice(String(cause.message || cause)))
          : Promise.resolve();
        if (this.started && !this.closed) this.send({ type: "session.close", event_id: crypto.randomUUID() });
        await closed;
        if (!this.closed && voiceId) await this.closeRemote(voiceId);
        await this.reportUsage(this.closed);
        this.channel?.close(); this.channel = null;
        this.peer?.close(); this.peer = null;
        this.stopStream(this.microphone); this.microphone = null;
        if (this.speaker) { this.speaker.pause(); this.speaker.srcObject = null; }
        this.speaker = null;
        this.onPlayback("stopped");
        this.voiceId = null;
        if (clearState) this.setState("idle", "Voice off");
      })().finally(() => { this.closing = null; });
      return this.closing;
    }

    async closeRemote(voiceId) {
      try {
        const response = await this.request(API.voiceSessionClose.path({ sessionId: this.sessionId, voiceId }), {
          method: "DELETE", keepalive: true, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(await responseError(response, "Could not close the billed Voice session"));
      } catch (cause) { this.onNotice(String(cause.message || cause)); }
    }

    async reportUsage(finalized = false) {
      if (!this.voiceId) return;
      try {
        const response = await this.request(API.voiceSessionUpdate.path({ sessionId: this.sessionId, voiceId: this.voiceId }), {
          method: "PATCH", headers: { "content-type": "application/json" }, keepalive: finalized,
          body: JSON.stringify({ seconds: this.usageSeconds, finalized, diagnostics: {
            eventCounts: this.eventCounts, delegationsSubmitted: this.delegationsSubmitted,
            lastDelegationError: this.lastDelegationError, lastProtocolError: this.lastProtocolError,
            connectionState: this.peer?.connectionState,
            playback: this.speaker ? { paused: this.speaker.paused, muted: this.speaker.muted,
              readyState: this.speaker.readyState, currentTime: this.speaker.currentTime,
              error: this.speaker.error?.message || null } : null,
          } }), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(await responseError(response, "Could not save Voice usage"));
      } catch (cause) { this.onNotice(String(cause.message || cause)); }
    }

    toggleMute() {
      const track = this.microphone?.getAudioTracks()[0];
      if (!track) return false;
      track.enabled = !track.enabled;
      this.send({ type: track.enabled ? "session.input_audio.unmute" : "session.input_audio.mute", event_id: crypto.randomUUID() });
      this.onState(this.state, track.enabled ? "Listening" : "Muted");
      return !track.enabled;
    }

    async resumePlayback() {
      if (this.suspended || !this.speaker) return;
      if (!this.controlledOutput) this.outputMuted = false;
      this.speaker.muted = this.outputMuted;
      this.speaker.volume = 1;
      try {
        await this.speaker.play();
        this.onPlayback(this.outputMuted ? "muted" : "playing");
      } catch (cause) {
        this.onPlayback("blocked");
        this.onNotice(`Speaker paused. Use Play Kenan audio to enable it. ${String(cause?.message || cause)}`);
      }
    }

    setOutputMuted(muted) {
      if (this.outputMuted === muted) return;
      this.outputMuted = muted;
      if (this.speaker) this.speaker.muted = muted;
      if (muted) this.onPlayback("muted");
      else void this.resumePlayback();
      if (this.started && this.meetingContext) this.appendContext(
        `Meeting voice is now ${muted ? "muted. You can hear people, but they cannot hear you" : "unmuted. People can hear you"}.`, "commentary");
    }

    hush() {
      this.setOutputMuted(true);
      this.onNotice(this.controlledOutput ? "Kenan muted" : "Speaker silenced until you speak again");
    }

    stopStream(stream) {
      for (const track of stream?.getTracks() || []) track.stop();
    }

    send(event) {
      if (this.channel?.readyState === "open") {
        this.channel.send(JSON.stringify(event));
        const key = `sent:${event.type}`;
        this.eventCounts[key] = (this.eventCounts[key] || 0) + 1;
      }
    }

    handleLiveMessage(payload) {
      let event;
      try { event = asRecord(JSON.parse(String(payload))); } catch { return; }
      if (!event) return;
      this.eventCounts[event.type] = (this.eventCounts[event.type] || 0) + 1;
      if (event.event_id) {
        if (this.seenEvents.has(event.event_id)) return;
        this.seenEvents.add(event.event_id);
      }
      if (event.type === "session.started") {
        this.started = true;
        this.events.dispatchEvent(new Event("started"));
      } else if (event.type === "session.closed") {
        this.closed = true;
        this.usageSeconds = Number(event.usage?.seconds ?? this.usageSeconds);
        this.events.dispatchEvent(new Event("closed"));
        if (!this.closing) void this.stop();
      } else if (event.type === "session.usage.updated") {
        this.usageSeconds = Number(event.usage?.seconds ?? this.usageSeconds);
      } else if (event.type === "session.delegation.created" && !this.closing) {
        const item = asRecord(event.delegation);
        if (!item?.id || item.target !== "client") return;
        const delegation = { id: item.id, requestId: crypto.randomUUID(), offsetMs: event.offset_ms, text: "", workId: null, started: false, submitted: false };
        this.delegations.push(delegation);
        this.setState("live", "Agent queued…");
        if (this.transcript.some((part) => part.role === "user")) void this.submitDelegation(delegation);
      } else if (["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type)) {
        if (typeof event.delta !== "string" || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) return;
        const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
        const fragment = { id: event.event_id, role, text: event.delta, startMs: event.start_ms, endMs: event.end_ms };
        this.transcript.push(fragment);
        this.onTranscript(role, event.delta);
        this.onFragment?.({ id: event.event_id, role, text: event.delta,
          voiceSessionId: this.voiceId, startMs: event.start_ms, endMs: event.end_ms,
          startedAt: this.sessionOrigin + event.start_ms });
        if (role === "user") {
          if (!this.controlledOutput && this.speaker?.muted) void this.resumePlayback();
          for (const delegation of this.delegations) if (!delegation.submitted) void this.submitDelegation(delegation);
        }
      } else if (event.type === "error") {
        const message = String(asRecord(event.error)?.message || "protocol error");
        this.lastProtocolError = message;
        this.onNotice(`GPT-Live: ${message}`);
        if (!this.started) { this.startupError = message; this.events.dispatchEvent(new Event("disconnected")); }
      }
    }

    submitDelegation(delegation) {
      if (delegation.submitted) return;
      delegation.submitted = true;
      const generation = this.generation;
      this.delegationQueue = this.delegationQueue.then(() => this.performDelegation(delegation, generation));
      return this.delegationQueue;
    }

    async performDelegation(delegation, generation) {
      if (generation !== this.generation) return;
      try {
        const end = this.transcript.length;
        await this.handoffContext?.();
        if (generation !== this.generation) return;
        const lines: Array<{ role: string; text: string }> = [];
        for (const fragment of this.transcript.slice(this.sentTranscriptCursor, end)) {
          const last = lines.at(-1);
          if (last && last.role === fragment.role) last.text += fragment.text;
          else lines.push({ role: fragment.role, text: fragment.text });
        }
        const conversation = lines.map((line) => `${line.role === "user" ? "User" : "Kenan"}: ${line.text.trim()}`).join("\n");
        delegation.text = ["Voice handoff", this.meetingContext?.(), conversation].filter(Boolean).join("\n\n");
        // A handoff must reach the backing thread immediately: it cancels the thread's local work rather than waiting on it.
        // The meeting root keeps long work in worker threads, which a hard steer to the root does not stop.
        const body = JSON.stringify({ requestId: delegation.requestId, text: delegation.text, delivery: "hardSteer", includeMeetingImages: Boolean(this.meetingContext) });
        const response = await this.request(API.sessionPrompt.path({ sessionId: this.sessionId }), {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        if (!response.ok) throw new Error(await responseError(response, "The agent rejected the delegation"));
        const accepted = await response.json();
        delegation.workId = typeof accepted.workId === "string" ? accepted.workId : null;
        this.sentTranscriptCursor = end;
        this.delegationsSubmitted++;
      } catch (cause) {
        this.lastDelegationError = String(cause?.message || cause);
        this.onNotice(this.lastDelegationError);
        this.appendContext(String(cause?.message || cause), "speakable", delegation.id);
        this.delegations = this.delegations.filter((candidate) => candidate !== delegation);
        this.setState("live", this.delegations.length ? "Agent queued…" : "Listening");
      }
    }

    activeDelegation() {
      return this.delegations.find((delegation) => delegation.started) || null;
    }

    appendContext(text, channel, delegationId = this.activeDelegation()?.id) {
      if (!text.trim()) return;
      for (const part of utf8Chunks(text.trim())) {
        this.send({
          type: channel === "speakable" ? "session.commentary.append" : "session.thinking.append",
          event_id: crypto.randomUUID(),
          delegation_id: delegationId ?? null,
          content: part,
        });
      }
    }

    appendProgress(text) {
      this.appendContext(text, "speakable");
    }

    async setVoiceThinking() {
      const response = await this.request(API.sessionSettings.path({ sessionId: this.sessionId }), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingLevel: this.meetingContext ? "off" : "medium" }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not set agent thinking for voice"));
    }

    async primeCursor() {
      const response = await this.request(API.sessionEvents.path({ sessionId: this.sessionId }, { after: 0 }), { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "Could not open the thread"));
      const snapshot = await response.json();
      this.cursor = Math.max(0, ...(snapshot.events || []).map((event) => Number(event.seq) || 0));
      this.threadWorking = snapshot.session?.state === "running";
      this.lastLiveText = String(snapshot.liveText || "");
      this.liveTextValue = this.lastLiveText;
    }

    // Voice reads the thread's durable events and its live answer from the same
    // push stream the app uses, with its own subscription: no transcript, no
    // dashboard, nothing the microphone does not need.
    openStream() {
      this.stream?.stop();
      this.stream = createStreamClient({
        subscription: { session: this.sessionId, viewing: false, eventsAfter: this.cursor },
        fetch: (path, init) => this.request(path, init),
        onEvent: (event) => this.handleStreamEvent(event),
        onStatus: (status) => { if (status.state === "offline" && status.error) this.onNotice(status.error); },
      });
      this.stream.start();
    }

    handleStreamEvent(event) {
      if (this.state !== "live") return;
      try {
        if (event.type === "live") {
          this.liveTextValue = event.text;
          this.observeLiveText(this.liveTextValue);
        } else if (event.type === "events") {
          this.consumeEvents(event.events || []);
          this.stream?.remember({ eventsAfter: this.cursor });
        } else if (event.type === "error") {
          this.onNotice(String(event.message || "The thread stream failed"));
        }
      } catch (cause) {
        this.onNotice(String(cause?.message || cause));
      }
    }

    consumeEvents(events) {
      for (const event of events) {
        this.cursor = Math.max(this.cursor, Number(event.seq) || 0);
        if (event.type === "user") {
          const text = String(event.text || "").trim();
          const workId = typeof event.workId === "string" ? event.workId : null;
          const matching = this.delegations.find((delegation) => !delegation.started
            && (delegation.requestId === event.requestId || (delegation.workId && delegation.workId === workId) || (!delegation.workId && delegation.text === text)));
          if (matching) matching.started = true;
          this.threadWorking = true;
          this.flushMessage("commentary");
          this.setState("live", "Agent working…");
          continue;
        }
        const active = this.activeDelegation();
        if (event.type === "assistant") this.observeAssistant(String(event.text || ""));
        else if (event.type === "tool_start") {
          this.flushMessage("commentary");
          this.appendContext(`The agent is using ${String(event.name || "a tool")}.`, "commentary");
        } else if (event.type === "tool_end" && event.name === "meet_voice" && !event.error && this.onVoiceControl) {
          const control = meetVoiceControl(JSON.parse(String(event.output || "null")));
          if (!control) throw new Error("Meeting voice control returned an invalid state");
          this.onVoiceControl(control);
        } else if (event.type === "notice" && /fail|error|could not|limit/i.test(String(event.text || ""))) {
          this.appendContext(String(event.text || ""), "commentary");
        } else if (event.type === "settled") {
          this.threadWorking = false;
          this.flushMessage("speakable");
          this.delegations = this.delegations.filter((delegation) => delegation !== active);
          this.setState("live", this.delegations.length ? "Agent queued…" : "Listening");
        }
      }
      this.observeLiveText(this.liveTextValue);
    }

    observeLiveText(text) {
      if (!this.threadWorking) { this.lastLiveText = text; return; }
      if (!text && this.lastLiveText) { this.lastLiveText = ""; return; }
      let delta;
      if (text.startsWith(this.lastLiveText)) delta = text.slice(this.lastLiveText.length);
      else { this.resetMessage(); delta = text; }
      this.lastLiveText = text;
      this.messageBuffer += delta;
      for (;;) {
        const boundary = secondSentenceBoundary(this.messageBuffer);
        if (boundary < 0) break;
        const progress = this.messageBuffer.slice(0, boundary).trim();
        this.messageBuffer = this.messageBuffer.slice(boundary);
        if (progress) { this.appendProgress(progress); this.streamedMessage = true; }
      }
    }

    observeAssistant(text) {
      if (this.pendingAssistant) this.flushMessage("commentary");
      this.pendingAssistant = text;
      if (!this.lastLiveText && !this.messageBuffer) this.messageBuffer = text;
      this.lastLiveText = "";
    }

    flushMessage(channel) {
      const text = this.messageBuffer.trim() || (!this.streamedMessage ? this.pendingAssistant.trim() : "");
      if (text) this.appendContext(text, channel);
      this.resetMessage();
    }

    resetMessage() {
      this.lastLiveText = "";
      this.messageBuffer = "";
      this.pendingAssistant = "";
      this.streamedMessage = false;
    }
  }

  window.PiRemoteVoice = { create: (options) => new VoiceSession(options) as any };
