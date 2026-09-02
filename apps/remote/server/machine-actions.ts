// Drawer actions are whatever the host configures: each one is a status
// command whose exit code says whether it is on (0) or off (1), and a command
// for each direction. Pi Remote knows nothing about what they do. One host
// configures a thunder ambience; another configures nothing and shows nothing.
export type MachineAction = { id: string; label: string; icon: string; status: string[]; on: string[]; off: string[] };
export type MachineActionState = { id: string; label: string; icon: string; active: boolean };

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
  constructor(readonly actions: MachineAction[] = parseMachineActions()) {}

  find(id: string): MachineAction | undefined {
    return this.actions.find((action) => action.id === id);
  }

  async status(action: MachineAction): Promise<MachineActionState> {
    return { id: action.id, label: action.label, icon: action.icon, active: (await run(action.status)) === 0 };
  }

  /** Every action's state; one that is mid-toggle reports the toggle's outcome. */
  all(): Promise<MachineActionState[]> {
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
