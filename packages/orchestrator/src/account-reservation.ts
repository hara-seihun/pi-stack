import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Store } from "./store.js";
import type { Run } from "./domain.js";
export const AccountReservationSchema = Type.Object({ metadata: Type.Record(Type.String(), Type.String(), { minProperties: 1 }), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type AccountReservation = Static<typeof AccountReservationSchema>;
export const isAccountReservation = (value: unknown): value is AccountReservation => Check(AccountReservationSchema, value);
export const reservationKey = (id: string) => `account-reservation:${id}`;
export function accountReservation(store: Store, id: string): AccountReservation | undefined {
  const encoded = store.control(reservationKey(id)); if (!encoded) return;
  const value: unknown = JSON.parse(encoded);
  if (!isAccountReservation(value)) throw new Error(`Invalid retained account reservation ${id}`);
  return value;
}
export function reservationMatchesRun(store: Store, reservation: AccountReservation, runId?: string): boolean {
  if (!runId) return false;
  const requestId = store.control(`completion-run:${runId}`), encoded = requestId && store.control(`completion:${requestId}`);
  if (!encoded) return false;
  const metadata = JSON.parse(encoded).input.metadata;
  return !!metadata && Object.entries(reservation.metadata).every(([key, value]) => metadata[key] === value);
}
export function prioritizeReservedCompletions(store: Store, runs: Run[]): Run[] {
  const reservations = (store.db.prepare("SELECT value FROM control WHERE key LIKE 'account-reservation:%' AND value<>''").all() as { value: string }[]).map(row => {
    const value: unknown = JSON.parse(row.value);
    if (!isAccountReservation(value)) throw Error("Invalid retained account reservation");
    return value;
  });
  const priority = new Set(runs.filter(run => reservations.some(reservation => reservationMatchesRun(store, reservation, run.id))).map(run => run.id));
  return runs.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)));
}
