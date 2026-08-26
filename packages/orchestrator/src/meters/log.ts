/**
 * Console reporting for meter samples.
 *
 * A sampler reports a gap on every poll for as long as the gap lasts, and
 * the daemon polls on its tick, so a single unreadable account used to write
 * one error line every 30 seconds for as long as it stayed unreadable — 2880
 * lines a day saying the same thing, which is how `anthropic-2:
 * expired-credential` filled the journal for hours on 2026-08-22 while the
 * account sat in its cooldown with nothing able to refresh it.
 *
 * A gap is a state, not an event: it is worth one line when it opens, one
 * when it closes, and nothing in between. Gaps are tracked per account
 * rather than per meter, because a sampler that cannot reach an account does
 * not know which of its meters it failed to read — the reading that proves
 * the account is readable again always arrives under a different meter id
 * than the gap did.
 */

export interface MeterSampleLine {
  readonly accountId: string;
  readonly meterId?: string;
  readonly outcome: string;
  readonly usedPercent?: number;
  readonly detail?: string;
}

export interface MeterLogSinks {
  readonly info: (line: string) => void;
  readonly error: (line: string) => void;
}

const IGNORED = new Set(["not-due"]);

export class MeterLog {
  readonly #open = new Map<string, string>();
  readonly #sinks: MeterLogSinks;
  readonly #quiet: ReadonlySet<string>;

  /**
   * @param quiet outcomes that are an ordinary resting state rather than a
   *   gap worth announcing — `no-credential` on an account held in another
   *   custody domain, for one.
   */
  constructor(sinks: MeterLogSinks = { info: console.log, error: console.error }, quiet: Iterable<string> = []) {
    this.#sinks = sinks;
    this.#quiet = new Set(quiet);
  }

  report(sample: MeterSampleLine): void {
    if (IGNORED.has(sample.outcome)) return;
    const meter = `${sample.accountId}/${sample.meterId ?? "?"}`;
    if (sample.outcome === "recorded") {
      const previous = this.#open.get(sample.accountId);
      this.#open.delete(sample.accountId);
      if (previous !== undefined) this.#sinks.info(`meter ${meter}: readable again (was ${previous})`);
      this.#sinks.info(`meter ${meter}: ${sample.usedPercent}% used`);
      return;
    }
    if (this.#quiet.has(sample.outcome)) return;
    if (this.#open.get(sample.accountId) === sample.outcome) return;
    this.#open.set(sample.accountId, sample.outcome);
    this.#sinks.error(`meter ${meter}: ${sample.outcome}${sample.detail ? ` (${sample.detail})` : ""}`);
  }
}
