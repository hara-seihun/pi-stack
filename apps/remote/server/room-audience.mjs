import { DatabaseSync } from "node:sqlite";

/** Read-only trusted-directory attestation. A room token never downgrades to a person's audience. */
export function roomAudienceResolver(path, custodian = "pi-rooms") {
  return (person, threadId) => {
    if (person !== custodian) return undefined;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT owner,members,ready FROM rooms WHERE id=?").get(threadId);
      if (!row || !row.ready || row.owner !== custodian) throw new Error("Room caller has no current room directory attestation");
      const members = JSON.parse(row.members);
      if (!Array.isArray(members) || !members.length || members.some(member => typeof member?.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(member.user))) throw new Error("Invalid trusted room roster");
      return { roomId: threadId, people: [...new Set(members.map(member => member.user))] };
    } finally { db.close(); }
  };
}
