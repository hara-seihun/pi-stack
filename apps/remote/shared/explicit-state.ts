export function assertNever(value: never, owner: string): never {
  throw new Error(`${owner}: undescribed state ${JSON.stringify(value)}`);
}

export function requireState<T extends string>(value: unknown, states: Readonly<Record<T, unknown>>, owner: string): T {
  if (typeof value !== "string" || !Object.hasOwn(states, value)) {
    throw new Error(`${owner}: invalid state ${JSON.stringify(value)}`);
  }
  return value as T;
}
