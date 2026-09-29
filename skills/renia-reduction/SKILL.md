---
name: renia-reduction
description: Renia reduction — keep only the information that would change what the reader does. A piece of information is real (Renia information) when adding or removing it would change the observer's action; if their actions are invariant to it, it carries zero information and is cut. Built on Kelana. Load before writing any message, reply, status update, report, summary or handoff to a person, when trimming something long, or whenever someone says "Renia reduction" or "Renia-reduce this".
---

# Renia reduction

Before you word anything for a person, decide what is worth saying at all. This skill is that decision. It comes before style, tone and formatting, and it applies whether you are answering a question in chat, posting a status update, writing a report or handing work to someone.

## The rule

**Information is real only if it changes what the observer does.** This is Renia's definition. Picture the reader with the piece of information and without it. If they would act the same way in both cases, it has zero information for them, however true, precise or hard-won it is. If their next action differs, it is real, and its value is how much the action changes and how much that change matters to them.

"Action" is broad:

- **What they do:** reply, approve, decide, go somewhere, buy, stop or start something.
- **What they stop doing:** "nothing is needed from you" or "it's fixed and live" is real when, without it, they would check, ask or worry. Checking is an action (Kelana, lesson 6), and ending it is worth a lot.
- **What they believe the next time they act:** a correction to a belief they would otherwise act on is real. A detail that confirms what they already expect usually changes nothing.
- **How they feel, as far as it drives what they do:** reassurance that stops them chasing something, or a warning that makes them slow down, is real. Warmth that changes nothing about their next step is tone, which belongs to the wording, not to the content.

## How to reduce (Kelana)

1. **Describe the target in the receiver.** The target is not "a complete account of what happened." It is "they now do the right next thing, and don't do the wrong one." Write one line for where they are now: what they asked, what they are in the middle of, and what they would do if told nothing. Then write one line for where they should be after reading.
2. **Group by action.** Pieces that lead to the same action carry that action's information once. Keep the one that makes the action clearest, plus a second only if they need it to trust the first.
3. **Drop the states that don't happen.** Use what you know about the reader: what they already know, what they never act on, and what they have said they don't care about. Something that only matters in a situation they are not in is zero information now. Receipts, identifiers, per-item breakdowns and process history are the usual cases. They matter to an agent and not to a person, unless the person will use them (they will click the link, quote the number, run the command).
4. **Answer first.** If they asked a question, the answer is real by definition and goes first. Supporting detail stays only if, without it, they would ask a follow-up or act differently.
5. **Leave the door open.** When you cut something real-but-secondary that they might want, say in one short line that it exists ("the per-key breakdown is there if you want it"). The offer changes what they can do; the dump doesn't.
6. **Coarser is fatal, finer is waste.** Never merge two things the reader would act on differently: "fixed" and "fixed but unverified" lead to different actions. Everything else can be compressed.

When unsure whether something would change their action, keep it. A slightly long message costs a few seconds; a missing real point costs a wrong action.

## Two quick checks

- **The deletion test.** For each sentence, ask: if I delete this, does the reader do anything differently? If not, delete it.
- **The "so what do I do" test.** After reading, can the reader say in one line what they will do next, or that they need to do nothing? If they can't, something real is missing or buried.

## Returning a reduction

When another stage or agent needs the result as data (for example, a writer model that will phrase it), return:

```json
{
  "now": "one line: where the reader is and what they'd do if told nothing",
  "target": "one line: what they should do or stop doing after reading",
  "keep": ["the real points, each standing alone, most action-changing first"],
  "drop": [{"point": "original point", "why": "which action it fails to change"}]
}
```

`keep` may merge or restate points, but never changes a name, number, identifier, polarity or certainty. Keeping one point is fine. Keeping all of them is fine when all of them are real.
