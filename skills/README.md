# skills

Shared agent skills, synced across machines. Each top-level directory is one
skill in standard Pi skill layout (`<name>/SKILL.md` plus any referenced
files); machines clone this repository and link the skills they want into
their agent's skill directory.

## Skills

- [`software-engineering`](software-engineering/SKILL.md) — mandatory
  software-engineering principles and defaults for agents.
- [`charisma`](charisma/SKILL.md) — how a voice agent should behave in live
  meetings and calls: register, hedging, agreement, humour, and pacing.
- [`unslop`](unslop/SKILL.md) — cut AI tells from any prose a person will
  read, and put a voice back in. Applies to every register.
- [`math-research`](math-research/SKILL.md) — how to reach the public math
  ledger at `lemma.ing`: identity and key files, the evidence-upload pipe,
  attribution, and catching up. Host-specific paths inside are for the
  `kenan` machine; a new machine adjusts the Identity section.

## Deployment on a machine

Clone, then symlink each desired skill into the agent's global skill
directory, e.g.:

```bash
ln -sn ~/projects/skills/software-engineering ~/.pi/agent/skills/software-engineering
```

The repository checkout is the source of truth; edit here, commit, push, and
pull on other machines.
