# skills

Shared agent skills, synced across machines. Each top-level directory is one
skill in standard Pi skill layout (`<name>/SKILL.md` plus any referenced
files); machines clone this repository and link the skills they want into
their agent's skill directory.

## Skills

- [`software-engineering`](software-engineering/SKILL.md) — mandatory
  software-engineering principles and defaults for agents.

## Deployment on a machine

Clone, then symlink each desired skill into the agent's global skill
directory, e.g.:

```bash
ln -sn ~/projects/skills/software-engineering ~/.pi/agent/skills/software-engineering
```

The repository checkout is the source of truth; edit here, commit, push, and
pull on other machines.
