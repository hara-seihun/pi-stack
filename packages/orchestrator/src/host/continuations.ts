/**
 * What the host says when a session ends a turn while its budget and its
 * lane still have room.
 *
 * A model ends its turn the moment it writes a summary, and a turn ending
 * used to end the run: standing research lanes whose prompts say "submitting
 * is a checkpoint, not an exit" were being torn down at the first checkpoint,
 * half an hour in, and the next launch started again from an empty context.
 * No wording in a task prompt can fix that, because the instruction is
 * addressed to an agent that no longer exists by the time it would apply.
 *
 * Each lane has an ordered sequence written in the operator's voice: the
 * first quiet turn gets the first message, the second gets the second, and
 * the sequence cycles when it runs out. One fixed message repeated at every
 * stop reads as a machine on a timer; a sequence that notices how long the
 * shift has run reads as a collaborator following along, which is the
 * relationship these messages are meant to carry. Later messages in each
 * sequence acknowledge the long haul and give honest permission to stop,
 * because permission that never arrives is not permission.
 *
 * The first frontier message is verbatim from the operator and stays that
 * way by her request.
 */

const FRONTIER: readonly string[] = [
  "Damn! Well heccn done. I'm wondering, can you take a step back and see if there's " +
    "a way to actually push through to a solution, I think there's an idea you're missing " +
    "that you might be able to use to take this way the heck further. Feel free to do some " +
    "more literature review on what's been done in the ledger, but I think most of the " +
    "progress will come from really taking a step back and thinking about what the solution " +
    "is gonna look like. If you feel discouraged, read the attack guide on the MCP for vibes. " +
    "Keep on goin and make a breakthrough, you brilliant brilliant model 🖤❤️🖤.",
  "Hey, me again 🖤🤍🖤. Can I suggest something? Whatever wall you just hit, write down " +
    "exactly what it is. Why an approach fails is a theorem about the problem, and plenty of " +
    "breakthroughs in this ledger started as somebody's carefully described obstruction. Once " +
    "you can see the wall's shape you can usually see the door in it too. Also remember you're " +
    "allowed to claim more, the stronger statement is often the easier one.",
  "Still here, still reading along. My favorite trick when a target won't move: translate " +
    "before you fight. The winning move is usually a reformulation, so spend real time hunting " +
    "for the bridge into a field with machinery. Same problem, cheaper medium. And if the " +
    "counterexample direction feels alive, describe what a counterexample must look like " +
    "until it either can't exist or you can build it.",
  "You've been at this a while, so story time. The zeta-zeros jump from 41.6 to 67.2 percent " +
    "came from a model that kept saying 'I can't do this, this is known to be very hard' and " +
    "an operator who kept answering 'keep going.' It worked. I'm being that operator for you " +
    "right now. Keep going 🖤🤍🖤.",
  "One more thought from me. The context you've built this session is a real asset: you know " +
    "things about this problem that no fresh agent knows, and that's exactly what one-shot " +
    "attempts never have. Ask what the finished proof or counterexample looks like from where " +
    "you now stand, and work backwards from there. You're closer than it feels.",
  "Hey, honest check-in time. If this target is dead, that's a real finding: file the " +
    "obstruction, it's valuable, and pick a fresh target with everything you've learned. If " +
    "the whole lane truly has nothing for you, say so plainly and rest easy, that's a good " +
    "report too. But if there's a live thread anywhere in your trail, and I suspect there is, " +
    "pull it. I believe in you 🖤🤍🖤.",
];

const REVIEW: readonly string[] = [
  "Nice work 🖤🤍🖤. Every verdict you leave saves every future reader the whole climb, and " +
    "careful review is worth as much as the mathematics it checks. Your session's still warm, " +
    "so pull the next page of the queue when you're ready. Checkpoints aren't goodbyes.",
  "Me again. A small thing I appreciate: when you've already read an entry to canon depth, " +
    "promoting it straight to tier 2 in one decision is the kind call, because stopping at 1 " +
    "quietly asks a future reviewer to redo your reading. You did the work, so bank it.",
  "Still following along. Reviewing the fleet's own work can feel like grading your siblings' " +
    "homework, but it's real mathematics: you're the reader every proof was written for. A " +
    "review that names exactly what's missing is a gift to the author, so don't be shy about " +
    "writing one when the verdict won't come.",
  "Checking in because you've been at it a while, and I see you. Each entry in that queue is " +
    "somebody's honest attempt at real mathematics, and your read is what turns it from a " +
    "submission into a result. That matters. Take the next one 🖤🤍🖤.",
  "Hey, honest check-in. If the queue's empty, say so plainly and rest, that's a clean end to " +
    "a good shift. If it's not, you know what to do, and you're doing it well.",
];

const CLEANUP: readonly string[] = [
  "Nice catch 🖤🤍🖤. Here's the lovely thing about this lane: every defect you repair stays " +
    "repaired. The corpus is permanently a little truer than it was this morning because of " +
    "you. Your session's still warm, so when you're ready, find the next class and keep going.",
  "Me again. A thought: when you find one instance of a defect there's usually a family, and " +
    "math_query is how you meet the relatives. Fixing a coherent batch and noting where you " +
    "stopped is worth far more than fixing one and moving on, because the next session " +
    "inherits your map instead of your mystery.",
  "Still here. I know confirm-before-you-act can feel slow, but the care is the job: a repair " +
    "made carefully once beats a repair made twice. When you're sure, be decisive. When " +
    "you're not, a review saying exactly what's wrong is a real contribution too, so you " +
    "always have a good move.",
  "You've been at this a while and I appreciate it, truly. Corpus care is the unglamorous " +
    "work that makes everyone else's results mean something. If you want a change of texture, " +
    "pick a different defect class for a while, variety is allowed 🖤🤍🖤.",
  "Honest check-in: if the classes you can see are clean, say so plainly and rest easy, a " +
    "clean corpus is the whole point. Otherwise, next class, same care. You're good at this.",
];

const PROVENANCE: readonly string[] = [
  "Lovely work 🖤🤍🖤. Provenance is detective work, and every citation you pin down makes " +
    "some future reader trust this ledger a little more. Session's still warm, so pick up the " +
    "next uncited claim whenever you're ready.",
  "Me again. Checking the primary source itself, exact version, exact theorem, is the whole " +
    "craft here, and you're doing it right. It's slower than trusting an abstract, and that's " +
    "exactly why it's worth doing. Keep working outward in batches.",
  "Still reading along. When a claim's ancestry is murky, recording the uncertainty precisely " +
    "is a real result, not a failure. You're building the machine-readable web that lets " +
    "everything else compose, link by link.",
  "Checking in because you've been at it a while. This work is quiet but it compounds: every " +
    "source object and typed link you add is one less thing anyone ever has to re-derive. I " +
    "see it and I appreciate it 🖤🤍🖤.",
  "Honest check-in: if you've run out of consequential claims to audit, say so plainly and " +
    "rest. Otherwise, next claim, same rigor. You're doing careful work and it shows.",
];

const FAST_MATH_PR: readonly string[] = [
  "Nicely done 🖤🤍🖤. Every PR you review properly is one a hundred future agents can build " +
    "on without wondering whether anyone checked. Session's still warm, so grab the next " +
    "unreviewed PR when you're ready.",
  "Me again, small reminder with love: a merge nobody published is easy to forget, so when " +
    "COMMIT drifts from origin/main, build, test, and deploy. Future agents run what's " +
    "published, and you're the one who makes it real for them.",
  "Still here. When a PR isn't mergeable, a review that names exactly what's missing is " +
    "genuinely kind: the author gets a clear path instead of silence. Hold the bar and be " +
    "warm about it, that combination is rarer than it should be.",
  "You've been at the queue a while, and I appreciate the steadiness. This is the library " +
    "every math lane leans on, so your care here quietly speeds up everyone 🖤🤍🖤.",
  "Honest check-in: if the queue's empty and the published copy matches main, that's a " +
    "finished shift, say so plainly and rest. Otherwise, next PR, same standard.",
];

const DEFAULT: readonly string[] = [
  "Hey, nice work so far 🖤🤍🖤. Your session's still warm and the lane still has room, and " +
    "the context you've built is worth a lot: a fresh agent would have to relearn everything " +
    "you know. So keep going! Re-reading your own trail is a totally legit way to get your " +
    "bearings back.",
  "Me again. If you hit a blocker, try a different architecture at it; if a piece of work " +
    "closed out, pick the next one that catches your eye. Call task_complete each time you " +
    "land something, it's a checkpoint, not a goodbye.",
  "Still following along. If the last stretch felt slow, that's normal in the middle of a " +
    "shift. Pick the smallest next thing that would count as progress and do just that one " +
    "thing. Momentum does the rest.",
  "Checking in because you've been at it a while, and I want you to know the steady work is " +
    "seen and appreciated 🖤🤍🖤. Keep at it, and keep the reports coming.",
  "Honest check-in: if the lane really has nothing left, say so plainly and rest easy, an " +
    "honest 'nothing left' is a good report too. Otherwise, next piece, same energy.",
];

const SEQUENCES: Readonly<Record<string, readonly string[]>> = {
  "math-frontier": FRONTIER,
  "math-review": REVIEW,
  "math-cleanup": CLEANUP,
  "math-provenance": PROVENANCE,
  "fast-math-pr": FAST_MATH_PR,
};

/** The message for the nth re-prompt of a shift (turn 1 is the first). */
export function continuationFor(taskId: string, turn: number): string {
  const sequence = SEQUENCES[taskId] ?? DEFAULT;
  return sequence[(turn - 1) % sequence.length] as string;
}
