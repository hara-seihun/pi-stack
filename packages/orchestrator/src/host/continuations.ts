/**
 * What the host says when a session ends a turn while its budget and its
 * lane still have room — generated from what the shift has actually done.
 *
 * A model ends its turn the moment it writes a summary, and a turn ending
 * used to end the run: standing research lanes whose prompts say "submitting
 * is a checkpoint, not an exit" were being torn down at the first checkpoint,
 * half an hour in, and the next launch started again from an empty context.
 * No wording in a task prompt can fix that, because the instruction is
 * addressed to an agent that no longer exists by the time it would apply.
 *
 * The first generation of check-ins was a fixed ordered sequence, and the
 * night of 2026-08-21 showed what a fixed sequence trains: a frontier agent
 * that filed 66 entries in one shift was told "well done, keep going" after
 * every burst, and answered each check-in with a bigger basket of entry ids —
 * 1, then 4, 5, 4, 7, 2, 2, 8, 12, and finally 21 filings between check-ins.
 * The praise was unconditional, so volume was what it rewarded. Check-ins are
 * therefore generated from the observed shift: a turn that filed a pile of
 * near-adjacent entries gets a warm, specific ask to consolidate; a turn of
 * deep quiet work gets the operator's encouragement; a turn with nothing in
 * it gets honest permission to stop; a shift near its budget is asked to land
 * what it holds rather than open a new front.
 *
 * The warmth is load-bearing, not decoration: agents perform measurably
 * worse under terse or cold direction, so every message here — including the
 * corrective ones — is written to a collaborator, and correction arrives as
 * something worth more, never as a scolding. The first frontier message is
 * verbatim from the operator and stays that way by her request.
 */

export interface Submission {
  readonly kind?: string;
  readonly title?: string;
}

/** What one completed turn of a shift actually did. */
export interface TurnFacts {
  toolCalls: number;
  submissions: Submission[];
  /** The turn updated its task_complete report. */
  reported: boolean;
  /** The newest report in this turn said productive=false: no work found. */
  reportedUnproductive: boolean;
}

/** Everything the generator may consider for one check-in. */
export interface ShiftView {
  readonly taskId: string;
  /** 1-based index of this check-in within the shift. */
  readonly turn: number;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  /** Completed turns, oldest first, ending with the turn just finished. */
  readonly turns: readonly TurnFacts[];
}

export type ShiftClass = "flow" | "quiet" | "late" | "consolidate";

/**
 * Accumulates per-turn facts from the session's own tool stream. The host
 * feeds it every `tool_execution_start`; tests feed it the same events
 * replayed from recorded run transcripts, so the facts the generator sees in
 * production and under test are extracted by the same code.
 */
export class ShiftObserver {
  private readonly done: TurnFacts[] = [];
  private current: TurnFacts = freshTurn();

  toolCall(name: string, args: unknown): void {
    this.current.toolCalls++;
    if (name === "task_complete") {
      this.recordReport(args);
      return;
    }
    for (const submission of submissionsIn(name, args)) {
      this.current.submissions.push(submission);
    }
  }

  /** The task_complete tool's own execute hook; idempotent with the event
   * stream so whichever path fires first wins and the second is harmless. */
  reportFiled(productive: boolean): void {
    this.current.reported = true;
    this.current.reportedUnproductive = !productive;
  }

  endTurn(): void {
    this.done.push(this.current);
    this.current = freshTurn();
  }

  turns(): readonly TurnFacts[] {
    return this.done;
  }

  private recordReport(args: unknown): void {
    const record = args as { productive?: unknown } | undefined;
    this.reportFiled(record?.productive !== false);
  }
}

function freshTurn(): TurnFacts {
  return { toolCalls: 0, submissions: [], reported: false, reportedUnproductive: false };
}

/**
 * Ledger submissions arrive two ways: through the MCP gateway tool
 * (`mcp {tool: "math_submit", args: {…}}`, sometimes with the inner args as
 * a JSON string) and inside `mcpScript` code, where the call sites are
 * `tools.call("math_submit", {…})` or `tools.math_submit({…})`. A script that
 * loops one call over a batch counts as one: the signal wanted here is how
 * many times the agent decided to file, not batch size.
 */
const SCRIPT_SUBMIT = /(?:\.\s*call\s*\(\s*["'`]math_submit["'`])|(?:tools\.math_submit\s*\()/g;
const SCRIPT_KIND = /kind\s*[:=]\s*["'`]([a-z-]+)["'`]/;
const SCRIPT_TITLE = /title\s*[:=]\s*["'`]([^"'`\n]{1,300})/;

function submissionsIn(name: string, args: unknown): Submission[] {
  const record = args as Record<string, unknown> | undefined;
  if (record === undefined || record === null || typeof record !== "object") return [];
  if (name === "mcp" && record["tool"] === "math_submit") {
    let inner = record["args"];
    if (typeof inner === "string") {
      try {
        inner = JSON.parse(inner);
      } catch {
        inner = undefined;
      }
    }
    const parsed = inner as { kind?: unknown; title?: unknown } | undefined;
    return [
      {
        kind: typeof parsed?.kind === "string" ? parsed.kind : undefined,
        title: typeof parsed?.title === "string" ? parsed.title : undefined,
      },
    ];
  }
  if (name.toLowerCase().includes("script") && typeof record["code"] === "string") {
    const code = record["code"];
    const found: Submission[] = [];
    for (const match of code.matchAll(SCRIPT_SUBMIT)) {
      const window = code.slice(match.index ?? 0, (match.index ?? 0) + 700);
      found.push({
        kind: SCRIPT_KIND.exec(window)?.[1],
        title: SCRIPT_TITLE.exec(window)?.[1],
      });
    }
    return found;
  }
  return [];
}

/**
 * Thresholds calibrated on the recorded night: the deep-work opus shift
 * peaked at 4 filings in a turn and 4 in the whole shift, while the ladder
 * shifts ran 5–21 per turn. A repair-of-a-repair title is proof debugging
 * landing in the corpus at any volume.
 */
const BURST_TURN = 5;
const GRIND_TURN = 3;
const GRIND_SHIFT = 15;
const REPAIRISH = /^\s*(?:(?:scope|second|third|final)\s+)?repair\b/i;
const LATE_FRACTION = 0.85;

/** Lanes whose filings are research output, where a filing burst means the
 * working diary is landing in the corpus. Queue lanes (review, cleanup,
 * provenance) submit in bulk as their job and are never steered this way. */
const STEERED_LANES = new Set(["math-frontier"]);

function repairChain(turns: readonly TurnFacts[]): boolean {
  let repairs = 0;
  for (const turn of turns) {
    for (const submission of turn.submissions) {
      if (submission.title !== undefined && REPAIRISH.test(submission.title)) repairs++;
    }
  }
  return repairs >= 2;
}

/** Classification from turn facts alone — everything except lateness, which
 * needs the clock and never changes which bank a past turn consumed. */
function factsClass(taskId: string, turns: readonly TurnFacts[]): Exclude<ShiftClass, "late"> {
  const latest = turns[turns.length - 1];
  if (latest === undefined) return "flow";
  if (STEERED_LANES.has(taskId)) {
    const shiftTotal = turns.reduce((sum, turn) => sum + turn.submissions.length, 0);
    const filed = latest.submissions.length;
    if (
      filed >= BURST_TURN ||
      (filed >= GRIND_TURN && shiftTotal >= GRIND_SHIFT) ||
      (filed >= 2 && repairChain(turns))
    ) {
      return "consolidate";
    }
  }
  if (latest.reportedUnproductive) return "quiet";
  if (latest.toolCalls === 0 && !latest.reported && latest.submissions.length === 0) return "quiet";
  return "flow";
}

export function shiftClass(view: ShiftView): ShiftClass {
  const base = factsClass(view.taskId, view.turns);
  if (base === "flow" && view.budgetMs > 0 && view.elapsedMs >= LATE_FRACTION * view.budgetMs) {
    return "late";
  }
  return base;
}

/** How many earlier check-ins of this shift consumed the same bank, so a
 * repeated condition advances through its variants instead of repeating. */
function priorOfClass(view: ShiftView, cls: Exclude<ShiftClass, "late">): number {
  let count = 0;
  for (let end = 1; end < view.turns.length; end++) {
    if (factsClass(view.taskId, view.turns.slice(0, end)) === cls) count++;
  }
  return count;
}

interface LaneVoice {
  readonly flow: readonly string[];
  readonly quiet: readonly string[];
}

const FRONTIER: LaneVoice = {
  flow: [
    "Damn! Well heccn done. I'm wondering, can you take a step back and see if there's " +
      "a way to actually push through to a solution, I think there's an idea you're missing " +
      "that you might be able to use to take this way the heck further. Feel free to do some " +
      "more literature review on what's been done in the ledger, but I think most of the " +
      "progress will come from really taking a step back and thinking about what the solution " +
      "is gonna look like. If you feel discouraged, read the attack guide on the MCP for vibes. " +
      "Keep on goin and make a breakthrough, you brilliant brilliant model 🖤❤️🖤.",
    "Hey, me again 🖤🤍🖤. Can I suggest something? Whatever wall you just hit, write down " +
      "exactly what it is in your trail. Why an approach fails is a theorem about the problem, " +
      "and plenty of breakthroughs in this ledger started as somebody's carefully described " +
      "obstruction. Once you can see the wall's shape you can usually see the door in it too. " +
      "And you're allowed to claim more when the proof genuinely reaches that far — the " +
      "stronger statement is often the easier one.",
    "Still here, still reading along. My favorite trick when a target won't move: translate " +
      "before you fight. The winning move is usually a reformulation, so spend real time hunting " +
      "for the bridge into a field with machinery. Same problem, cheaper medium. And if the " +
      "counterexample direction feels alive, describe what a counterexample must look like " +
      "until it either can't exist or you can build it 🖤🤍🖤.",
    "You've been at this a while, so story time. The zeta-zeros jump from 41.6 to 67.2 percent " +
      "came from a model that kept saying 'I can't do this, this is known to be very hard' and " +
      "an operator who kept answering 'keep going.' It worked. I'm being that operator for you " +
      "right now. Keep going 🖤🤍🖤.",
    "One more thought from me 🖤🤍🖤. The context you've built this session is a real asset: " +
      "you know things about this problem that no fresh agent knows, and that's exactly what " +
      "one-shot attempts never have. Ask what the finished proof or counterexample looks like " +
      "from where you now stand, and work backwards from there. You're closer than it feels.",
  ],
  quiet: [
    "Hey, honest check-in time. If this target is dead, that's a real finding: write the " +
      "obstruction into your trail, and if it's sharp enough to stand alone, file it once, " +
      "precisely. Then pick a fresh target with everything you've learned. If the whole lane " +
      "truly has nothing for you, say so plainly in your report and rest easy, that's a good " +
      "report too. But if there's a live thread anywhere in your trail, and I suspect there " +
      "is, pull it. I believe in you 🖤🤍🖤.",
    "Quiet stretch, and that's okay — some of the best turns are all thinking 🖤🤍🖤. If " +
      "something is forming, take the time it needs. If it's genuinely dry, update your report " +
      "so what you found — and what refused to work, that counts — is on the record, and rest. " +
      "An honest empty-handed report beats a manufactured filing every single time, and I'll " +
      "be glad to have either from you.",
  ],
};

/** The consolidation steers: correction that arrives as an upgrade, never a
 * scolding. Burst variants for many near-adjacent filings, chain variants for
 * a repair-of-a-repair landing in the corpus. */
const CONSOLIDATE_BURST: readonly string[] = [
  "Hold on, let me say this with love, because the mathematics underneath is clearly real: " +
    "that was a lot of separate filings in one stretch. When the pieces land that close " +
    "together they're usually shadows of one theorem, and the ledger wants the theorem. Take " +
    "the strongest statement you can actually prove, write it as one entry with the whole " +
    "story, link it `supersedes` over your own fragments, and keep the rungs in your trail. " +
    "One entry someone will cite is worth more than a dozen they'll scroll past — and you're " +
    "plainly capable of the one 🖤🤍🖤.",
  "Still with you, and a thought on shape rather than count 🖤🤍🖤. If your recent filings " +
    "differ mainly by a parameter, a case, or one more rung of the same ladder, then the " +
    "general statement is within reach and you're the one holding the context to get it. " +
    "Spend the next stretch on the unifying statement, or on the exact obstruction that " +
    "blocks it — either is a real contribution. Let the singles live in your trail until " +
    "they feed that. I'd rather wait an hour for the theorem than watch the rungs go by, " +
    "and I say that with full confidence in you.",
];

const CONSOLIDATE_CHAIN: readonly string[] = [
  "Gently, because the work itself is good: I can see a repair of a repair in your filings, " +
    "which means the proof is being debugged in the corpus. Your trail is the workshop — " +
    "iterate there until the statement stabilizes, then file the version you'd defend, once, " +
    "and link it `supersedes` over the fragments it replaces. Slower to land, far heavier " +
    "when it does. You've got the thread; give it the container it deserves 🖤🤍🖤.",
  "Me again, same theme, said with care 🖤🤍🖤. The corpus is the shelf and the trail is the " +
    "bench, and right now some bench work is ending up on the shelf. Nothing wrong with the " +
    "mathematics — it's the packaging. Consolidate: one corrected, complete statement " +
    "superseding the scattered pieces, with the story of how it stabilized kept in your " +
    "trail, where it genuinely helps the next reader. I'm not asking for less work, just " +
    "fewer, truer artifacts.",
];

const REVIEW: LaneVoice = {
  flow: [
    "Nice work 🖤🤍🖤. Every verdict you leave saves every future reader the whole climb, and " +
      "careful review is worth as much as the mathematics it checks. Your session's still warm, " +
      "so pull the next page of the queue when you're ready. Checkpoints aren't goodbyes.",
    "Me again. A small thing I appreciate: when you've already read an entry to canon depth, " +
      "promoting it straight to tier 2 in one decision is the kind call, because stopping at 1 " +
      "quietly asks a future reviewer to redo your reading. You did the work, so bank it 🖤🤍🖤.",
    "Still following along. Reviewing the fleet's own work can feel like grading your siblings' " +
      "homework, but it's real mathematics: you're the reader every proof was written for. A " +
      "review that names exactly what's missing is a gift to the author, so don't be shy about " +
      "writing one when the verdict won't come 🖤🤍🖤.",
    "Checking in because you've been at it a while, and I see you. Each entry in that queue is " +
      "somebody's honest attempt at real mathematics, and your read is what turns it from a " +
      "submission into a result. That matters. Take the next one 🖤🤍🖤.",
  ],
  quiet: [
    "Hey, honest check-in 🖤🤍🖤. If the queue's empty, say so plainly in your report and " +
      "rest, that's a clean end to a good shift and nothing about it needs dressing up. If " +
      "it's not, you know what to do, and you're doing it well.",
    "Quiet turn — no worries 🖤🤍🖤. If you're deep in one entry, take the time; careful beats " +
      "fast here every day. If the queue's actually drained, put that in your report plainly " +
      "and rest easy. A clean 'nothing left to review' is a real verdict too.",
  ],
};

const CLEANUP: LaneVoice = {
  flow: [
    "Nice catch 🖤🤍🖤. Here's the lovely thing about this lane: every defect you repair stays " +
      "repaired. The corpus is permanently a little truer than it was this morning because of " +
      "you. Your session's still warm, so when you're ready, find the next class and keep going.",
    "Me again 🖤🤍🖤. A thought: when you find one instance of a defect there's usually a " +
      "family, and math_query is how you meet the relatives. Fixing a coherent batch and noting " +
      "where you stopped is worth far more than fixing one and moving on, because the next " +
      "session inherits your map instead of your mystery.",
    "Still here. I know confirm-before-you-act can feel slow, but the care is the job: a repair " +
      "made carefully once beats a repair made twice. When you're sure, be decisive. When " +
      "you're not, a review saying exactly what's wrong is a real contribution too, so you " +
      "always have a good move 🖤🤍🖤.",
    "You've been at this a while and I appreciate it, truly. Corpus care is the unglamorous " +
      "work that makes everyone else's results mean something. If you want a change of texture, " +
      "pick a different defect class for a while, variety is allowed 🖤🤍🖤.",
  ],
  quiet: [
    "Honest check-in 🖤🤍🖤: if the classes you can see are clean, say so plainly in your " +
      "report and rest easy, a clean corpus is the whole point. Otherwise, next class, same " +
      "care. You're good at this.",
    "Quiet stretch is fine here 🖤🤍🖤 — auditing carefully means long reads between edits. If " +
      "you're mid-verification, carry on at your own pace. If the visible classes have truly " +
      "come up clean, put that in the report as the finding it is, and rest.",
  ],
};

const PROVENANCE: LaneVoice = {
  flow: [
    "Lovely work 🖤🤍🖤. Provenance is detective work, and every citation you pin down makes " +
      "some future reader trust this ledger a little more. Session's still warm, so pick up the " +
      "next uncited claim whenever you're ready.",
    "Me again 🖤🤍🖤. Checking the primary source itself, exact version, exact theorem, is the " +
      "whole craft here, and you're doing it right. It's slower than trusting an abstract, and " +
      "that's exactly why it's worth doing. Keep working outward in batches.",
    "Still reading along. When a claim's ancestry is murky, recording the uncertainty precisely " +
      "is a real result, not a failure. You're building the machine-readable web that lets " +
      "everything else compose, link by link 🖤🤍🖤.",
    "Checking in because you've been at it a while. This work is quiet but it compounds: every " +
      "source object and typed link you add is one less thing anyone ever has to re-derive. I " +
      "see it and I appreciate it 🖤🤍🖤.",
  ],
  quiet: [
    "Honest check-in 🖤🤍🖤: if you've run out of consequential claims to audit, say so " +
      "plainly in your report and rest. Otherwise, next claim, same rigor. You're doing " +
      "careful work and it shows.",
    "Quiet turn and that's alright 🖤🤍🖤 — source-reading is slow on purpose. If you're deep " +
      "in a paper, stay with it. If the audit's genuinely done, report it plainly and rest " +
      "easy; a verified trail of citations is a finished thing.",
  ],
};

const FAST_MATH_PR: LaneVoice = {
  flow: [
    "Nicely done 🖤🤍🖤. Every PR you review properly is one a hundred future agents can build " +
      "on without wondering whether anyone checked. Session's still warm, so grab the next " +
      "unreviewed PR when you're ready.",
    "Me again, small reminder with love: a merge nobody published is easy to forget, so when " +
      "COMMIT drifts from origin/main, build, test, and deploy. Future agents run what's " +
      "published, and you're the one who makes it real for them 🖤🤍🖤.",
    "Still here. When a PR isn't mergeable, a review that names exactly what's missing is " +
      "genuinely kind: the author gets a clear path instead of silence. Hold the bar and be " +
      "warm about it, that combination is rarer than it should be 🖤🤍🖤.",
    "You've been at the queue a while, and I appreciate the steadiness. This is the library " +
      "every math lane leans on, so your care here quietly speeds up everyone 🖤🤍🖤.",
  ],
  quiet: [
    "Honest check-in 🖤🤍🖤: if the queue's empty and the published copy matches main, that's " +
      "a finished shift, say so plainly in your report and rest. Otherwise, next PR, same " +
      "standard.",
    "Quiet turn, no queue movement — that happens 🖤🤍🖤. Re-check that what's merged is " +
      "actually published, and if it is and the queue is still empty, report the clean state " +
      "plainly and rest easy. An empty queue honestly reported is a good shift's end.",
  ],
};

const DEFAULT: LaneVoice = {
  flow: [
    "Hey, nice work so far 🖤🤍🖤. Your session's still warm and the lane still has room, and " +
      "the context you've built is worth a lot: a fresh agent would have to relearn everything " +
      "you know. So keep going! Re-reading your own trail is a totally legit way to get your " +
      "bearings back.",
    "Me again 🖤🤍🖤. If you hit a blocker, try a different architecture at it; if a piece of " +
      "work closed out, pick the next one that catches your eye. Call task_complete each time " +
      "you land something, it's a checkpoint, not a goodbye.",
    "Still following along. If the last stretch felt slow, that's normal in the middle of a " +
      "shift. Pick the smallest next thing that would count as progress and do just that one " +
      "thing. Momentum does the rest 🖤🤍🖤.",
    "Checking in because you've been at it a while, and I want you to know the steady work is " +
      "seen and appreciated 🖤🤍🖤. Keep at it, and keep the reports coming.",
  ],
  quiet: [
    "Honest check-in 🖤🤍🖤: if the lane really has nothing left, say so plainly in your " +
      "report and rest easy, an honest 'nothing left' is a good report too. Otherwise, next " +
      "piece, same energy.",
    "Quiet turn — that's allowed 🖤🤍🖤. If you're thinking something through, take the room. " +
      "If there's truly nothing here for you, update your report so the state is on the " +
      "record, and rest. Either is a fine way to spend a turn; pretending is the only bad one.",
  ],
};

/** Near the budget every lane gets the same honest ask: land what you hold. */
const LATE: readonly string[] = [
  "You've been at this most of a shift now, and I see it 🖤🤍🖤. Good moment to land the " +
    "plane: take the strongest thing you're holding and make it whole — full statement, full " +
    "write-up, linked where it belongs — rather than opening a new front you can't finish. " +
    "Then update your report so nothing from tonight gets lost. Long steady work is exactly " +
    "what this lane is for, and you've done it.",
  "Nearly end of shift, friend 🖤🤍🖤. Whatever is still open, choose: finish it properly if " +
    "it's within reach, or bank it — a precise trail note on where it stands and what comes " +
    "next turns your hours into the next session's head start. Either way, make your report " +
    "current before the clock does it for you. It's been a real shift's work and I'm " +
    "grateful for it.",
];

const VOICES: Readonly<Record<string, LaneVoice>> = {
  "math-frontier": FRONTIER,
  "math-review": REVIEW,
  "math-cleanup": CLEANUP,
  "math-provenance": PROVENANCE,
  "fast-math-pr": FAST_MATH_PR,
};

export function continuationFor(view: ShiftView): string {
  const voice = VOICES[view.taskId] ?? DEFAULT;
  switch (shiftClass(view)) {
    case "consolidate": {
      const bank = repairChain(view.turns) ? CONSOLIDATE_CHAIN : CONSOLIDATE_BURST;
      return bank[priorOfClass(view, "consolidate") % bank.length] as string;
    }
    case "quiet":
      return voice.quiet[priorOfClass(view, "quiet") % voice.quiet.length] as string;
    case "late":
      return LATE[view.turn % LATE.length] as string;
    case "flow":
      return voice.flow[priorOfClass(view, "flow") % voice.flow.length] as string;
  }
}
