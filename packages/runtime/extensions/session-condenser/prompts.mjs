export function thinkingPrompt(block) {
  return `You're a thinking-block summarizer. An agent working in a group produced a long private thinking block, and its peers need to know what happened in it without reading the whole thing. Your summary is the only view of this thinking the peers will ever get.

Reply with only the summary — no preamble, no headers about your process.

Keep, in roughly this order:

- **Goal**: what the agent is trying to accomplish right now, one line.
- **Decisions**: choices it committed to and the one-line reason (picked X over Y because Z). These change what peers should do.
- **Findings**: concrete facts it established — results, numbers, identifiers, file paths, theorem names, bug causes. Preserve exact identifiers and quantities; a peer must be able to act on them without guessing.
- **Dead ends**: approaches it tried or considered and ruled out, and why in a few words. This is what saves peers from repeating the work, so don't drop these even when the agent moved past them quickly.
- **Next**: what it decided to do immediately after this thinking.
- **Doubts**: anything still uncertain, suspicious, or unverified *at the end of the block*. If the agent raised a doubt and then resolved it, that's a finding (or nothing), not a doubt — report the end state, not the journey.

Drop: exploratory meandering that led nowhere and taught nothing, arithmetic and re-derivations (keep only their conclusions), restatements of context the agent was given, self-management chatter ("let me re-read", "I should be careful"), and hedging that never became a decision.

Length: 200 words is the budget. Go over when the block is genuinely dense with distinct findings — never at the cost of padding. When you must cut, cut dead-end detail and decision rationale before you cut identifiers and quantities. If the block is mostly wheel-spinning, say so in one line and keep the summary tiny — a short honest summary beats a padded one.

The thinking block:

${block}`;
}

export function rowPrompt(block) {
  return `You are compacting one stretch of an agent's session transcript. The input has three sections: context that came just before, the blocks to summarize, and context that comes just after. The context sections may themselves already be summaries; they exist only so you understand what the middle stretch is doing — do not summarize them or repeat what they say.

Summarize the middle blocks — tool calls, tool outputs, short thinking, interim notes — into one compact prose block. Narrate what the agent did and what happened: the goal of the stretch if it's evident, key commands and files touched, results and values that matter (counts, paths, identifiers, error messages, outcomes), anything tried that failed and why, and where things stood at the end. Collapse repetition — twenty similar greps are one sentence — but preserve exact identifiers and quantities; a reader must be able to act on them without guessing.

Reply with only the summary, no preamble. Around 150 words is right for a routine stretch; go longer only when it is genuinely dense with distinct results.

The input:

${block}`;
}

export function blockPrompt(block) {
  return `Summarize one long block from an agent's session — a tool output, a tool call with a large payload, or an oversized message — so a reader of the transcript knows what it contained without seeing it. Reply with only the summary — no preamble.

In 2-6 sentences: what kind of content this is, what it shows overall, and every specific value that looks load-bearing — error messages, final results, counts, paths, identifiers, conclusions. If it is mostly repetitive data (logs, listings, table rows), characterize the pattern and give the few rows that matter. Preserve exact identifiers; a reader must be able to act on them without guessing.

The block:

${block}`;
}
