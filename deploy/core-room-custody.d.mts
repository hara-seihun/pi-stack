export function projectRoomCustody<T>(input: T, evidence: { authoritySha256: string; now: number }):
  { ok: true; value: T } | { ok: false; error: { code: 'room-custody-mismatch'; message: string } };
