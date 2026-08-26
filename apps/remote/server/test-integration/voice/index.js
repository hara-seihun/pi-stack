export const DEFAULT_LIVE_MODEL = "gpt-live-1-codex";
export const DEFAULT_LIVE_VOICE = "cove";

export class VoiceBroker {
  constructor(options) { this.options = options; }
  status() { return { enabled: true, accountCount: this.options.accounts().length }; }
  async negotiate() { throw new Error("Voice negotiation is not exercised by this integration fixture"); }
}
