# yt-captions-mini-ai (`ytcap`)

![yt-captions-mini-ai](assets/hero.png)

[![canary](https://github.com/YosefHayim/yt-captions-mini-ai/actions/workflows/canary.yml/badge.svg)](https://github.com/YosefHayim/yt-captions-mini-ai/actions/workflows/canary.yml)
[![ci](https://github.com/YosefHayim/yt-captions-mini-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/YosefHayim/yt-captions-mini-ai/actions/workflows/ci.yml)

Tiny [TypeScript](https://www.typescriptlang.org/) / [Node.js](https://nodejs.org/en) CLI that downloads public [YouTube](https://www.youtube.com/) captions — for a **video**, **playlist**, **channel**, or **channel Shorts** — and optionally pipes the transcript into a **local coding agent** to scaffold portable [`SKILL.md`](https://agentskills.io/specification) packages.

**Binary:** `ytcap` (alias `yt-captions-mini-ai`).

Not a second [yt-dlp](https://github.com/yt-dlp/yt-dlp). That project is the full media Swiss-army knife across thousands of sites. This is a **YouTube-only**, captions-focused CLI: Innertube-first extraction, bulk concurrency, disk cache, optional yt-dlp fallback, local-agent skill scaffolding.

## When to use us vs yt-dlp

| Job | Prefer |
| --- | --- |
| Download video/audio, mux, thousands of sites | [yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| **Fast public YouTube captions** (video / playlist / channel) | **this tool** |
| Tiny library `fetchTranscript(id)` in app code | [youtube-transcript](https://www.npmjs.com/package/youtube-transcript) (often rate-limited / captcha) |
| Full Innertube client as a dependency | [youtubei.js](https://github.com/LuanRT/YouTube.js) (library, not a captions CLI) |

**YouTube captions path (this tool):** skip watch HTML when possible → sticky Innertube player client (usually `android`) → download one language → optional concurrent bulk workers. That is narrower than yt-dlp and usually **faster for this job**.

### Benchmarks (live, captions only, no agent)

Measured on a laptop against a **generic public video** and a small playlist. Times are wall-clock; re-run with `bash scripts/bench-captions.sh` (set `VIDEO_ID=` / `PLAYLIST_URL=` as needed).

**Single video** — [`dQw4w9WgXcQ`](https://www.youtube.com/watch?v=dQw4w9WgXcQ) (Rick Astley — *Never Gonna Give You Up*), `lang=en` + auto captions, 3 runs each:

| Tool | Run 1 | Run 2 | Run 3 | Median | vs this |
| --- | ---: | ---: | ---: | ---: | ---: |
| **yt-captions-mini-ai** (Innertube-first) | 1.55s | 1.63s | 1.70s | **1.63s** | 1× |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) `2026.07.04` (`--skip-download --write-auto-subs --sub-langs en`) | 3.80s | 4.26s | 3.92s | **3.92s** | **~2.4× slower** |
| Previous HTML-first path (same repo, pre-fast-path) | 14.4s | 14.9s | 14.3s | **14.5s** | **~8.9× slower** |

**Bulk** — 6 playlist videos, English captions only:

| Tool | Time | Files written | Notes |
| --- | ---: | ---: | --- |
| **this tool** `concurrency=8 max-videos=6` | **2.67s** | **6/6** | sticky player client + parallel workers |
| **this tool** `concurrency=1 max-videos=6` | 4.98s | 6/6 | serial fast path |
| yt-dlp `-N 8 --playlist-end 6 --sub-langs en` | 16.0s | 4 (exit 1) | extra work + private items in that list |

**Other OSS (same video, same machine):**

| Package | Result |
| --- | --- |
| [youtube-transcript](https://www.npmjs.com/package/youtube-transcript) (npm) | Failed with YouTube captcha / too-many-requests (~0.8s fail-fast) — fine as a library demo, not a bulk CLI |

Fairness notes:

- yt-dlp compared with **one language** (`en`), not `en.*` (which downloads dozens of tracks and 429s hard).
- This tool does **not** download video/audio; neither side was timed on media.
- Network variance applies; medians above are representative, not a lab guarantee.

Reproduce:

```bash
# Single video vs previous path (if you still have main checked out) + yt-dlp
VIDEO_ID=dQw4w9WgXcQ BULK_N=6 bash scripts/bench-captions.sh
```

## Quick start

Requires [Node.js](https://nodejs.org/en) 20+.

```bash
# Global (published package)
npm install -g yt-captions-mini-ai
ytcap url=https://www.youtube.com/watch?v=dQw4w9WgXcQ lang=en auto output-format=txt

# From source
git clone https://github.com/YosefHayim/yt-captions-mini-ai.git
cd yt-captions-mini-ai
npm install          # prepare builds dist/
npm start -- url=https://www.youtube.com/watch?v=dQw4w9WgXcQ lang=en auto output-format=txt
# dev without build: npm run dev -- url=…
```

Machine-oriented recipes for LLMs: [`llms.txt`](llms.txt). Agent skill: [`skills/yt-transcript/SKILL.md`](skills/yt-transcript/SKILL.md).

### Captions only

```bash
# Single video
ytcap url=https://www.youtube.com/watch?v=dQw4w9WgXcQ output-format=txt auto

# Playlist (parallel workers; cap count for a quick scrape)
ytcap url=https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID output-format=txt auto concurrency=8 max-videos=20

# Entire channel (Videos tab) → scraped-yt/channel-<name>/
ytcap url=https://www.youtube.com/@handle output-format=txt auto concurrency=8

# Channel Shorts tab → scraped-yt/shorts-<name>/
ytcap url=https://www.youtube.com/@handle/shorts output-format=txt auto

# Disk cache is on by default (~/.cache/yt-captions-mini-ai); force refresh:
ytcap url=dQw4w9WgXcQ lang=en auto force output-format=txt

# Optional yt-dlp fallback (yt-dlp must be on PATH)
ytcap url=VIDEO_ID lang=en auto extractor=auto
```

### Skill scaffold (captions → local agent)

The named agent CLI must already be on your `PATH` (this tool does not install agents).

```bash
ytcap url=https://www.youtube.com/watch?v=VIDEO_ID agent=codex model=gpt-5.3-codex-spark
ytcap url=VIDEO_ID agent=grok model=grok-4.5 reasoning-effort=high
```

Default system prompt authors **official-style skill packages** (YAML frontmatter + when-to-use + procedure), using each agent’s docs when known, otherwise [`docs/skill-authoring.md`](docs/skill-authoring.md). Extra guidance: `system-prompt="..."`.

## Output layout

| Input | Captions root |
| --- | --- |
| Single video / playlist | `./scraped-yt/` (or `out-dir=`) |
| Channel Videos tab | `./scraped-yt/channel-<name>/` |
| Channel Shorts tab | `./scraped-yt/shorts-<name>/` |

```text
scraped-yt/
  channel-<name>/
    <videoId>.en.txt
  shorts-<name>/
    <videoId>.en.txt
  agents/<agent>/<model[_effort]>/<videoId>/   # when agent= is set
    transcript.txt
    agent-raw.md
    metrics.json
    <skill-name>/SKILL.md
```

`scraped-yt/` is gitignored.

## Options

```bash
npm start -- url=<youtube-url-or-id> [options]
npm start   # interactive prompts when no args
```

| Option | Meaning | Default |
| --- | --- | --- |
| `url=` | Video, Shorts id/url, playlist, or channel (`@handle`, `/channel/UC…`, `/shorts`) | required (or interactive) |
| `format=` | Caption source formats (`vtt`, `srt`, `json3`, …) | `vtt` |
| `lang=` | Language tokens | `en` |
| `auto` | Allow auto-generated captions | off |
| `output-format=` | `txt`, `md`, `json`, `jsonl` | derived |
| `out-dir=` | Output directory | `./scraped-yt` |
| `stdout` | Print instead of writing files | off |
| `cookies=` | Optional Netscape `cookies.txt` for public session cookies | none |
| `concurrency=` | Parallel video workers for playlist/channel (`1`–`32`); AIMD shrink on 429 | `4` |
| `max-videos=` | Cap how many bulk videos to process | unlimited |
| `extractor=` | `auto` (native→yt-dlp), `native`, `ytdlp` | `auto` |
| `no-cache` | Disable disk transcript cache | off (cache on) |
| `force` | Bypass cache and refresh from YouTube | off |
| `agent=` | Local agent for skill scaffold | none |
| `model=` | Agent model id (`-m` / `--model`) | agent CLI default |
| `reasoning-effort=` | `low` \| `medium` \| `high` (when agent supports it) | none |
| `since=` / `until=` | Bulk only: publish day bounds (`YYYY-MM-DD`, UTC inclusive) | none |
| `min-duration=` / `max-duration=` | Bulk only: length in whole seconds (inclusive) | none |
| `title-includes=` / `title-excludes=` | Bulk only: title tokens (comma list, case-insensitive) | none |
| `system-prompt=` | Extra skill-authoring guidance (appended to official skill contract) | empty |

Supported `agent=` values:

| `agent=` | Local CLI |
| --- | --- |
| `claude` | [Claude Code](https://code.claude.com/docs/en/overview) |
| `codex` | [OpenAI Codex CLI](https://developers.openai.com/codex) |
| `cursor` | [Cursor](https://cursor.com/docs) agent CLI |
| `devin` | Devin CLI |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) |
| `grok` / `agent` | Grok Build CLI |
| `kimi` | Kimi CLI |
| `kiro` | Kiro CLI (`kiro-cli`) |

Scripts: `npm run typecheck` · `npm run build` · `npm start -- url=...` · `npm run dev -- url=...` · `npm run canary`

Stack: [Effect](https://effect.website/), [@clack/prompts](https://github.com/bombshell-dev/clack), [undici](https://github.com/nodejs/undici).

## Resilience & speed (YouTube captions path)

YouTube-only, captions-only (client ideas inspired by [yt-dlp](https://github.com/yt-dlp/yt-dlp)):

- **Innertube-first** — call `youtubei/v1/player` before fetching watch HTML
- **Sticky last-good client** — after the first hit, reuse that client for the rest of the process
- **Race top-2 clients** on cold miss (configurable via `config/player-clients.json`)
- **Preferred order** — `android` → `ios` → `web` → … (overridable JSON / `YT_CAP_CLIENT_CONFIG`)
- **HTML fallback** only when player returns no tracks
- **extractor=auto** — native first, then optional **yt-dlp** if native fails
- **Disk cache** — `~/.cache/yt-captions-mini-ai/transcripts/` (`force` / `no-cache` to skip)
- **undici keep-alive** pool + **AIMD concurrency** when bulk hits HTTP 429
- **PO token hooks** — `YT_CAP_PO_TOKEN` or `YT_CAP_PO_TOKEN_COMMAND` when YouTube requires pot
- HTTP retries on 429/502/503/504 with backoff and `Retry-After`
- Optional Netscape cookies + in-process `Set-Cookie` jar
- **Nightly canary** — three public videos; status badge at the top of this README

## Scope

**In scope**

- Public YouTube caption tracks (manual or `auto`)
- Single video, playlist (first-page playlist state + channel browse continuations)
- Channel **Videos** and **Shorts** tabs with bulk folders
- Optional local-agent skill packaging + run metrics JSON

**Out of scope**

- Video/audio download, merge, or private/members content (use [yt-dlp](https://github.com/yt-dlp/yt-dlp))
- Cloud caption APIs or hosted services
- Installing or replacing agent products — this only **invokes** CLIs already on `PATH`
- GUI

## Docs

- [AGENTS.md](AGENTS.md) — contract for coding agents ([agents.md](https://agents.md/) convention)
- [CODE-STYLE.md](CODE-STYLE.md) — file map and style rules
- [docs/skill-authoring.md](docs/skill-authoring.md) — portable skill authoring reference

## License

MIT — see `package.json`.
