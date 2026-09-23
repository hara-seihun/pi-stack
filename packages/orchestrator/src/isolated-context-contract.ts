import { isAbsolute } from 'node:path';
import { ISOLATED_TOOLS, type RunContext } from './domain.js';

export function isRunContext(value: unknown): value is RunContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (Object.keys(context).some(key => key !== 'tools' && key !== 'extensions')) return false;
  if (context.extensions !== undefined && (!Array.isArray(context.extensions) || context.extensions.some(path => typeof path !== 'string' || !isAbsolute(path)))) return false;
  const custom = Array.isArray(context.extensions) && context.extensions.length > 0;
  return Array.isArray(context.tools) && context.tools.every(tool => typeof tool === 'string' &&
    (ISOLATED_TOOLS.includes(tool as typeof ISOLATED_TOOLS[number]) || custom && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool)));
}
