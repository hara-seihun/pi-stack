import { openSqlite } from "../sqlite.js";

export function roomAudienceResolver(path: string, custodian: string) {
  return (person: string, threadId: string) => {
    if (person !== custodian) return undefined;
    const db = openSqlite(path, true);
    try {
      const row = db.prepare("SELECT owner,members,ready FROM rooms WHERE id=?").get(threadId) as { owner: string; members: string; ready: number } | undefined;
      if (!row || !row.ready || row.owner !== custodian) throw new Error("Room caller has no current room directory attestation");
      const members = JSON.parse(row.members) as { user: string }[];
      if (!Array.isArray(members) || !members.length || members.some(member => typeof member?.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(member.user))) throw new Error("Invalid trusted room roster");
      return { roomId: threadId, people: [...new Set(members.map(member => member.user))] };
    } finally { db.close(); }
  };
}
