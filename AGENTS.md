# yt-captions-mini-ai — agent instructions

Small [Node.js](https://nodejs.org/en) / [TypeScript](https://www.typescriptlang.org/) CLI: download public [YouTube](https://www.youtube.com/) captions (video, playlist, channel Videos, or channel Shorts), optionally convert transcripts into portable [`SKILL.md`](https://agentskills.io/specification) packages via a local coding agent.

Human landing page: [README.md](README.md). Visual: [assets/hero.png](assets/hero.png).

## Source of truth

| Concern | Canonical file |
| --- | --- |
| Agent contract (this file) | `AGENTS.md` |
| Code style and file map | `CODE-STYLE.md` |
| Shared types (SSOT) | `src/types.ts` |
| Package scripts | `package.json` |
| Human pitch / usage | `README.md` |
| Skill authoring fallback | `docs/skill-authoring.md` |

Keep one instruction hub here. Do not invent parallel root guides for each coding agent.

## Read order

1. This file
2. `CODE-STYLE.md` when changing structure, naming, or logging
3. `src/types.ts` for contracts
4. The specific `src/*.ts` file you touch

## Commands

```bash
npm start -- url=<video|playlist|@channel|@channel/shorts> [format=vtt] [lang=en] [auto] [stdout] [out-dir=./scraped-yt] [output-format=txt|md|json|jsonl] [cookies=./cookies.txt] [agent=codex|grok|…] [model=<id>] [reasoning-effort=low|medium|high] [system-prompt="..."]
npm run typecheck
npm run build
```

CLI options (see `src/cli.ts`):

- `format=` — subtitle formats; default `vtt`
- `lang=` — language tokens; default `en`
- `auto` — allow auto-generated captions
- `stdout` — print captions instead of writing files
- `cookies=` — optional Netscape cookies for public session
- `agent=` — local agent for skill scaffold
- `model=` / `reasoning-effort=` — agent model and effort when supported
- `system-prompt=` — **extra** guidance appended to the official skill-authoring prompt (`emptySystemPrompt` = use official only)
- `out-dir=` — base output directory; default `./scraped-yt`

Bulk output roots (under `out-dir`):

| Input | Folder |
| --- | --- |
| Channel Videos (`@handle` or `…/videos`) | `channel-<name>/` |
| Channel Shorts (`…/shorts`) | `shorts-<name>/` |
| Single video / playlist | `out-dir` root |

## Layout (summary)

| File | Role |
| --- | --- |
| `src/main.ts` | CLI entry + orchestration |
| `src/cli.ts` | Argument parsing (+ interactive) |
| `src/captions.ts` | Caption track selection / URLs |
| `src/playlist.ts` | Playlist video IDs |
| `src/channel.ts` | Channel Videos/Shorts discovery + bulk folder names |
| `src/player-api.ts` | Multi-client Innertube player |
| `src/http.ts` | Fetch + 429 backoff + session cookies |
| `src/cookies.ts` | Netscape jar |
| `src/output.ts` | Caption → txt/md/json/jsonl |
| `src/agent.ts` | Local agent spawn + metrics parse |
| `src/agentModels.ts` | Model list / flags |
| `src/skill-prompt.ts` | Per-agent official skill system prompt |
| `src/skill-output.ts` | Multi-file `SKILL.md` package parse/write |
| `src/types.ts` | Shared types only |
| `src/constants.ts` | Shared literals when present |

Full style rules: `CODE-STYLE.md`. No type re-export shims; import contracts from `types.ts`.

## Agent skill packages

When `agent=` is set:

```text
<out-dir>/[channel-|shorts-<name>/]agents/<agent>/<model[_effort]>/<videoId>/
  transcript.txt
  agent-raw.md
  metrics.json
  <skill-name>/SKILL.md
```

- Skill prompt: official agent docs when known ([Claude skills](https://code.claude.com/docs/en/skills), [Codex skills](https://github.com/openai/codex/blob/main/docs/skills.md), [agentskills.io](https://agentskills.io/specification)), else `docs/skill-authoring.md`
- `metrics.json`: requested model/effort, tokens when stdout exposes them, `unavailableNotes` for nulls

## Working rules

- Keep the project small; no heavy abstractions.
- Fail fast with clear errors; no silent fallbacks that hide causes.
- Domain-specific names (see `CODE-STYLE.md`); no backward-compat aliases for renames.
- Prefer [Effect](https://effect.website/) where already used; do not add frameworks casually.
- Do not grow into yt-dlp (no A/V pipeline, no private-content scraping).

## Verify before done

- `npm run typecheck` must pass.
- Smoke-test with a public video, playlist, channel, or shorts URL when network is available.

## Safety

- Public pages only; optional cookies are for public session resilience, not private content.
- Do not commit secrets or large caption dumps (`scraped-yt/` is gitignored).
- Keep playlist/channel throttling; leave `dist/` and `node_modules/` alone unless the task is about them.
