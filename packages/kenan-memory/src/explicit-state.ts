import type { MemoryRole } from "./contract.js";

export function stateValue<K extends string, V>(states: Readonly<Record<K, V>>, state: K): V {
  if (!Object.hasOwn(states, state)) throw new Error(`Invalid state: ${String(state)}`);
  return states[state];
}

export const memoryRoles = { person: "person", root: "root" } as const satisfies Record<MemoryRole, MemoryRole>;
export function isMemoryRole(value: unknown): value is keyof typeof memoryRoles {
  return typeof value === "string" && Object.hasOwn(memoryRoles, value);
}
export function memoryRole(value: string | undefined): keyof typeof memoryRoles {
  if (value === undefined) return "person";
  if (!isMemoryRole(value)) throw new Error("Invalid memory role");
  return value;
}

export function unreachable(value: never): never {
  throw new Error(`Unhandled memory operation: ${String(value)}`);
}
