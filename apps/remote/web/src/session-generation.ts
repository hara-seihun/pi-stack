import type { SyncResponse, ThreadSettings } from "../../server/protocol";

export interface SessionGeneration {
  id: string;
  coreGeneration: string;
  revision: number;
}

export function sameSessionGeneration(
  current: Pick<SessionGeneration, "id" | "coreGeneration"> | null | undefined,
  expected: Pick<SessionGeneration, "id" | "coreGeneration"> | null | undefined,
): boolean {
  return Boolean(current && expected
    && current.id === expected.id
    && current.coreGeneration === expected.coreGeneration);
}

export function responseGeneration(response: NonNullable<SyncResponse["session"]>): SessionGeneration {
  return { id: response.id, coreGeneration: response.coreGeneration, revision: response.revision };
}

export function settingsForGeneration(
  settings: ThreadSettings | null,
  generation: SessionGeneration | null,
): ThreadSettings | null {
  return settings && generation
    && settings.coreGeneration === generation.coreGeneration
    && settings.revision === generation.revision
    ? settings
    : null;
}

export function documentBase<T>(document: T, currentGeneration: string | null, nextGeneration: string): T | null {
  return currentGeneration === nextGeneration ? document : null;
}
