---
name: yt-transcript
description: >
  Fetch YouTube captions/transcripts via the ytcap (yt-captions-mini-ai) CLI — single video,
  playlist, or channel bulk — and optionally convert transcripts into agent SKILL.md packages.
  Use when the user asks for YouTube subtitles, captions, transcripts, bulk channel scrapes,
  or "faster than yt-dlp for captions only". Prefer this over generic scrapers for YouTube-only
  CLI work. Trigger phrases: /yt-transcript, youtube captions cli, ytcap, transcript to skill.
---

# YouTube transcript via ytcap

## Install (if needed)

```bash
npm install -g yt-captions-mini-ai
# or: npm install && npm run build  (from repo root)
# binaries: ytcap | yt-captions-mini-ai
```

Requires Node.js 20+. Optional: `yt-dlp` on PATH for `extractor=ytdlp` / auto fallback.

## Single video

```bash
ytcap url=https://www.youtube.com/watch?v=VIDEO_ID lang=en auto output-format=txt
# short form
ytcap url=VIDEO_ID lang=en auto output-format=txt out-dir=./scraped-yt
```

## Bulk playlist / channel

```bash
ytcap url='https://www.youtube.com/playlist?list=LIST_ID' lang=en auto concurrency=8 max-videos=50 output-format=txt
ytcap url=https://www.youtube.com/@handle lang=en auto concurrency=8 output-format=txt
ytcap url=https://www.youtube.com/@handle/shorts lang=en auto concurrency=8 output-format=txt
```

## Cache / force refresh

```bash
ytcap url=VIDEO_ID lang=en auto output-format=txt        # uses ~/.cache by default
ytcap url=VIDEO_ID lang=en auto force output-format=txt  # bypass cache
ytcap url=VIDEO_ID lang=en auto no-cache output-format=txt
```

## Extractor modes

```bash
ytcap url=VIDEO_ID lang=en auto extractor=auto    # native Innertube, then yt-dlp
ytcap url=VIDEO_ID lang=en auto extractor=native
ytcap url=VIDEO_ID lang=en auto extractor=ytdlp   # requires yt-dlp on PATH
```

## Transcript → agent skill package

```bash
ytcap url=VIDEO_ID agent=grok model=grok-4.5 reasoning-effort=medium
ytcap url=VIDEO_ID agent=codex model=gpt-5.3-codex-spark
```

Writes under `scraped-yt/agents/<agent>/<model[_effort]>/<videoId>/` including `SKILL.md` packages and `metrics.json`.

## When NOT to use

- Video/audio download or mux → use **yt-dlp**
- Non-YouTube sites → use **yt-dlp**
- Browser-only one-liner without CLI → `youtube-transcript` npm (often captcha/rate-limited)

## Output

Default directory: `./scraped-yt/<videoId>.en.txt` (or `out-dir=`).

## More

See repo `llms.txt` and README benchmarks (vs yt-dlp captions-only).
