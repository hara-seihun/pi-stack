export function appBase(href = location.href): string {
  return new URL(".", href).pathname.replace(/\/$/, "");
}

export function appPath(path: string, href = location.href): string {
  return `${appBase(href)}/${path.replace(/^\/+/, "")}`;
}

export function appStorageKey(key: string, href = location.href): string {
  const base = appBase(href);
  return base ? `${base}:${key}` : key;
}

export function appStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, href = location.href) {
  return {
    getItem: (key: string) => storage.getItem(appStorageKey(key, href)),
    setItem: (key: string, value: string) => storage.setItem(appStorageKey(key, href), value),
    removeItem: (key: string) => storage.removeItem(appStorageKey(key, href)),
  };
}
