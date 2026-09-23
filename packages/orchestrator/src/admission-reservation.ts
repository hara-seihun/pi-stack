import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Store } from "./store.js";
import type { Run } from "./domain.js";

export const AccountReservationSchema = Type.Object({
  metadata: Type.Record(Type.String(), Type.String(), { minProperties: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type AccountReservation = Static<typeof AccountReservationSchema>;
export const isAccountReservation = (value: unknown): value is AccountReservation => Check(AccountReservationSchema, value);
export const reservationKey = (accountId: string) => `account-reservation:${accountId}`;

export function accountReservation(store: Store, accountId: string): AccountReservation | undefined {
  const value = store.control(reservationKey(accountId));
  return value ? JSON.parse(value) : undefined;
}

export function reservationMatchesRun(store: Store, reservation: AccountReservation, runId?: string): boolean {
  if (!runId) return false;
  const requestId = store.control(`completion-run:${runId}`);
  const value = requestId && store.control(`completion:${requestId}`);
  if (!value) return false;
  const metadata = JSON.parse(value).input.metadata;
  return !!metadata && Object.entries(reservation.metadata).every(([key, expected]) => metadata[key] === expected);
}

export function prioritizeReservedCompletions(store: Store, runs: Run[]): Run[] {
  const reservations = (store.db.prepare("SELECT value FROM control WHERE key LIKE 'account-reservation:%' AND value<>''").all() as {value: string}[])
    .map(row => JSON.parse(row.value) as AccountReservation);
  const priority = new Set(runs.filter(run => reservations.some(reservation => reservationMatchesRun(store, reservation, run.id))).map(run => run.id));
  return runs.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)));
}
