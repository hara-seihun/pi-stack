export function parseStateVersion(value) {
  const encoded = String(value || "");
  const separator = encoded.lastIndexOf("/");
  if (separator < 1) return null;
  const epoch = encoded.slice(0, separator);
  const version = Number(encoded.slice(separator + 1));
  return epoch && Number.isSafeInteger(version) && version >= 0 ? { epoch, version } : null;
}

export function createStateReconciler(storage, onPending, key = "pi-remote-reconciliation-target") {
  let target = null;
  try { target = parseStateVersion(storage.getItem(key)); } catch {}

  const persist = () => {
    try {
      if (target) storage.setItem(key, `${target.epoch}/${target.version}`);
      else storage.removeItem(key);
    } catch {}
  };
  const clear = () => {
    target = null;
    persist();
  };

  return {
    get target() { return target; },
    require(encoded, currentEpoch, currentVersion) {
      const next = parseStateVersion(encoded);
      if (!next) return false;
      if (!target || target.epoch !== next.epoch || next.version > target.version) {
        target = next;
        persist();
      }
      if (currentEpoch === target.epoch && currentVersion >= target.version) clear();
      else onPending();
      return true;
    },
    accepts(epoch, version) {
      return !target || target.epoch !== epoch || version >= target.version;
    },
    settle(epoch, version, authoritative) {
      if (!authoritative || !target) return false;
      if (epoch !== target.epoch || version >= target.version) {
        clear();
        return true;
      }
      return false;
    },
  };
}
