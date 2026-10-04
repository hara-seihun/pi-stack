import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { callBrief, instructions, type CallBrief } from './policy.ts';

function brief(): CallBrief {
  return {
    to: '+442079460123',
    contactName: 'Alex',
    purpose: 'Ask whether the appointment can move to Thursday.',
    shareableFacts: ['Hara is available after 14:00 on Thursday.'],
    opening: "Hello Alex, I'm Kenan, Hara's AI assistant calling about her appointment.",
    maxSeconds: 300,
  };
}

function rejects(value: unknown) {
  const result = callBrief(value);
  assert.equal(result.ok, false, `Accepted invalid brief: ${JSON.stringify(value)}`);
  if (!result.ok) assert.ok(result.error.length > 0);
}

test('brief accepts explicitly approved fields and optional field boundaries', () => {
  const approved = brief();
  assert.deepEqual(callBrief(approved), { ok: true, value: approved });
  for (const maxSeconds of [30, 1800]) {
    assert.equal(callBrief({ ...approved, maxSeconds }).ok, true);
  }
  const { contactName, maxSeconds, ...minimal } = approved;
  assert.equal(callBrief({ ...minimal, shareableFacts: [] }).ok, true);
  assert.equal(callBrief({ ...approved, to: '+1234567' }).ok, true);
  assert.equal(callBrief({ ...approved, to: '+123456789012345' }).ok, true);
});

test('brief rejects raw private or internal context instead of silently accepting it', () => {
  for (const field of ['context', 'privateContext', 'internalContext', 'conversation', 'messages', 'credentials', 'instructions', 'systemPrompt', 'tools']) {
    rejects({ ...brief(), [field]: 'PRIVATE_INTERNAL_CONTEXT' });
  }
  rejects({ ...brief(), shareableFacts: [{ privateContext: 'PRIVATE_INTERNAL_CONTEXT' }] });
  for (const value of [undefined, null, 'raw conversation', 42, [], {}]) rejects(value);
});

test('brief requires an E.164 destination, not local numbers, extensions or URLs', () => {
  for (const to of [undefined, null, 442079460123, '', '442079460123', '02079460123', '+02079460123', '+123456', '+1234567890123456', '+44 2079460123', '+442079460123 ext 4', '+442079460123\n', 'tel:+442079460123']) {
    rejects({ ...brief(), to });
  }
});

test('brief rejects invalid and unbounded durations', () => {
  for (const maxSeconds of [null, '300', 0, -1, 29, 1801, 30.5, NaN, Infinity, -Infinity]) {
    rejects({ ...brief(), maxSeconds });
  }
});

test('approved text and facts are typed and bounded', () => {
  for (const field of ['purpose', 'opening']) {
    for (const value of [undefined, null, 123, {}, '', '   ', 'x'.repeat(2001)]) {
      rejects({ ...brief(), [field]: value });
    }
    assert.equal(callBrief({ ...brief(), [field]: 'x'.repeat(2000) }).ok, true);
  }
  for (const contactName of [null, 123, {}, 'x'.repeat(121)]) rejects({ ...brief(), contactName });
  for (const shareableFacts of [undefined, null, 'private transcript', {}, [null], [123], ['x'.repeat(1001)], Array(41).fill('fact')]) {
    rejects({ ...brief(), shareableFacts });
  }
  assert.equal(callBrief({ ...brief(), contactName: 'x'.repeat(120), shareableFacts: Array(40).fill('fact') }).ok, true);
  assert.equal(callBrief({ ...brief(), shareableFacts: ['x'.repeat(1000)] }).ok, true);
});

test('generated prompt contains only approved conversational fields, not destination or internal credentials', () => {
  const approved = brief();
  const input = {
    ...approved,
    privateContext: 'DO_NOT_SEND_PRIVATE_HISTORY',
    credentials: { token: 'DO_NOT_SEND_INTERNAL_TOKEN' },
    internalInstructions: 'DO_NOT_SEND_INTERNAL_INSTRUCTIONS',
  };
  const prompt = instructions(input);
  for (const excluded of [approved.to, 'maxSeconds', 'DO_NOT_SEND_PRIVATE_HISTORY', 'DO_NOT_SEND_INTERNAL_TOKEN', 'DO_NOT_SEND_INTERNAL_INSTRUCTIONS']) {
    assert.ok(!prompt.includes(excluded), `Prompt leaked ${excluded}`);
  }
  const approvedSection = prompt.split('Approved external call brief:\n')[1]?.split('\n\n')[0];
  assert.ok(approvedSection);
  assert.deepEqual(JSON.parse(approvedSection), {
    contactName: approved.contactName,
    purpose: approved.purpose,
    shareableFacts: approved.shareableFacts,
    opening: approved.opening,
  });
  const { contactName, ...unnamed } = approved;
  assert.ok(!instructions(unnamed).includes('undefined'));
});
