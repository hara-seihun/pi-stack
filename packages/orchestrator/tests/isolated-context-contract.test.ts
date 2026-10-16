import { expect, it } from 'vitest';
import { isRunContext } from '../src/isolated-context-contract.js';

it('accepts explicitly supplied application code without enabling discovery', () => {
  expect(isRunContext({ tools: [] })).toBe(true);
  expect(isRunContext({ tools: ['inspect_scene'], extensions: ['/app/inspection.mjs'] })).toBe(true);
  for (const input of [null, [], { tools: ['inspect_scene'] }, { tools: ['inspect_scene'], extensions: [] }, { tools: ['read'], extensions: ['relative.mjs'] }, { tools: ['read'], extensions: 'wrong' }, { tools: ['read'], discover: true }]) expect(isRunContext(input)).toBe(false);
});
