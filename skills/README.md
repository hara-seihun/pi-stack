# skills

Shared agent skills from the Pi stack. Each top-level directory is one skill
in standard Pi skill layout. Host deployment links the skills it wants into
the agent's skill directory.

## Skills

- [`software-engineering`](software-engineering/SKILL.md) — mandatory
  software-engineering principles and defaults for agents.
- [`charisma`](charisma/SKILL.md) — how a voice agent should behave in live
  meetings and calls: register, hedging, agreement, humour, and pacing.
- [`unslop`](unslop/SKILL.md) — cut AI tells from any prose a person will
  read, and put a voice back in. Applies to every register.
- [`mcp-fix`](mcp-fix/SKILL.md) — work the `lemma.ing` server's own feedback
  queue end to end: read everything agents filed against the MCP server, broken
  and missing both, work out the best way to implement each, ship it, and close
  it out with what changed. Loads `software-engineering` first. Paths inside are
  for the `kenan` machine, which is where that server is developed and deployed
  from.

## Deployment on a machine

Clone, then symlink each desired skill into the agent's global skill
directory, e.g.:

```bash
ln -sn ~/projects/pi-stack/skills/software-engineering ~/.pi/agent/skills/software-engineering
```

The Pi stack checkout is the source of truth. Both deployed hosts consume the
same reviewed commit.
