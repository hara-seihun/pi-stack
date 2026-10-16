import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { API, type Route } from "../api";
import type { MeetSnapshot } from "./protocol";
import { sessionEnvironment } from "../session-environment";

export function registerMeetTools(pi: ExtensionAPI) {
  const environment = sessionEnvironment();
  const sessionId = environment.PI_REMOTE_SESSION_ID!;
  const server = environment.PI_REMOTE_SERVER_URL!;

  async function request(route: Route, signal?: AbortSignal, body?: unknown) {
    const url = new URL(route.path({ sessionId }), server);
    const response = await fetch(url, {
      method: route.method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000),
    });
    if (!response.ok) throw new Error((await response.json() as { error: string }).error);
    return response;
  }

  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

  pi.registerTool({
    name: "meet_room",
    label: "Meeting room",
    description: "List people in your meeting and your shared browser's connection.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const room = await (await request(API.sessionMeeting, signal)).json() as MeetSnapshot;
      return result({ participants: room.participants.map(({ name, id }) => ({ name, id })), muted: room.voiceMuted,
        browser: room.browser, threads: room.threads.map(({ id, name, state, tools }) => ({ id, name, state, tools })) });
    },
  });

  pi.registerTool({
    name: "meet_voice",
    label: "Mute or unmute Kenan",
    description: "Mute or unmute your own meeting voice. You keep listening and working while muted. Use when asked to mute or unmute yourself.",
    parameters: Type.Object({ muted: Type.Boolean({ description: "true to stay silent, false to speak in the meeting" }) }),
    async execute(_id, params, signal) {
      return result(await (await request(API.sessionMeetingVoice, signal, params)).json());
    },
  });

  pi.registerTool({
    name: "meet_share_screen",
    label: "Share meeting screen",
    description: "Share your meeting browser with everyone, optionally opening a URL. Control it with agent_browser using the returned connect arguments.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "HTTP or HTTPS page to show." })),
      watch: Type.Optional(Type.Union([Type.String({ description: "Absolute local source directory for automatic page reloads. Apps with hot reload need no watcher." }), Type.Null()])),
    }),
    async execute(_id, params, signal) {
      const browser = await (await request(API.sessionMeetingShare, signal, params)).json() as NonNullable<MeetSnapshot["browser"]>;
      return result({ ...browser, sharing: true, control: { tool: "agent_browser", args: ["connect", browser.endpoint] } });
    },
  });

  pi.registerTool({
    name: "meet_stop_sharing",
    label: "Stop sharing meeting screen",
    description: "Stop sharing your screen and close your meeting browser.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return result(await (await request(API.sessionMeetingStop, signal)).json());
    },
  });

}
