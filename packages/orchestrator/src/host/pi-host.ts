import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostEvents, HostManager, HostRunResult, LaunchSpec } from "./types.js";

/**
 * In-process host: each launch is one embedded pi AgentSession. This file is
 * a thin adapter over the pi SDK and holds no policy — capacity, custody,
 * and retry decisions all live upstream in broker and controller, so the
 * only logic here is session lifecycle and result plumbing.
 *
 * The task prompt is delivered as the session's first user message (the SDK
 * assembles the system prompt itself, so hosted sessions see exactly what an
 * interactive session would). Nothing here may mention tiers.
 */

const HEARTBEAT_MS = 30_000;

interface CompletionReport {
  complete: boolean;
  productive?: boolean;
  summary: string;
  artifacts?: string[];
}

export class PiHost implements HostManager {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly events: HostEvents,
    private readonly options: {
      /** pi agent dir (auth.json, models.json). Default: SDK default. */
      readonly agentDir?: string;
      /** Resolve a launch's provider/model to a pi Model object. */
      readonly resolveModel: (provider: string, model: string) => unknown;
    },
  ) {}

  launch(spec: LaunchSpec): void {
    void this.run(spec)
      .catch((thrown: unknown): HostRunResult => ({ state: "error", detail: String(thrown) }))
      .then((result) => this.events.runFinished(spec.runId, result, Date.now()));
  }

  abort(runId: string): void {
    void this.sessions.get(runId)?.abort();
  }

  /** Whether a session for this run is still live in this process. */
  has(runId: string): boolean {
    return this.sessions.has(runId);
  }

  private async run(spec: LaunchSpec): Promise<HostRunResult> {
    let report: CompletionReport | undefined;
    const taskComplete = {
      name: "task_complete",
      label: "Complete task",
      description:
        "Report this launch's validated result. Call it when your work is done; " +
        "calling it again replaces the earlier report. Set complete=true only when " +
        "the task's completion condition is satisfied. Set productive=false only " +
        "when this launch processed no work unit at all.",
      parameters: Type.Object({
        complete: Type.Boolean(),
        productive: Type.Optional(
          Type.Boolean({ description: "Whether this launch processed a real work unit. Defaults to true." }),
        ),
        summary: Type.String({ minLength: 1 }),
        artifacts: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_id: string, params: CompletionReport) => {
        report = params;
        return { content: [{ type: "text" as const, text: "Report recorded." }], details: undefined };
      },
    };

    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.options.agentDir,
      // The SDK's Model type is provider-internal; the resolver returns one.
      model: this.options.resolveModel(spec.provider, spec.model) as never,
      customTools: [taskComplete],
    });
    this.sessions.set(spec.runId, session);
    const heartbeat = setInterval(
      () => this.events.heartbeat(spec.runId, Date.now()),
      HEARTBEAT_MS,
    );
    try {
      await session.prompt(spec.prompt);
      if (report === undefined) {
        return { state: "done", productive: false, detail: "no task_complete report" };
      }
      return {
        state: "done",
        productive: report.productive ?? true,
        complete: report.complete,
        detail: report.summary,
      };
    } finally {
      clearInterval(heartbeat);
      this.sessions.delete(spec.runId);
      session.dispose();
    }
  }
}
