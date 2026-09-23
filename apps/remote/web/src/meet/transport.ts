export type MeetRequest = (path: string, init: RequestInit) => Promise<Response>;

export async function meetJson<T>(request: MeetRequest, path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    throw new Error(message || `Meet HTTP ${response.status}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
