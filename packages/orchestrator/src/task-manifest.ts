import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Ledger } from "./ledger/ledger.js";
import { TIERS, type TaskSpec, type TeamSpec, type Tier, type TierShare } from "./tasks/types.js";

const TASK_KEYS = new Set([
  "id", "demandCommand", "demandCommandFile", "demandConstant", "gate", "tiers", "share",
  "prompt", "promptFile", "cwd", "exitWhenDrained", "doctrineUrl", "opening", "openingFiles",
  "openingProbe", "openingProbeFile", "selfPaced", "team",
]);

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(row: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${where}.${key} must be a string`);
  return value;
}

function optionalNumber(row: Record<string, unknown>, key: string, where: string): number | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}.${key} must be a finite number`);
  }
  return value;
}

function optionalBoolean(row: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where}.${key} must be a boolean`);
  return value;
}

function pathFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function text(
  row: Record<string, unknown>,
  inlineKey: string,
  fileKey: string,
  where: string,
  base: string,
): string | undefined {
  const inline = optionalString(row, inlineKey, where);
  const file = optionalString(row, fileKey, where);
  if (inline !== undefined && file !== undefined) {
    throw new Error(`${where} cannot set both ${inlineKey} and ${fileKey}`);
  }
  if (file === undefined) return inline;
  try {
    return readFileSync(pathFrom(base, file), "utf8");
  } catch (thrown) {
    throw new Error(`${where}.${fileKey} ${file}: ${String(thrown)}`);
  }
}

function stringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${where} must be an array of strings`);
  }
  return value as string[];
}

function tiers(value: unknown, where: string): TierShare[] {
  if (!Array.isArray(value)) throw new Error(`${where}.tiers must be an array`);
  return value.map((raw, index) => {
    if (typeof raw === "string") {
      if (!TIERS.includes(raw as Tier)) throw new Error(`${where}.tiers[${index}] has unknown tier ${raw}`);
      return { tier: raw as Tier, weight: 1 };
    }
    const item = object(raw, `${where}.tiers[${index}]`);
    const tier = item.tier;
    const weight = item.weight;
    if (typeof tier !== "string" || !TIERS.includes(tier as Tier)) {
      throw new Error(`${where}.tiers[${index}].tier is unknown`);
    }
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new Error(`${where}.tiers[${index}].weight must be a finite number`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "tier" && key !== "weight") throw new Error(`${where}.tiers[${index}] has unknown field ${key}`);
    }
    return { tier: tier as Tier, weight };
  });
}

function team(value: unknown, where: string, base: string): TeamSpec | undefined {
  if (value === undefined) return undefined;
  const row = object(value, `${where}.team`);
  const allowed = new Set(["workers", "supervisorPrompt", "supervisorPromptFile"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new Error(`${where}.team has unknown field ${key}`);
  }
  const workers = row.workers;
  if (!Number.isInteger(workers) || (workers as number) < 1) {
    throw new Error(`${where}.team.workers must be a positive integer`);
  }
  const supervisorPrompt = text(
    row,
    "supervisorPrompt",
    "supervisorPromptFile",
    `${where}.team`,
    base,
  );
  if (supervisorPrompt === undefined || supervisorPrompt.trim() === "") {
    throw new Error(`${where}.team needs supervisorPrompt or supervisorPromptFile`);
  }
  return { workers: workers as number, supervisorPrompt };
}

function task(raw: unknown, index: number, base: string): TaskSpec {
  const where = `task manifest tasks[${index}]`;
  const row = object(raw, where);
  for (const key of Object.keys(row)) if (!TASK_KEYS.has(key)) throw new Error(`${where} has unknown field ${key}`);
  const id = optionalString(row, "id", where);
  if (id === undefined || id.length === 0) throw new Error(`${where}.id must be a non-empty string`);

  const opening = stringArray(row.opening, `${where}.opening`);
  const openingFiles = stringArray(row.openingFiles, `${where}.openingFiles`);
  if (opening !== undefined && openingFiles !== undefined) {
    throw new Error(`${where} cannot set both opening and openingFiles`);
  }
  const resolvedOpening = openingFiles?.map((file) => {
    try {
      return readFileSync(pathFrom(base, file), "utf8");
    } catch (thrown) {
      throw new Error(`${where}.openingFiles ${file}: ${String(thrown)}`);
    }
  }) ?? opening;

  const demandCommand = text(row, "demandCommand", "demandCommandFile", where, base);
  const prompt = text(row, "prompt", "promptFile", where, base);
  const openingProbe = text(row, "openingProbe", "openingProbeFile", where, base);
  const demandConstant = optionalNumber(row, "demandConstant", where);
  const share = optionalNumber(row, "share", where);
  const exitWhenDrained = optionalBoolean(row, "exitWhenDrained", where);
  const selfPaced = optionalBoolean(row, "selfPaced", where);

  return {
    id,
    tiers: tiers(row.tiers, where),
    demandCommand,
    demandConstant,
    gate: optionalString(row, "gate", where),
    share,
    prompt,
    cwd: optionalString(row, "cwd", where),
    exitWhenDrained,
    doctrineUrl: optionalString(row, "doctrineUrl", where),
    opening: resolvedOpening,
    openingProbe,
    selfPaced,
    team: team(row.team, where, base),
  };
}

export function loadTaskManifest(path: string): TaskSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (thrown) {
    throw new Error(`task manifest ${path}: ${String(thrown)}`);
  }
  const document = object(parsed, "task manifest");
  for (const key of Object.keys(document)) {
    if (key !== "version" && key !== "tasks") throw new Error(`task manifest has unknown field ${key}`);
  }
  if (document.version !== 1) throw new Error("task manifest.version must be 1");
  if (!Array.isArray(document.tasks)) throw new Error("task manifest.tasks must be an array");
  const base = dirname(path);
  return document.tasks.map((item, index) => task(item, index, base));
}

export function reconcileTaskManifest(
  ledger: Ledger,
  path: string,
): { upserted: number; deleted: string[] } {
  return ledger.reconcileTasks(loadTaskManifest(path));
}
