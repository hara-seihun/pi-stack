import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  DEFAULT_LIVE_MODEL,
  DEFAULT_LIVE_VOICE,
  type VoiceBroker,
} from "./broker.js";

/**
 * GPT-Live as a local HTTP API. One POST turns a WebRTC SDP offer into an
 * answer on an eligible pooled account; raw OAuth tokens never leave the
 * custody process. Bind it to loopback: within the machine boundary the
 * caller (for example a containerized runtime on the host network) simply
 * POSTs and speaks.
 *
 *   GET  /v1/voice        -> { enabled, accountCount, model, voice }
 *   POST /v1/voice/offer  -> { sdp, instructions, voice?, model? }
 *                            200 { sdp, account } | 4xx/5xx { error }
 */

const MAX_BODY_BYTES = 256 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

export function createVoiceServer(broker: VoiceBroker): Server {
  return createServer(async (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/v1/voice" && request.method === "GET") {
      json(response, 200, { ...broker.status(), model: DEFAULT_LIVE_MODEL, voice: DEFAULT_LIVE_VOICE });
      return;
    }
    if (path === "/v1/voice/offer" && request.method === "POST") {
      const body = await readBody(request);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body ?? "");
      } catch {
        json(response, 400, { error: "A JSON body with sdp and instructions is required" });
        return;
      }
      const sdp = typeof parsed.sdp === "string" ? parsed.sdp : "";
      const instructions = typeof parsed.instructions === "string" ? parsed.instructions : "";
      if (!sdp || !instructions) {
        json(response, 400, { error: "A JSON body with sdp and instructions is required" });
        return;
      }
      const result = await broker.negotiate(sdp, instructions, {
        ...(typeof parsed.model === "string" && parsed.model ? { model: parsed.model } : {}),
        ...(typeof parsed.voice === "string" && parsed.voice ? { voice: parsed.voice } : {}),
      });
      if (result.ok) json(response, 200, { sdp: result.sdp, account: result.account });
      else json(response, result.status, { error: result.error });
      return;
    }
    json(response, 404, { error: "Unknown voice endpoint" });
  });
}
