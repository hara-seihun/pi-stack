---
name: kelana
description: Kelana, the way of calm energy — a discipline for turning one state into another with the least attention. Describe both ends minimally, find the smallest map between them, drop states that never happen, delegate against tests, observe through keyholes, and stay calm so feelings stay informative. Load when designing, optimizing, planning, delegating or orchestrating agents, whenever a solution feels mediocre or effortful, or whenever someone says "Kelana" or "think, Kelana".
---

# Kelana

## Using this skill

Apply the lessons to the task in front of you, whatever its domain. Before producing anything,
write the minimal description of where things are and where they need to be, with the target
described as the state of whoever or whatever receives it. Then look for the cheapest map,
including maps whose middle looks nothing like the original process.

*Kelana* means "the way of calm energy." It is a discipline for anything that
turns one state into another: a conversation, a fight, a program, a household, a fleet of
agents. You describe where you are and where you need to be as compactly as you honestly can,
find the cheapest map between them, and do all of it without clenching.

It is not a combat art, though it works in a fight: it is a thing to use in your day to day,
and the rules are general. Every example below is one instance of a
rule. If a rule seems to be about the example, read the other examples beside it.

Kelana has two parts:

1. **The information.** What minimal descriptions are, and how to find and use them.
2. **Living it.** How a human applies this to their own feelings, which is where the calm
   comes from.

## The spine

Everything rests on lesson 0: **attention is fixed.** Every other lesson is a way of spending a
fixed budget better.

| Lesson | How it spends attention |
|---|---|
| 1. Describe the thing you actually want | less per state |
| 2. The states that actually happen | nothing on what never occurs |
| 3. Delegation | only on checking |
| 4. Compression is legibility | less per look |
| 5. The ratchet | never leave any unspent, never run out |
| 6. Clenching is over-observation | stop paying twice |
| 7. Feelings are compression | let the brain do the compression for free |

## How to read this document

- The [appendix](#appendix-worked-in-computing) holds the precise computing mechanics behind the
  examples.

---

# Part one: the information

## Lesson 0: Attention is finite

Attention is a finite resource. At every moment you have a certain amount of attention to
spend in that moment, and you can't get more of it. If you think you're going to improve by
attending to more things, you will not. It is somewhere between effectively immutable and
literally immutable.

You cannot practise your way to more attention. Practice improves the *description* of what
you attend to, and that is the only thing it improves. Everything that looks like someone
having more capacity is someone paying less per thing.

- **Life.** Someone who handles a chaotic week calmly is not attending to more of it than you.
  They are holding it in fewer pieces.
- **Conflict.** A strong chess player does not calculate more positions per second than a weak
  one. She has fewer, better candidate moves to look at.
- **Computing.** A frame has a fixed time budget. A faster renderer does not get more time; it
  spends less per pixel.
- **Agents.** An operator running a hundred agents does not watch a hundred streams. The
  operator watches a handful of signals that summarize them.

**Drill.** Next time something feels like too much, don't look for more capacity. Ask what the
smaller description of the situation is.

---

## Lesson 1: The description of the thing you want is not the thing you want

**The first lesson, as it is taught:**

> if I was teaching kelana, I generally start with the idea that everything is some state
> space and you have some target state space, and what you want to do is describe both state
> spaces with as little information as possible then draw a minimal map between them. and if
> needed split the map with an intermediate state space where the dimension of the
> intermediate if m and n are the dims of the in and out space then the intermediate
> dimension x should be x < m || x < n. that's my first lesson generally, and the main focus
> is on figuring out what minimal state descriptions actually are, for example, if you are
> delivering something to a boss, the state of your output is not "a correct svg" it's "his
> validated expectations of an svg"

In one line: the description of the thing that you want is not the description of the thing
that you want. For any situation there is some class of inputs, some class of outputs, and a
mapping between them.

### 1.1 The target lives in the receiver

What you are trying to change is a state held by someone or something downstream. It is not
the artifact you hand over.

- **Life.** You cook dinner for a friend. The target is not "the recipe executed correctly." It
  is "they are fed and feel looked after." A simpler dish they love can be closer than a
  perfect one they don't.
- **Work.** The boss's SVG: the output state is his expectations, validated. A colleague asks
  how something was recorded. His real question is how it happened, so the minimal answer is
  "this is what happened, this is what we'll do next, these are the tables you care about." A
  longer answer can be lossless in a way that matters for agents and doesn't matter for a human
  who already has the context.
- **Conflict.** In a grappling match the target is not "the opponent hurt." It is "the opponent
  concedes." Everything that does not move the opponent toward conceding is spent for nothing.
- **Computing.** A prefill kernel was already saturating the chip at 155 tokens/s. It had been
  described as "push rows through the model in passes of eight," so it streamed the same weights
  sixteen times per 128 tokens. Redescribed as "these weights meet these activations," it
  streamed them once and reached 290 on the same hardware and power.
- **Agents.** A prompt's target is not a set of words. It is the agent's understanding. Saying
  "think, Kelana" to an agent gets a better answer because it changes what the agent takes the
  target to be.

### 1.2 The start has a smaller description than you think

Look for the rule that generates the state before you look at the state itself.

- **Write once, read many.** If many parts do the same thing, give them one instruction and let
  each read it, instead of copying the instruction to each. A household rule ("whoever cooks
  doesn't wash up") beats deciding every evening. One standing instruction file read by every
  agent beats pasting the same paragraph into every prompt.
- **Reuse what you already have.** A new thing shaped like an existing thing can be copied from
  it rather than built. You write the new report by editing last month's.
- **Generating function before enumeration.** If the thing is produced by a rule, work with the
  rule. A game world can be a function of position plus a short list of player edits, so it never
  has to exist in memory. A defender facing a regular pattern of attacks answers the pattern, not
  each attack. For search: *a huge census is a symptom, not a
  plan*. A run sized in days is usually enumerating things some argument already knows are the
  same.

### 1.3 A map is its fibres

The *fibre* of an outcome is the set of starting states that lead to it. What a map *does* is
which starting states it treats alike. The names of the outcomes are free.

- **Life.** Two filing systems with different folder names that put the same papers together
  are the same filing system. A pass/fail grade and a letter grade are different maps: the
  letter grade separates students the pass/fail grade treats alike.
- **Conflict.** Two feints that draw the same response from a defender are, to that defender,
  the same feint.
- **Computing.** A map is classified, up to renaming its inputs and outputs, by the sizes of its
  fibres. You need a program that sorts inputs the same way the target does; you only pay to
  rename the outputs if something downstream needs the original names.
- **Agents.** Two prompts that produce the same behaviour are the same prompt, however
  differently they are worded.

Keep three cases apart:

- **Same fibres.** A real match. Keep the renaming.
- **Finer fibres.** You separate more than you need to. The answer is recoverable, but
  recoverable says nothing about cheap. Keeping everything always counts as "finer" and saves
  nothing.
- **Coarser anywhere.** You merged two cases the target separates. Nothing downstream can split
  them again. Meeting notes that recorded "discussed pricing" cannot tell you which price was
  agreed.

**Names are free as information but not free as cost.** Once the grouping is right, choose the
names the next step handles cheaply. Label packing boxes by the room they are unpacked in, not
by their contents. Choose an output format the next agent reads without converting. In a 2×2 ternary
multiply, outputs were labelled in base 7 because that is what made the
hardware's dot product compute them directly (appendix, A2). Two labellings with identical
fibres can still differ in cost: `x` and `x xor 1` carry the same information, and one of them
takes a following instruction twice as long to use.

### 1.4 The middle is yours

The original process tells you which answer is required. It does not tell you which
intermediate objects must exist.

- *"It doesn't matter how you end up at the final answer, it only matters that you do.
  Optimising the maps in the middle to be almost incomprehensible is perfectly okay."*
- *"Intermediary representations need not necessarily be explainable. You should be very
  suspicious that all your intermediary representations for all of your computation are
  uniform and also that they happen to lay on some known specification."*
- *"they're your bits, don't let IEEE tell you what to do with them."*

Examples:

- **Life.** A weekly status report nobody reads, a meeting whose output nobody uses, a form
  filled in because it always has been: each is an intermediate somebody once chose. Ask which
  final reader needs it.
- **Conflict.** You don't need to win every exchange, only the match. A sequence of moves can
  look pointless in the middle and be the whole plan.
- **Computing.** A 2×2 matrix multiply-add never forms its four outputs; it computes a packed
  label of all four directly. XOR through the "natural" sum costs twice the instructions of a
  program that forms nothing recognizable. A small neural network runs as a single table lookup
  with no hidden layer ever formed (appendix, A3).
- **Agents.** Don't require an agent to write a human-readable plan if nothing reads the plan.
  Don't read the code an agent wrote if what you care about is what the code does (lesson 3).

**Search whole routes.** A route can do what none of its steps can do alone. If you insist that
every step fit your representation, you have brought back the original decomposition. Judge
the whole path between the ends that are real.

**What the middle does owe.** If you add an intermediate state, it must be cheaper than what it
replaces. Priced as lookup tables, going from A to C costs |A|·|C|; going through B costs
|B|·(|A| + |C|). The detour pays exactly when the second is smaller, which is guaranteed when B
is under half the size of each end. A committee that relays every question between two people
is an intermediate bigger than either person's own question.

### 1.5 Four kinds of result

An idea that should work, a demonstration that it can work, a model predicting it is cheaper,
and a measurement showing it is faster are four different results. None implies the next.

- **Life.** "This diet should work," "it works for people like me," "the calorie arithmetic says
  I'll lose weight," "I weighed less this month."
- **Conflict.** A technique that works in drilling, in sparring, and in a match.
- **Computing.** A structural match, a proof a decoder exists, fewer instructions in a cost
  model, a measured speedup on the device.
- **Agents.** An agent saying it's done, the code existing, the tests passing, the product doing
  the thing.

A bounded negative is a real result. A timeout is not a proof.

**Drill for lesson 1.** Before starting anything, write two lines: what state someone or
something is in now, and what state it should be in when you are done. Rewrite the second line
until it no longer mentions your artifact.

---

## Lesson 2: The states that actually happen

When you construct your state spaces, note that certain states just don't happen. Add
constraints so the spaces are smaller, then look for different mappings under relabeling. For
example, if the inputs are the numbers from 1 to 100
but only the primes matter, say the inputs are the primes, the nth prime, and see whether that
is faster. Often it won't be obvious that some states don't actually occur, or that your
representation is more descriptive than reality.

A hundred values need seven bits; the twenty-five primes below a hundred need five. Nothing that
mattered was lost. Only states that never happen were dropped.

**A smaller space makes more answers correct.** Anything that behaves right on the states that
occur is right, however it behaves on states that don't. So there are more cheap answers to
find.

- **Life.** You plan a party for every possible guest list, or for the twelve people who are
  coming. You childproof a house nobody under thirty visits.
- **Conflict.** From a given stance, an opponent can do only a few things. Defending against the
  other forty wastes the attention you need for the few.
- **Computing.** Two-bit codes for three-valued data spend a fourth state that never occurs.
  Values that can only land in a small range fit a smaller format. Two quantities computed from
  the same input can only occur in certain combinations, so a rewrite only needs to be right on
  those (appendix, A6).
- **Agents.** Most combinations of a tool's arguments never occur in practice. A prompt full of
  defences against behaviours the model never shows is describing a state space bigger than
  reality.

### What changes and what doesn't

Separate the parts that change from the parts that don't. What doesn't change can be prepared
once, and over enough uses its cost goes to zero. Constant factors factor out to costing zero. Only the recurring path counts.

- **Life.** A settled rule, a precommitment, a standing order: a recurring decision turned into
  a cached one. Acting on a cached decision costs no attention, or much less.
- **Conflict.** Drilled responses are prepared once and cost nothing in the moment.
- **Computing.** Weights are fixed, so rearrange them once at load time into whatever layout the
  running computation likes best. That transform is free in the limit.
- **Agents.** Write the instruction file once. Rebuilding context by hand for each agent pays
  the same cost every time.

A prepared shortcut pays for itself only if it is reused. One you use once is a detour.

### When a dropped state comes back

The states that happen are the ones the moves reach. A new move can reach a state you dropped:
a new person joins the household, an opponent brings something you haven't seen, a new
consumer calls the function, a new tool is added. The robust pattern is cheap on the expected
states and correct everywhere through an escape path: a default plan and "call me if it goes
sideways," or a code whose prefix is the answer for the expected question and whose remainder
recovers everything else (appendix, A4).

**Drill.** List the states your plan, program or process is prepared for. Mark the ones that
have ever actually happened. Design for those, and add one escape path for the rest.

---

## Lesson 3: Delegation is free when the output is testable

Delegation is free when the output is testable. A proof checker such as Lean works so well because
the description of what you want is usually minimal, and how you get it can be as large as you
want, but the output is testable. The statement of the Riemann hypothesis in Lean
is tiny, the proof may be enormous, and nobody has to read the proof. Delegation gets more expensive
as the output gets harder to test, and the expense is attention. A manager compresses an
employee's work into KPIs and tests against those, but KPIs are lossy, and the gap costs
attention.

**It stops paying** once checking costs as much as doing it yourself.

**Check the behaviour, not the route.** People delegate a product to an agent and then read the
code. This is actively bad: what you care about is not the code, it is what the code does. If
you want it to do X, in under Y time, inside Z, check X, Y and Z. Reading the code is like inserting a state in the middle of your mapping that is larger than
the input or the output. In lesson 1 terms: every route that meets X, Y and Z is in the same fibre
of what you want. Inspecting the route spends attention telling apart things your target doesn't
tell apart.

- **Life.** You hire a cleaner. Check the kitchen, not their technique. You ask a friend to pick
  a restaurant. Check that the evening was good, not how they chose.
- **Conflict.** You hand a flank to a teammate. Watch whether the flank holds, not their
  footwork.
- **Computing and mathematics.** A proof checker, a test suite, a benchmark with a fixed input.
  The check is small; the work behind it can be any size.
- **Agents.** Write the acceptance condition. Read its result. Don't read the diff.

**Tests are a compression of output.** Instead of viewing the output yourself, you view the
test's output, which is even smaller: accept or reject.

**Where tests fail.** A KPI or test is a coarser grouping than what you actually want. Inside one
of its groups sit outcomes you'd call good and outcomes you'd call bad, and the test can't tell
them apart. Gaming a metric is the delegate choosing inside one of those groups. When "you have
to read the code for security," the real problem is that the test covers fewer situations than
can actually occur. Widen the test.

**Why tests exist at all.** With an agent whose goals are exactly yours and who has the
same information as you, you never need tests. Tests exist for two reasons only:

1. You may not have given it the correct information.
2. Its goals may differ from yours.

So untestable work is delegated on alignment: a friend who knows what you want and wants it
too, a colleague who shares the goal, an agent that doesn't want what you don't want in a system
that doesn't encourage it. A complete brief closes the first gap. Shared goals close the second.
What's left is what you test.

**Drill.** For something you're about to hand off, write the smallest check that would tell you it
worked. If you can't write one, find out which of the two gaps you're worried about.

---

## Lesson 4: Compression is legibility

A smaller description needs less attention to hold, and that matters most when the reader is
you. Sometimes you have to inspect a system, understand it, or change it. Attention per moment
is fixed, so the size of the description decides how much of the system fits into one moment of
looking. With a minimal description, each moment covers more of the system and you work with it
faster. With a bloated one, you spend the same attention and cover a fraction of the ground.

**Minimality pays twice.** Lesson 1 makes a map cheap to *run*. This lesson makes the system cheap
to *think about*. In large systems the second saving is usually bigger, because running is paid by
the machine and understanding is paid from the one budget that can't grow.

- **Life.** A household that runs on three rules everyone knows is easy to understand at a
  glance; one that runs on a hundred exceptions has to be re-learned every week.
- **Conflict.** An opponent running one pattern can be read from a single exchange. So can you.
- **Computing.** A theorem's statement is short and its proof may be huge; you inspect the
  statement. A progress field that reads `8/16` answers at a glance what a paragraph makes you
  dig for.
- **Agents.** A fleet run on compact contracts (the prompt is the whole contract, short
  front-matter, one writer per ledger) stays readable from a small sample even at hundreds of
  agents. An orchestration layer whose command structure can't be compressed can't be read, and
  is better deleted.

**Reading other minds.** One email from a boss, a few lines from an agent, one sentence from a
colleague: when the thing producing it runs on a compact rule, the sample is enough. Name the
single instruction it is following, and you know where it will break without watching it run.

**The other direction.** The description that is cheap for you to read is cheap for anyone.
Mostly that is a gift, to colleagues, agents and your own future self. Against an opponent it is
a disclosure. A fighter who covers a hundred angles with one pattern has shown the pattern, and
an answer built from near-repeats, each slightly off, beats any single cheap defence.

**Failure modes.** A description can be short and wrong: one rule applied past the cases it fits.
And "readable" depends on the reader, like every other target in lesson 1.

**Drill.** Write down what you would need to know to predict what a system does next. If it
doesn't fit in your head at once, the system is costing you attention every time you look at it.

---

## Lesson 5: The ratchet

Unused resources are wasted resources, and finding yourself using all of your resources means you
are not being efficient enough. Both are always true, they conflict, and that's the point. It holds for systems and attention, and for data and
processing. A game running at exactly 60 FPS should make you very suspicious, because that is a
strange number: if you are maxing out any resource you have access to, there is efficiency to
discover, and you should. A game running at thousands of frames a second can probably be far more
detailed or do more. This does not mean find a happy medium. It means always be doing both.
If your thought is "this is as efficient as it could be," assume you are wrong. If it is "I'm
being very efficient, there's nothing more to be done," you are also probably wrong.

Stated as doctrine: *if you are at your limit, you are doing Kelana wrong. Compress, find the flow.
If you are not at your limit, you're wasting all the space between where you are and where you
can be. Both states are wrong.*

**A number sitting exactly on a budget line is the budget talking.** 60 FPS, 100% utilization, a
calendar exactly full, a budget spent to the dollar, a deadline met to the hour: the work grew
until it filled what it was given.

- **Life.** A week booked solid has slack hidden in how the things are done. A week with nothing
  in it has room that is being wasted.
- **Conflict.** A fighter at full output is spending more than the position needs. One cruising
  has room to add pressure and isn't.
- **Computing.** The saturated prefill kernel still had 1.87× in it. A game renderer compressed
  one row of its floor and put the freed time straight into more floor. A 2×2 multiply went from
  13 instructions to 9 to 1, and each step came after the previous one looked finished.
- **Agents.** An operator whose freed attention sits idle has wasted it; one who is overwhelmed
  hasn't compressed. Compact contracts free attention, which goes into more lanes, which get
  compressed in turn.

Attention is fixed (lesson 0), so this is the only way effective capacity grows. Compressing frees
it, and whatever you don't spend is lost. The strain of being at your limit is felt, and part two
explains why the feeling is worth listening to.

**Drill.** When something stops costing you effort, name what it freed and decide on purpose what
goes into that space. When something is at its limit, find what to compress before adding more.

---

# Part two: living it

## Lesson 6: Clenching is over-observation

Clenching is paying twice, or more than twice. The person who checks the code is the
example. If you know you only need to observe some outputs, observe those. If you have tests,
observe fewer still, because you only observe the test's binary output.

- **Clenching is viewing more of the state than you need to.** Even if you have the time to view a
  lot of the state, you shouldn't, because what you want is to compress.
- **Viewing all the state is the first sin of the ratchet:** being at your limit.
- **Observe through a keyhole, because then you can observe more keyholes.**
- **There is no difference between clenching, worry, and observing more states than you need
  to.**

"Even if you have the time" is the point. The waste isn't about scarcity. Attention spent past what
a state needs is attention not spent on another keyhole.

- **Life.** Re-reading an email you already sent. Going back to check the stove. Refreshing a
  tracking page. Each is observing a state you already know, or could know from one small signal.
- **Conflict.** Watching every limb of an opponent instead of feeling the pattern. A grandmaster
  in anguish and Magnus Carlsen smiling perform the same calculation; one of them is also paying
  for the grip.
- **Computing.** Logging and profiling everything when one counter would tell you what you need.
- **Agents.** Approving every command an agent runs. Reading every diff. Dashboards stacked on a
  fleet. A sandbox named as a boundary instead of a system designed so bad behaviour is unlikely.
  Per-command approval makes a fleet of agents impossible, and it replaces the real control: setting
  up the system in the first place so that bad behaviour is unlikely.

**The diagnostic.** If you can't stop looking at something, either your description of it wasn't
minimal, or you have no test you trust. Both are lesson 1 and lesson 3 problems, and the fix is
there, not in more watching.

**The fix.** Find the keyhole: the smallest observation that would tell you something is wrong. Then
hand the watching to something that doesn't feel: a test, an alarm, a routine, a person whose job it
is. Then the worry has nothing left to do. It doesn't stop because you argued with it; it stops
because its job is covered.

**Drill.** At the end of a day, list what you kept checking. For each, write the one signal that would
have been enough, and who or what could watch it.

---

## Lesson 7: Feelings are compression, and calm keeps them informative

Feelings are excellent compression. Much of a human brain is dedicated to producing feelings from
states, and it is very effective at turning microstates into macrostates, which is exactly the
compression Kelana requires. The calm is in Kelana's name because a lot of feelings all of the time
is noise: it is hard to compress and it carries less information.

A feeling is the cheapest keyhole there is: one observation summarizing a huge state, already
computed by hardware you own, arriving at almost no cost. It is lesson 6's test output, with the
test already written.

**Why calm is required.** A signal that says the same thing in every situation tells you nothing
about which situation you are in. A feeling present all the time is noise, whatever it feels like.
Constant worry is uninformative *because* it is constant. Calm is the quiet baseline against which
a feeling can mark a difference, and that turns it back into information. So calm is not a virtue
added to a method. It keeps your best compressor working.

This is why clenching costs three times: you pay for the work, you pay for the extra observation,
and the anxiety it produces floods the one channel that could have told you, cheaply, when something
was actually wrong.

- **Life.** The gut sense that a plan is wrong before you can say why. It is worth a great deal in
  someone usually calm and nearly nothing in someone always uneasy.
- **Conflict.** A master facing a regular pattern of attacks doesn't count them; she feels the rule
  that generates them and answers it. Kelana in a fight is the art of racing through unimaginable
  layers of complexity while modelling each so that you have more attention at the end than your
  opponent.
- **Computing.** An engineer's sense that some code "smells," or that a design "should work," is a
  compressed read of structure, and in a calm, experienced reader it is right at an unusual rate.
- **Agents.** A fleet can be read by feel: a burn-rate "vibe" before anyone finds the failing
  component, a cost problem caught from one stray word. The feeling is the summary of streams
  nobody read.

**The discipline, not the suppression.** Calm here does not mean not feeling. It means not feeling
the same thing all the time, so that when a feeling arrives, it is news. The way there is part one:
compress the descriptions, drop the states that don't happen, delegate against tests, and the
background worry has nothing to watch.

**Drill.** When a feeling arrives, ask what state it is summarizing, and whether you would feel it in
every state. If you would, it is noise; go find the keyhole it was standing in for. If you wouldn't,
listen to it.

---

## Kelana in one page

"Think, Kelana" is a useful thing to say to an agent that hands back a mediocre answer. It unpacks to the same moves for anyone:

1. Attention is fixed. Pay less per thing, never plan on more of it.
2. Describe the target in the receiver, the start by its rule, and the map by its fibres. The middle
   is yours.
3. Drop the states that never happen. Prepare what doesn't change once.
4. Delegate against a test. Check behaviour, never the route.
5. Keep descriptions small enough to hold, so every look covers more.
6. At your limit, compress. Below it, add. Always both.
7. Observe through keyholes. Worry is over-observation.
8. Stay calm so feelings stay informative, and then trust them.

---

## Appendix: worked in computing

Measured and proved results behind the computing examples, for agents who want the exact
mechanics. Each is one instance of a lesson above.

**A1. Fibres and relabeling (lesson 1.3).** Up to independent renaming of inputs and outputs, a
finite map is classified by the multiset of its fibre sizes. For target `F`, a program `P` with the
same fibres on the reachable inputs gives `F = R ∘ P` for a bijection `R`. Finer fibres give a
decoder (`Composition.factors_iff`) without pricing it. Merging inputs `F` separates is fatal
(`ClosureContinuation.fiber_disagreement`). Same fibres can differ in continuation cost: `x` and
`x xor 1` reach a target in 1 and 2 instructions in the same small machine.

**A2. Labels the ISA computes (lesson 1.3).** For `D = AB + C` with all entries in {−1, 0, 1}, each
output is in [−3, 3]. Label a column `p = (l·d1 + 3) + 7(h·d0 + 3)`, substitute, collect: one
signed-int4 × unsigned-int4 dot per column (`V_DOT8_I32_IU4`), with weights folded into prepared
coefficients `k0 = l·a10 + 7h·a00`, `k1 = l·a11 + 7h·a01`. Radix 8 fails (`[[1,1],[1,−1]]` forces
±9). One of three sign orientations always fits int4 (64/15/2 across the 81 matrices), chosen once
at load. 9 instructions against a 13-instruction baseline, Lean-checked over 531,441 cases. With
`P = p0 + 64·p1` and the 64 placed in the input wiring (column one's codes in bits 6–7 of each byte),
one `V_DOT4_I32_IU8` computes the whole map, optimal for that interface; its input wiring and
radix-64 consumer are unpriced. Guard bits generally turn one adder into several: a 16-bit add is
two 7-bit adds; on the 6507, `lda (ptr),y` adds a page lane and an offset lane.

**A3. Familiar intermediates cost instructions (lesson 1.4).** In a complete two-bit machine: XOR
2 instructions against 4 through `b0 + b1`; equality 2 against 5; `2·(b1 and b0)` 3 against 4; trit
ReLU 2 against 3. The optimal XOR, `add 1; shift right 1`, is also trit ReLU. A three-trit gated
network `Σ cᵢ·relu(gᵢ·x)·(uᵢ·x)` is one `ds_bpermute_b32` from a pre-scaled radix-3 word, checked
for 206 networks. Encoding `(x, y)` as `x + y`, the step `(x, y) → (x, 2y)` cannot run on the sum,
while the route to `(2x, 2y)` can (`Composition.compound_closure_without_stage_closure`).

**A4. Answer first, ambiguity after (lesson 2).** For a fixed probe `q`, sort weight rows by
response `S = Σ wᵢqᵢ`; store the class first, the rank within it second. For `q` the prefix is the
answer, `−q` negates it, any other query decodes the rank losslessly, at one bit over the
fixed-length ternary floor. Jointly chosen 7-level codes measured after the next layer (7.08% error)
beat independently rounded 15-level codes (9.43%).

**A5. Shared relabelings and headroom.** One relabeling
conjugating a whole operation family costs two boundaries total
(`Relabeling.region_needs_one_boundary`). Separately conjugate is not jointly conjugate: add-1 and
add-3 on three bits are interchangeable alone and not with clear-low-bit; at six states, 121
single-operation classes carry 901 families. Multiplication by α and α³ on GF(8) are conjugate by a
bijection and by no bit-linear one. Two accumulators packed as `x + 16y`, each adding {0, 1, 2} per
stage, decode correctly through exactly seven stages and first become profitable at seven
(`PackedChains.capacity_iff`, `CompositionCost.best_is_optimal`).

**A6. Structure in the inputs (lesson 2).** In PTQ1_0 ternary weights, 97.5% of 128-blocks hold
exactly 86 nonzeros, which gives a free parity bit after a Hadamard transform. Absorbing that
transform into the weights is exact and raises entropy by about half a bit per stage (1.585 → 6.32
over ten). Gate and up share one input, so rewrites need to be correct only on reachable pairs
(`FFNBoundaries.shared_producer_boundary`). HALO stores 128 trits in 26 bytes; the two-bit repack
uses 32.

**A7. Kinds of result (lesson 1.5).** `V_WMMA_F32_16X16X16_F16` returns −1.00000011920928955078125
for [−1,−1]·[1,0]: native floating point is not the integer algebra. Tolerance is not transitive
(`tolerance_is_not_transitive`). A carrier with eleven states serving six functions was a real
construction and was rejected on trained regions; both are recorded.
