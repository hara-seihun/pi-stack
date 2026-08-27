"use strict";

(() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  async function sha256(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function base64Bytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function verifiedDocument(document, expectedHash, capturedAt) {
    const bytes = encoder.encode(document);
    if (await sha256(bytes) !== expectedHash) throw new Error("Synchronized document hash does not match");
    return { document, hash: expectedHash, capturedAt };
  }

  async function update(current, change) {
    if (!change) return current;
    if (change.kind === "clear") return null;
    const targetHash = String(change.hash || "");
    const capturedAt = Number(change.capturedAt || 0);
    if (change.kind === "full") return verifiedDocument(String(change.document ?? ""), targetHash, capturedAt);
    if (change.kind !== "splice" || !current) throw new Error("Synchronized document needs a full replacement");

    const splice = change.splice;
    if (!splice || current.hash !== splice.baseHash || targetHash !== splice.targetHash)
      throw new Error("Synchronized document splice does not match its base");
    const source = encoder.encode(current.document);
    const prefix = Number(splice.prefixBytes);
    const deleted = Number(splice.deleteBytes);
    if (!Number.isSafeInteger(prefix) || !Number.isSafeInteger(deleted)
      || prefix < 0 || deleted < 0 || prefix + deleted > source.length)
      throw new Error("Synchronized document splice range is invalid");
    const inserted = base64Bytes(String(splice.insertBase64 || ""));
    const result = new Uint8Array(source.length - deleted + inserted.length);
    result.set(source.subarray(0, prefix));
    result.set(inserted, prefix);
    result.set(source.subarray(prefix + deleted), prefix + inserted.length);
    return verifiedDocument(decoder.decode(result), targetHash, capturedAt);
  }

  globalThis.PiRemoteSync = Object.freeze({ update });
})();
