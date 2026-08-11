# yt-captions-mini-ai code style

Keep this project intentionally small and boring.

## How to read a rule

| Slot | Meaning |
| --- | --- |
| rule ID | Stable review and detector key |
| verify | Cheapest command that proves the rule, or judgment |
| chosen / rejected | The local idiom and the concrete failure shape |

## Rules

### Use arrow functions for all function
[rule:use.arrow-functions-for-all-function] · verify: judgment

Use arrow functions for all function declarations.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Prefer explicit, domain-specific names over generic
[rule:prefer.explicit-domain-specific-names-over] · verify: judgment

Prefer explicit, domain-specific names over generic placeholders.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Avoid: result, response, json, data, payload,
[rule:avoid.result-response-json-data-payload] · verify: judgment

Avoid: `result`, `response`, `json`, `data`, `payload`, `row`, `text`, `value`, `item`, `output`, `input`, `tmp`.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Prefer: videoInfo, playerPayload, captionTracks, subtitleSou
[rule:prefer.videoinfo-playerpayload-captiontracks-subtitlesou] · verify: judgment

Prefer: `videoInfo`, `playerPayload`, `captionTracks`, `subtitleSource`, `playlistEntry`, `subtitlePayload`, `optionRawToken`, `cueText`, etc.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Do not keep backward-compat aliases or
[rule:do.not-keep-backward-compat-aliases] · verify: judgment

Do **not** keep backward-compat aliases or re-export shims for renames.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Declare module-level hardcoded values in src/constants.ts
[rule:declare.module-level-hardcoded-values-in] · verify: judgment

Declare module-level hardcoded values in `src/constants.ts` only — one nested `CONSTANTS` object keyed by module (`shared`, `main`, `agent`, …).

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Keep one responsibility per file
[rule:keep.one-responsibility-per-file] · verify: judgment

Keep one responsibility per file.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Keep parsing and transport concerns separate
[rule:keep.parsing-and-transport-concerns-separate] · verify: judgment

Keep parsing and transport concerns separate from selection/orchestration logic.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Use immutable values when possible (const
[rule:use.immutable-values-when-possible-const] · verify: judgment

Use immutable values when possible (`const` everywhere).

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Keep logs one-line and consistent with
[rule:keep.logs-one-line-and-consistent] · verify: judgment

Keep logs one-line and consistent with a tag.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### [INFO]
[rule:info] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### [WARN]
[rule:warn] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### [ERR]
[rule:err] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Prefer small utility functions over inline
[rule:prefer.small-utility-functions-over-inline] · verify: judgment

Prefer small utility functions over inline one-liners.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Every declared type/interface and schema field
[rule:every.declared-type-interface-and-schema] · verify: judgment

Every declared type/interface and schema field should have a one-line comment describing intent.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/main.ts — CLI entrypoint only
[rule:src.main-ts-cli-entrypoint-only] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/cli.ts — argument parsing
[rule:src.cli-ts-argument-parsing] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/captions.ts — caption track parsing and
[rule:src.captions-ts-caption-track-parsing] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/playlist.ts — playlist page extraction and
[rule:src.playlist-ts-playlist-page-extraction] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/channel.ts — channel Videos/Shorts tab discovery
[rule:src.channel-ts-channel-videos-shorts] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/video-metadata.ts — public title/duration/publish metada
[rule:src.video-metadata-ts-public-title] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/video-filters.ts — AND-combine date/duration/title gates
[rule:src.video-filters-ts-and-combine] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/filters/date-range.ts | duration.ts | title.ts —
[rule:src.filters-date-range-ts-duration] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/http.ts — network helpers
[rule:src.http-ts-network-helpers] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/parsing.ts — generic HTML + JSON
[rule:src.parsing-ts-generic-html-json] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/log.ts — structured console logs
[rule:src.log-ts-structured-console-logs] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/types.ts — shared typed contracts
[rule:src.types-ts-shared-typed-contracts] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/constants.ts — SSOT nested constants (CONSTANTS.<module>
[rule:src.constants-ts-ssot-nested-constants] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/agent.ts — local agent CLI profiles,
[rule:src.agent-ts-local-agent-cli] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/player-api.ts — multi-client Innertube player for
[rule:src.player-api-ts-multi-client] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/output.ts — caption conversion to export
[rule:src.output-ts-caption-conversion-to] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/cookies.ts — Netscape cookie file +
[rule:src.cookies-ts-netscape-cookie-file] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/http.ts — fetch with 429 backoff
[rule:src.http-ts-fetch-with-429] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/skill-prompt.ts — per-agent official skill docs
[rule:src.skill-prompt-ts-per-agent] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### src/skill-output.ts — parse/write multi-file SKILL.md packag
[rule:src.skill-output-ts-parse-write] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### docs/skill-authoring.md — local fallback skill authoring
[rule:docs.skill-authoring-md-local-fallback] · verify: judgment

Follow this project rule as specified.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Agent skills land under scraped-yt/agents/<agent>/<videoId>/
[rule:agent.skills-land-under-scraped-yt] · verify: judgment

Agent skills land under `scraped-yt/agents/<agent>/<videoId>/<skill>/SKILL.md`.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### No heavy abstractions
[rule:no.heavy-abstractions] · verify: judgment

No heavy abstractions.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### No fallback behavior that hides failure
[rule:no.fallback-behavior-that-hides-failure] · verify: judgment

No fallback behavior that hides failure causes.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

### Fail fast with clear error text
[rule:fail.fast-with-clear-error-text] · verify: judgment

Fail fast with clear error text when expected YouTube markers/fields are missing.

```ts
// ✓ yt-captions-mini-ai idiom

// ✗ rejected shape
```

Why: Keeps the local idiom consistent and reviewable.

## Canonical example

Compose one real feature slice that shows the rules together. Point at real paths once code exists.

## Golden path — adding a unit

1. Name vocabulary changes in LANGUAGE.md / CONTEXT.md when needed.
2. Implement at the owning path for this repository.
3. Wire the unit at its registration seam.
4. Colocate or place tests per the rules above and run the project gate.

Definition of done:

- Focused tests pass.
- Style and typecheck pass.
- No `## Never` tell was introduced.

## Exemplars

- (none promoted yet — promote the first cleaned slice.)

## Never

- Generic names (`data`, `payload`, `result`, `response`) [rule:names] when present.
- Multi-job pipelines and pass-through wrappers that violate the rule cards above.
