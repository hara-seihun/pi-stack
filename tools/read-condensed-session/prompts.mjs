export function thinkingPrompt(block) {
  return `You're summarizing one long private thinking block from an agent session. This summary will feed a later episode summary, so preserve facts a peer would need to recover the work rather than narrating every thought.

Reply with only the summary. Keep:

- the immediate goal;
- decisions and their reasons;
- concrete findings, including exact numbers, identifiers, paths, theorem names, commands, and error messages;
- approaches rejected or tried unsuccessfully, with the reason;
- the state and intended next action at the end;
- doubts that remained unresolved at the end.

Drop exploratory meandering, repeated context, arithmetic once its conclusion is known, and self-management chatter. Do not turn a failed approach into a finding or an early doubt into an unresolved doubt. About 200 words is a budget, not a target: use less for wheel-spinning and more when distinct load-bearing facts require it.

The thinking block:

${block}`;
}

export function episodePrompt(block) {
  return `You are condensing one complete work episode from an agent's session. It is the activity between durable conversational anchors, such as a user request and the assistant answer the user later replied to. The input may contain tool calls and results, short thinking, interim prose, and labeled pre-summaries of unusually large blocks. Context sections before and after the episode are only orientation: do not summarize or repeat them.

Write the episode as a compact chronological account from which another capable agent can recover the work. Preserve:

- what the agent was trying to do and the approach it took;
- decisions and conclusions, including why alternatives were rejected;
- exact paths, identifiers, commands, counts, values, error messages, and externally visible changes that remain useful;
- failed or abandoned approaches and what they taught;
- tests or checks run and their outcomes;
- where the work stood at the end, including unresolved questions and the next intended action.

Collapse repeated searches, retries, and near-identical tool calls into one sentence. Distinguish proposals from changes actually made and tentative beliefs from verified results. A labeled pre-summary represents a large source block: integrate its facts normally without mentioning the condensation machinery. Do not invent connective facts to smooth gaps.

Reply with only the account, no preamble. Roughly 250–400 words suits a routine episode. Use fewer when little happened and up to about 900 when the episode has many distinct, actionable facts; retrieval fidelity matters more than hitting a length target.

The input:

${block}`;
}

export function blockPrompt(block) {
  return `Summarize one unusually large block from an agent session so it can be incorporated into a later episode account. The block may be a tool result, a tool call with a large payload, or oversized assistant prose.

Reply with only the summary. State what the content is, what it establishes overall, and every load-bearing value: exact errors, results, counts, paths, identifiers, decisions, and conclusions. For repetitive logs, listings, or tables, characterize the pattern and retain the exceptional rows. Distinguish a proposal or attempted edit from a change that actually succeeded. Use 2–8 sentences for routine material and go longer only when distinct facts require it.

The block:

${block}`;
}

/** The exact model prompt is also the cache identity, so prompt edits invalidate stale summaries automatically. */
export function promptForJob(kind, block) {
  if (kind === "thinking") return thinkingPrompt(block);
  if (kind === "episode") return episodePrompt(block);
  return blockPrompt(block);
}
