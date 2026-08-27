export interface AgentMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
}

export const INITIAL_TITLE = /^\d+$/;
const INTERRUPTED_CONTINUATION = /previous agent operation was interrupted|continue its unfinished work|<interrupted_user_request>/i;

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => Boolean(part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"))
    .map((part) => part.text)
    .join("\n");
}

export function surfacedInAssistantReply(messages: AgentMessage[], expected: string): boolean {
  return messages
    .filter((message) => message.role === "assistant")
    .some((message) => contentText(message.content).includes(expected));
}

export function threadStateInstructions(options: {
  name?: string;
  prompt: string;
  fileTag: string;
  home: string;
}): string {
  const file = `Pi Remote file delivery: To give the user a file, include <${options.fileTag} src="${options.home}/path/to/file" /> on its own line. Use an absolute path to an existing file. The client turns the tag into a download link.`;
  if (options.name && INITIAL_TITLE.test(options.name)) {
    return [
      `Pi Remote thread state: This is a new, uninitialized thread with numeric title ${options.name}.`,
      "As your first action, call initialize_thread once with a concise descriptive title of two or three words based on the user's first message. Do not ask permission or narrate initialization. Continue with the user's task immediately afterward. Surface every machine alert returned by initialize_thread prominently and verbatim.",
      file,
    ].join("\n\n");
  }

  const name = options.name ? JSON.stringify(options.name) : "an existing named thread";
  const continuation = INTERRUPTED_CONTINUATION.test(options.prompt)
    ? " This prompt resumes an interrupted operation in the same task. Continue from the recorded state without repeating setup or completed actions."
    : "";
  return [
    `Pi Remote thread state: You are continuing ${name}. The Pi session and conversation context survive process restarts, account routing, and model changes. Do not call initialize_thread.${continuation}`,
    file,
  ].join("\n\n");
}
