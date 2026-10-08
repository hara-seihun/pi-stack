import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHistory } from "./session-history";
import { sessionEnvironment } from "./session-environment";
import { AGENT_NAME } from "./agent-identity";
import { identifyMessages, modelVisibleMessages } from "./message-context";

export default function conversation(pi: ExtensionAPI) {
  registerSessionHistory(pi);
  const environment = sessionEnvironment();
  const sessionId = environment.PI_REMOTE_SESSION_ID;
  if (!sessionId) return;
  pi.on("context", (event, ctx) => {
    if (ctx.mode !== "rpc" || environment.PI_SESSION_FILE && ctx.sessionManager.getSessionFile() !== environment.PI_SESSION_FILE) return;
    return { messages: modelVisibleMessages(identifyMessages(convertToLlm(event.messages), ctx, sessionId, {
      id: environment.PI_REMOTE_SENDER_ID || "user",
      ...(environment.PI_REMOTE_SENDER_NAME ? { name: environment.PI_REMOTE_SENDER_NAME } : {}),
    }, AGENT_NAME, environment.PI_REMOTE_ROOM_ID === sessionId)) };
  });
}
