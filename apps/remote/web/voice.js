"use strict";

(() => {
  const MAX_CONTEXT_BYTES = 500;
  const POLL_MS = 1_000;

  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function applyTextUpdate(current, update) {
    if (!update) return current;
    if (update.kind === "clear") return null;
    if (update.kind === "full") {
      if (await sha256(update.document) !== update.hash) throw new Error("Live transcript hash verification failed");
      return { value: update.document, hash: update.hash };
    }
    if (update.kind !== "splice" || !current || current.hash !== update.splice?.baseHash)
      throw new Error("Live transcript resynchronization required");
    const source = new TextEncoder().encode(current.value);
    const prefix = Number(update.splice.prefixBytes);
    const deleted = Number(update.splice.deleteBytes);
    const inserted = Uint8Array.from(atob(update.splice.insertBase64), (character) => character.charCodeAt(0));
    if (!Number.isSafeInteger(prefix) || !Number.isSafeInteger(deleted) || prefix < 0 || deleted < 0 || prefix + deleted > source.length)
      throw new Error("Live transcript splice is invalid");
    const result = new Uint8Array(source.length - deleted + inserted.length);
    result.set(source.subarray(0, prefix));
    result.set(inserted, prefix);
    result.set(source.subarray(prefix + deleted), prefix + inserted.length);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(result);
    if (await sha256(value) !== update.hash) throw new Error("Live transcript splice hash verification failed");
    return { value, hash: update.hash };
  }

  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function utf8Chunks(value, maxBytes = MAX_CONTEXT_BYTES) {
    const encoder = new TextEncoder();
    const chunks = [];
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
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timeout);
        target.removeEventListener(options.readyEvent, ready);
        if (options.failureEvent) target.removeEventListener(options.failureEvent, failed);
        error ? reject(error) : resolve();
      };
      const ready = () => { if (options.ready()) finish(); };
      const failed = () => finish(new Error(options.failureMessage));
      const timeout = setTimeout(() => finish(new Error(options.timeoutMessage)), 15_000);
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

  class VoiceSession {
    constructor(options) {
      this.sessionId = options.sessionId;
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
      this.syncSequence = 0;
      this.liveTextDocument = null;
      this.liveThinkingDocument = null;
      this.pollTimer = null;
      this.polling = false;
      this.delegations = [];
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
      const generation = ++this.generation;
      this.setState("connecting", "Connecting…");
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable");
        const configResponse = await piFetch("/v1/voice", { cache: "no-store" });
        const config = await configResponse.json();
        if (!configResponse.ok || !config.enabled) throw new Error(config.error || "No GPT-Live accounts are available");
        await this.primeCursor();
        this.setState("connecting", "Setting agent thinking to medium…");
        await this.setMediumThinking();
        const microphone = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
        });
        if (generation !== this.generation) { this.stopStream(microphone); return; }
        this.microphone = microphone;
        for (const track of microphone.getAudioTracks()) track.contentHint = "speech";
        const peer = new RTCPeerConnection();
        this.peer = peer;
        for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
        peer.addEventListener("track", (event) => {
          const speaker = this.speaker || new Audio();
          speaker.autoplay = true;
          speaker.setAttribute("playsinline", "");
          speaker.srcObject = event.streams[0] || new MediaStream([event.track]);
          this.speaker = speaker;
          void speaker.play().catch(() => this.onNotice("Tap the screen once if speaker audio is paused"));
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
        channel.addEventListener("message", (event) => this.handleRealtimeMessage(event.data));
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIce(peer);
        const response = await piFetch(`/v1/voice/offer?sessionId=${encodeURIComponent(this.sessionId)}`, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: peer.localDescription?.sdp || offer.sdp || "",
        });
        if (!response.ok) throw new Error(await responseError(response, `Voice offer failed (${response.status})`));
        const answer = await response.text();
        if (generation !== this.generation) return;
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        await waitForChannel(channel);
        if (generation !== this.generation) return;
        this.setState("live", "Listening");
        this.schedulePoll(0);
      } catch (cause) {
        if (generation !== this.generation) return;
        const message = String(cause?.message || cause);
        this.setState("error", message);
        this.onNotice(message);
        this.stop(false);
      }
    }

    stop(clearState = true) {
      this.generation++;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.polling = false;
      this.delegations.length = 0;
      this.resetMessage();
      if (this.channel) { this.channel.onmessage = null; this.channel.close(); }
      this.channel = null;
      if (this.peer) { this.peer.ontrack = null; this.peer.close(); }
      this.peer = null;
      this.stopStream(this.microphone);
      this.microphone = null;
      if (this.speaker) { this.speaker.pause(); this.speaker.srcObject = null; }
      this.speaker = null;
      if (clearState) this.setState("idle", "Voice off");
    }

    toggleMute() {
      const track = this.microphone?.getAudioTracks()[0];
      if (!track) return false;
      track.enabled = !track.enabled;
      this.onState(this.state, track.enabled ? "Listening" : "Muted");
      return !track.enabled;
    }

    hush() {
      this.send({ type: "response.cancel" });
      this.send({ type: "output_audio_buffer.clear" });
    }

    stopStream(stream) {
      for (const track of stream?.getTracks() || []) track.stop();
    }

    send(event) {
      if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
    }

    handleRealtimeMessage(payload) {
      let event;
      try { event = asRecord(JSON.parse(String(payload))); }
      catch { return; }
      if (!event) return;
      if (event.type === "delegation.created") {
        const item = asRecord(event.item);
        const text = (Array.isArray(item?.content) ? item.content : [])
          .map(asRecord).filter((part) => part?.type === "input_text" && typeof part.text === "string")
          .map((part) => part.text).join("").trim();
        if (!item?.id || !text) return;
        const delegation = { id: item.id, text, workId: null, started: false };
        this.delegations.push(delegation);
        this.setState("live", "Agent queued…");
        void this.submitDelegation(delegation);
        return;
      }
      if (event.type === "turn.done") {
        const turn = asRecord(event.turn);
        if ((turn?.role === "user" || turn?.role === "assistant") && typeof turn.transcript === "string" && turn.transcript.trim()) {
          this.onTranscript(turn.role, turn.transcript.trim());
        }
        return;
      }
      if (event.type === "error") this.onNotice(`GPT-Live: ${asRecord(event.error)?.message || "protocol error"}`);
    }

    async submitDelegation(delegation) {
      const body = JSON.stringify({ requestId: crypto.randomUUID(), text: delegation.text, delivery: "followUp" });
      try {
        let response = await piFetch(`/v1/sessions/${encodeURIComponent(this.sessionId)}/prompt`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        if (!response.ok && response.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          response = await piFetch(`/v1/sessions/${encodeURIComponent(this.sessionId)}/prompt`, {
            method: "POST", headers: { "content-type": "application/json" }, body,
          });
        }
        if (!response.ok) throw new Error(await responseError(response, "The agent rejected the delegation"));
        const accepted = await response.json();
        delegation.workId = typeof accepted.workId === "string" ? accepted.workId : null;
      } catch (cause) {
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
        this.send(delegationId ? {
          type: "delegation.context.append",
          delegation_item_id: delegationId,
          channel,
          content: [{ type: "input_text", text: part }],
        } : {
          type: "session.context.append",
          channel,
          content: [{ type: "input_text", text: part }],
        });
      }
    }

    appendProgress(text) {
      for (const part of utf8Chunks(text.trim())) {
        this.send({
          type: "session.context.append",
          channel: "speakable",
          content: [{ type: "input_text", text: part }],
        });
      }
    }

    async setMediumThinking() {
      const response = await piFetch(`/v1/sessions/${encodeURIComponent(this.sessionId)}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingLevel: "medium" }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not set medium thinking for voice"));
    }

    async primeCursor() {
      const response = await piFetch(`/v1/sessions/${encodeURIComponent(this.sessionId)}/events?after=0`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "Could not open the thread"));
      const snapshot = await response.json();
      this.cursor = Math.max(0, ...(snapshot.events || []).map((event) => Number(event.seq) || 0));
    }

    schedulePoll(delay = POLL_MS) {
      if (this.state !== "live" || this.pollTimer) return;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        void this.poll();
      }, delay);
    }

    async poll() {
      if (this.polling || this.state !== "live") return;
      this.polling = true;
      let failed = false;
      try {
        const response = await piFetch("/v1/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            after: this.syncSequence,
            waitMs: 25_000,
            includeDashboard: false,
            eventSessionId: this.sessionId,
            eventAfter: this.cursor,
            eventLiveTextHash: this.liveTextDocument?.hash || "",
            eventLiveThinkingHash: this.liveThinkingDocument?.hash || "",
          }),
        });
        if (!response.ok) throw new Error(await responseError(response, "Voice lost the thread"));
        const synchronized = await response.json();
        this.syncSequence = Number(synchronized.seq || this.syncSequence);
        const snapshot = synchronized.sessionEvents || { events: [] };
        this.liveTextDocument = await applyTextUpdate(this.liveTextDocument, snapshot.liveTextUpdate);
        this.liveThinkingDocument = await applyTextUpdate(this.liveThinkingDocument, snapshot.liveThinkingUpdate);
        for (const event of snapshot.events || []) {
          this.cursor = Math.max(this.cursor, Number(event.seq) || 0);
          if (event.type === "user") {
            const text = String(event.text || "").trim();
            const workId = typeof event.workId === "string" ? event.workId : null;
            const matching = this.delegations.find((delegation) => !delegation.started
              && ((delegation.workId && delegation.workId === workId) || (!delegation.workId && delegation.text === text)));
            if (matching) {
              matching.started = true;
              this.resetMessage();
              this.setState("live", "Agent working…");
            }
            continue;
          }
          const active = this.activeDelegation();
          if (!active) continue;
          if (event.type === "assistant") this.observeAssistant(String(event.text || ""));
          else if (event.type === "tool_start") {
            this.flushMessage("commentary");
            this.appendContext(`The agent is using ${String(event.name || "a tool")}.`, "commentary");
          } else if (event.type === "notice" && /fail|error|could not|limit/i.test(String(event.text || ""))) {
            this.appendContext(String(event.text || ""), "commentary");
          } else if (event.type === "settled") {
            this.flushMessage("speakable");
            this.delegations = this.delegations.filter((delegation) => delegation !== active);
            this.setState("live", this.delegations.length ? "Agent queued…" : "Listening");
          }
        }
        this.observeLiveText(this.liveTextDocument?.value || "");
      } catch (cause) {
        failed = true;
        this.onNotice(String(cause?.message || cause));
      } finally {
        this.polling = false;
        this.schedulePoll(failed ? POLL_MS : 0);
      }
    }

    observeLiveText(text) {
      if (!this.activeDelegation()) { this.lastLiveText = text; return; }
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

  window.PiRemoteVoice = { create: (options) => new VoiceSession(options) };
})();
