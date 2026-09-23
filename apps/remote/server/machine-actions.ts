// Drawer actions are whatever the host configures: each one is a status
// command whose exit code says whether it is on (0) or off (1), and a command
// for each direction. Pi Remote knows nothing about what they do. One host
// configures a thunder ambience; another configures nothing and shows nothing.
import type { MachineActionState } from "./protocol";

export type MachineAction = { id: string; label: string; icon: string; status: string[]; on: string[]; off: string[] };
export type { MachineActionState };

export function parseMachineActions(raw = process.env.PI_REMOTE_ACTIONS ?? "[]"): MachineAction[] {
  return (JSON.parse(raw) as MachineAction[]).map((action) => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(action.id)) throw new Error(`PI_REMOTE_ACTIONS: invalid action id ${action.id}`);
    for (const key of ["status", "on", "off"] as const) {
      if (!Array.isArray(action[key]) || action[key].length === 0 || action[key].some((part) => typeof part !== "string")) {
        throw new Error(`PI_REMOTE_ACTIONS: action ${action.id} needs a ${key} argv array`);
      }
    }
    return { ...action, label: String(action.label ?? action.id), icon: String(action.icon ?? action.id) };
  });
}

async function run(argv: string[], timeoutMs = 15_000): Promise<number> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `${argv[0]} exited ${code}`);
    return code;
  } finally { clearTimeout(timer); }
}

export class MachineActions {
  private readonly toggles = new Map<string, Promise<MachineActionState>>();
  private readonly states = new Map<string, MachineActionState>();
  constructor(readonly actions: MachineAction[] = parseMachineActions()) {
    for (const action of actions) this.states.set(action.id, { id: action.id, label: action.label, icon: action.icon, active: false });
  }

  find(id: string): MachineAction | undefined {
    return this.actions.find((action) => action.id === id);
  }

  async status(action: MachineAction): Promise<MachineActionState> {
    const state = { id: action.id, label: action.label, icon: action.icon, active: (await run(action.status)) === 0 };
    this.states.set(action.id, state);
    return state;
  }

  /** The last observed state of every action, in configuration order. */
  all(): MachineActionState[] {
    return this.actions.map((action) => this.states.get(action.id)!);
  }

  /** Re-run every status command; a mid-toggle action reports the toggle's outcome. */
  refresh(): Promise<MachineActionState[]> {
    return Promise.all(this.actions.map((action) => this.toggles.get(action.id) ?? this.status(action)));
  }

  toggle(action: MachineAction): Promise<MachineActionState> {
    const pending = this.toggles.get(action.id);
    if (pending) return pending;
    const operation = (async () => {
      const current = await this.status(action);
      await run(current.active ? action.off : action.on);
      return this.status(action);
    })().finally(() => { this.toggles.delete(action.id); });
    this.toggles.set(action.id, operation);
    return operation;
  }
}
