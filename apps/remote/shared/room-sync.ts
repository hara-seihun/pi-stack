export interface RoomRevisions {
  cursor: string;
  directory: string;
  rooms: Record<string, string>;
}

export function readRoomRevisions(value: unknown): RoomRevisions {
  if (!value || typeof value !== "object") throw new Error("Invalid room revisions");
  const frame = value as RoomRevisions;
  if (typeof frame.cursor !== "string" || typeof frame.directory !== "string" || !frame.rooms || typeof frame.rooms !== "object"
    || Array.isArray(frame.rooms) || Object.entries(frame.rooms).some(([id, revision]) => !/^[0-9a-f-]{36}$/i.test(id) || typeof revision !== "string")) {
    throw new Error("Invalid room revisions");
  }
  return frame;
}

// Room feeds contain single-line JSON data frames and heartbeat comments only.
export async function consumeRoomFeed(body: ReadableStream<Uint8Array>, receive: (value: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = reader.read();
      const timedOut = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Room feed timed out")), 60_000); });
      const { done, value } = await Promise.race([next, timedOut]).finally(() => clearTimeout(timer));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error("Room revision frame exceeds limit");
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.startsWith("data: ")) receive(JSON.parse(line.slice(6)));
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
