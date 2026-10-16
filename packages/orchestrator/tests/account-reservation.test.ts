import { expect, test } from "vitest";
import { accountReservation, prioritizeReservedCompletions, reservationKey, reservationMatchesRun } from "../src/account-reservation.js";
import { allowsAccountUse } from "../src/domain.js";
import { CompletionService } from "../src/completion.js";
import { Store } from "../src/store.js";

test("retained reservations select existing metadata queues and exclude unrelated model/voice work", () => {
  const store = Store.open(":memory:");
  try {
    store.upsertAccount({ id: "codex", provider: "openai-codex" });
    const reservation = { reason: "retained queue", metadata: { campaign: "one" } };
    store.setControl(reservationKey("codex"), JSON.stringify(reservation));
    const service = new CompletionService(store, "/tmp");
    const input = { model: "luna", thinkingLevel: "low", speed: "standard", prompt: "exact" } as const;
    const unrelated = service.submit("unrelated", input), matching = service.submit("matching", { ...input, metadata: { campaign: "one" } });
    if (!unrelated.ok || !matching.ok) throw Error("Fixture submissions failed");
    expect(accountReservation(store, "codex")).toEqual(reservation);
    expect(reservationMatchesRun(store, reservation, matching.value.runId)).toBe(true);
    expect(reservationMatchesRun(store, reservation, unrelated.value.runId)).toBe(false);
    expect(prioritizeReservedCompletions(store, store.admissionQueue()).map(run => run.id)).toEqual([matching.value.runId, unrelated.value.runId]);
    expect(allowsAccountUse(store.account("codex")!, "fleet")).toBe(true);
    expect(allowsAccountUse(store.account("codex")!, "voice")).toBe(false);
    store.setControl(reservationKey("codex"), "");
    expect(accountReservation(store, "codex")).toBeUndefined();
  } finally { store.close(); }
});
