import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerNestedSession } from "./session-context.js";

/** A retry window long enough to cover ordinary provider throttles while Pi
 * can replay the interrupted turn without changing the conversation. */
export const SESSION_RETRY = { enabled: true, maxRetries: 6, baseDelayMs: 5_000 } as const;

export interface HostedSessionOptions {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly model?: unknown;
  readonly thinkingLevel?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly accountId?: string;
  readonly tools?: string[];
  readonly customTools?: unknown[];
  readonly resourceLoader?: unknown;
  readonly sessionManager?: unknown;
  readonly parentSessionId?: string;
  readonly openSession?: typeof createAgentSession;
  readonly onExtensionError?: (extensionPath: string, error: unknown) => void;
}

export interface HostedSession {
  readonly session: AgentSession;
  readonly sessionId: string;
  dispose(): void;
}

/**
 * Open and fully initialize one embedded Pi session.
 *
 * Standing shifts and one-turn delegates share this path so extension binding,
 * extension-provider model resolution, retry settings, and teardown cannot
 * drift into two almost-identical runtimes.
 */
export async function openHostedSession(options: HostedSessionOptions): Promise<HostedSession> {
  const factory = options.openSession ?? createAgentSession;
  const { session } = await factory({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model: options.model as never,
    thinkingLevel: options.thinkingLevel as never,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.customTools === undefined ? {} : { customTools: options.customTools as never }),
    ...(options.resourceLoader === undefined ? {} : { resourceLoader: options.resourceLoader as never }),
    ...(options.sessionManager === undefined ? {} : { sessionManager: options.sessionManager as never }),
  });
  const sessionId = session.sessionManager.getSessionId();
  const unregisterNested = options.parentSessionId === undefined
    ? undefined
    : registerNestedSession(sessionId, options.parentSessionId);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unregisterNested?.();
    session.dispose();
  };

  try {
    // Binding emits session_start. Without it, extension tools may appear in
    // the schema while their MCP connections and other runtime state never
    // initialize.
    await session.bindExtensions({
      mode: "print",
      onError: (err: { extensionPath: string; error: unknown }) =>
        options.onExtensionError?.(err.extensionPath, err.error),
    } as never);

    if (options.model === undefined && options.provider !== undefined && options.modelId !== undefined) {
      const model = session.modelRuntime.getModel(options.provider, options.modelId);
      if (model === undefined) throw new Error(`unknown model ${options.provider}/${options.modelId}`);
      if (options.accountId !== undefined && options.accountId !== options.provider) {
        throw new Error(
          `account ${options.accountId} cannot alias extension provider ${options.provider}`,
        );
      }
      await session.setModel(model);
      if (options.thinkingLevel !== undefined) {
        session.setThinkingLevel(options.thinkingLevel as never);
      }
    }

    // setModel() rebuilds settings from disk, so this must remain last.
    session.settingsManager.applyOverrides({ retry: { ...SESSION_RETRY } });
    return { session, sessionId, dispose };
  } catch (thrown) {
    dispose();
    throw thrown;
  }
}

/** Delegates are deliberately ephemeral and isolated from parent history. */
export function delegatedSessionManager(cwd: string): unknown {
  return SessionManager.inMemory(cwd);
}
