# yt-captions-mini-ai code style

Keep this project intentionally small and boring.

## Core rules

- Use arrow functions for all function declarations.
- Prefer explicit, domain-specific names over generic placeholders.
  - Avoid: `result`, `response`, `json`, `data`, `payload`, `row`, `text`, `value`, `item`, `output`, `input`, `tmp`
  - Prefer: `videoInfo`, `playerPayload`, `captionTracks`, `subtitleSource`, `playlistEntry`, `subtitlePayload`, `optionRawToken`, `cueText`, etc.
- Do **not** keep backward-compat aliases or re-export shims for renames. Update call sites; `types.ts` is the only SSOT for shared types.
- Declare module-level hardcoded values in `src/constants.ts` only — one nested `CONSTANTS` object keyed by module (`shared`, `main`, `agent`, …). Modules import and destructure; do not re-hardcode duplicated strings/numbers/regex across files.
- Keep one responsibility per file.
- Keep parsing and transport concerns separate from selection/orchestration logic.
- Use immutable values when possible (`const` everywhere).
- Keep logs one-line and consistent with a tag:
  - `[INFO] ...`
  - `[WARN] ...`
  - `[ERR] ...`
- Prefer small utility functions over inline one-liners.
- Every declared type/interface and schema field should have a one-line comment describing intent.

## File layout

- `src/main.ts` — CLI entrypoint only.
- `src/cli.ts` — argument parsing.
- `src/captions.ts` — caption track parsing and URL building.
- `src/playlist.ts` — playlist page extraction and ID collection.
- `src/channel.ts` — channel Videos/Shorts tab discovery + bulk folder names.
- `src/video-metadata.ts` — public title/duration/publish metadata for bulk filters.
- `src/video-filters.ts` — AND-combine date/duration/title gates for bulk lists.
- `src/filters/date-range.ts` | `duration.ts` | `title.ts` — individual bulk filters.
- `src/http.ts` — network helpers.
- `src/parsing.ts` — generic HTML + JSON extraction helpers.
- `src/log.ts` — structured console logs.
- `src/types.ts` — shared typed contracts.
- `src/constants.ts` — SSOT nested constants (`CONSTANTS.<module>` + `CONSTANTS.shared`).
- `src/agent.ts` — local agent CLI profiles, spawn, metrics parse.
- `src/player-api.ts` — multi-client Innertube player for caption tracks.
- `src/output.ts` — caption conversion to export formats.
- `src/cookies.ts` — Netscape cookie file + in-process jar.
- `src/http.ts` — fetch with 429 backoff and session cookies.
- `src/skill-prompt.ts` — per-agent official skill docs + system prompt.
- `src/skill-output.ts` — parse/write multi-file SKILL.md packages.
- `docs/skill-authoring.md` — local fallback skill authoring guide.
- Agent skills land under `scraped-yt/agents/<agent>/<videoId>/<skill>/SKILL.md`.

## Minimal boundaries

- No heavy abstractions.
- No fallback behavior that hides failure causes.
- Fail fast with clear error text when expected YouTube markers/fields are missing.
