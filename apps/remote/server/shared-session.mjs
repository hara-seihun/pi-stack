import { join } from 'node:path';
import { openCoreSession } from 'pi-orchestrator/api';
import { remoteRuntimeOutput } from './runtime-wire.mjs';

export async function openSession({ cwd, args, env, sessionId }, output, exit) {
  const id = sessionId || env.PI_REMOTE_SESSION_ID;
  if (!id) throw new Error('A stable PiStack session identity is required');
  const stateDir = env.PI_STACK_CORE_STATE_DIR || join(env.PI_REMOTE_DATA, 'core-sessions', id);
  return openCoreSession({ cwd, args, sessionId: id, stateDir,
    env: {...env, PI_STACK_CORE_OWNS_CHILDREN: '1'} }, remoteRuntimeOutput(output), exit);
}
