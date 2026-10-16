export type SpeechPreference = "rate" | `voice:${string}`;
export type SpeechPreferenceResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type SpeechPreferenceStore = { storage(): Storage; key(value: string): string };
export const speechPreferenceKey = (user: string, preference: SpeechPreference) => `pi-remote-speech:${encodeURIComponent(user)}:${preference}`;

export function readSpeechPreference(store: SpeechPreferenceStore, user: string, preference: SpeechPreference): SpeechPreferenceResult<string | null> {
  if (!user) return { ok: false, error: "Sign in to load speech preferences." };
  try {
    const storage = store.storage();
    const key = store.key(speechPreferenceKey(user, preference));
    const own = storage.getItem(key);
    const migrationKey = store.key("pi-remote-speech-migration-owner");
    let migrationOwner = storage.getItem(migrationKey);
    if (migrationOwner === null) { storage.setItem(migrationKey, user); migrationOwner = user; }
    if (migrationOwner !== user) return { ok: true, value: own };
    const previousKey = store.key(preference === "rate" ? "pi-remote-speech-rate" : `pi-remote-speech-voice:${preference.slice(6)}`);
    const previous = storage.getItem(previousKey);
    if (previous === null) return { ok: true, value: own };
    if (own === null) storage.setItem(key, previous);
    storage.removeItem(previousKey);
    return { ok: true, value: own === null ? previous : own };
  } catch (failure) {
    return { ok: false, error: `Speech preferences could not be loaded: ${failure instanceof Error ? failure.message : String(failure)}` };
  }
}

export function writeSpeechPreference(store: SpeechPreferenceStore, user: string, preference: SpeechPreference, value: string): SpeechPreferenceResult<void> {
  if (!user) return { ok: false, error: "Sign in to save speech preferences." };
  try {
    store.storage().setItem(store.key(speechPreferenceKey(user, preference)), value);
    return { ok: true, value: undefined };
  } catch (failure) {
    return { ok: false, error: `Speech preference was not saved: ${failure instanceof Error ? failure.message : String(failure)}` };
  }
}
