export const ROOM_TOOLS = ["ask_kenan", "request_user_input_async"];

export function isRoomSession(env: NodeJS.ProcessEnv, threadId: string): boolean {
  if (env.PI_REMOTE_ROOMS_RUNTIME !== "1") return false;
  if (env.PI_REMOTE_SENDER_ID !== "pi-rooms" || env.PI_REMOTE_ROOM_ID !== threadId) throw new Error("Room runtime requires its fixed custodian and server-bound room ID");
  return true;
}

export function assertRoomTools(names: string[]): void {
  if (names.length !== ROOM_TOOLS.length || ROOM_TOOLS.some(name => !names.includes(name))) throw new Error(`Room tools must be exactly ${ROOM_TOOLS.join(", ")}; got ${names.join(", ")}`);
}

export function roomSessionInstructions(env: NodeJS.ProcessEnv) {
  return { name: "room-instructions", factory: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
    pi.on("before_agent_start", async () => {
      const origin = env.PI_REMOTE_SERVER_URL;
      const id = env.PI_REMOTE_ROOM_ID;
      if (!origin || !id) throw new Error("Room context owner is unavailable");
      const response = await fetch(new URL(`/v1/sessions/${encodeURIComponent(id)}/instructions`, origin), { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Room audience unavailable: HTTP ${response.status}`);
      const body = await response.json() as { instructions: string };
      return { systemPrompt: `You are Kenan, participating in a shared room. This is an unprivileged, fully transparent conversation: everyone present sees your thinking and every tool call/result. Your only tools are ask_kenan and request_user_input_async. Ask root Kenan for file operations, actions, memory or anything learned outside this room; only his chosen reply comes back here. You cannot grant yourself another person's identity or authority. The room custodian is not the individual speaker.\n\n${body.instructions}` };
    });
  } };
}
