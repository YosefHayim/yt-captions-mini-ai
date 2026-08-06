# Skill authoring reference (shared)

Use this when converting a YouTube transcript into one or more installable agent skills.

## Canonical open standard

Most modern coding agents use the **Agent Skills** layout:

```text
<skill-name>/
  SKILL.md          # required
  scripts/          # optional
  references/       # optional
  assets/           # optional
```

`SKILL.md` = YAML frontmatter + markdown body.

### Required frontmatter (portable)

```yaml
---
name: skill-name
description: >
  What the skill does and WHEN to use it (trigger phrases).
  Max ~1024 chars. Specific beats vague.
---
```

Rules for `name`:

- lowercase letters, digits, hyphens only
- 2–64 characters
- no leading/trailing hyphen

Rules for `description`:

- state **what** it does
- state **when** to invoke it (user phrases, slash command)
- this field is the auto-trigger signal for most agents

### Body best practices

1. Open with a one-line purpose.
2. Add **When to use** / **When not to use**.
3. Give a numbered procedure the agent can follow.
4. Include examples, constraints, and failure modes.
5. Keep the body concise and actionable (prefer under ~500 lines).
6. Point to `references/` for long material instead of pasting walls of text.
7. Prefer existing CLIs/tools over inventing scripts unless scripts are necessary.

### Progressive disclosure

- Load only `SKILL.md` first.
- Load `references/*` only when the task needs them.
- Run `scripts/*` only when the workflow requires them.

## Official sources by agent

| Agent | Official / primary docs | Typical install path |
| --- | --- | --- |
| Claude Code | https://code.claude.com/docs/en/skills | `~/.claude/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md` |
| Open standard | https://agentskills.io/specification | Portable `SKILL.md` |
| Codex | https://github.com/openai/codex/blob/main/docs/skills.md | `~/.codex/skills/<name>/SKILL.md` or `.codex/skills/<name>/SKILL.md` |
| Grok Build | Grok `create-skill` skill + this file | `~/.grok/skills/<name>/SKILL.md` or `.grok/skills/<name>/SKILL.md` |
| Gemini CLI | Project/agent instruction docs + portable SKILL.md | Prefer portable Agent Skills layout |
| Cursor / agent | Project rules + portable SKILL.md | Prefer portable Agent Skills layout |
| Devin / Kiro / Kimi | Product skill docs if available; else this file | Prefer portable Agent Skills layout |

When a product-specific field is not documented, stay on the portable `name` + `description` frontmatter so the skill remains cross-agent.

## Multi-skill packages

If a transcript covers several distinct workflows, emit **multiple** skills (separate directories), not one bloated skill. Split when:

- triggers differ
- procedures differ
- audiences differ

Keep each skill single-purpose.
