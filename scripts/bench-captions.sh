#!/usr/bin/env bash
# Caption-only wall-clock benchmarks (no local agent).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_ROOT="$(cd "$ROOT/../yt-captions-mini-ai" && pwd)"
VIDEO_ID="${VIDEO_ID:-iQyg-KypKAA}"
VIDEO_URL="https://www.youtube.com/watch?v=${VIDEO_ID}"
# Known multi-video playlist; capped with max-videos for fair bulk timing.
PLAYLIST_URL="${PLAYLIST_URL:-https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE}"
BULK_N="${BULK_N:-8}"
OUT_BASE="${OUT_BASE:-/tmp/yt-cap-bench-$$}"
mkdir -p "$OUT_BASE"

time_cmd() {
  local label="$1"
  shift
  local start end elapsed status=0
  start=$(date +%s.%N)
  set +e
  "$@" >"$OUT_BASE/${label}.log" 2>&1
  status=$?
  set -e
  end=$(date +%s.%N)
  elapsed=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.3f", e - s }')
  printf '%-48s  %8ss  exit=%s\n' "$label" "$elapsed" "$status"
  if [[ "$status" -ne 0 ]]; then
    echo "  log tail:" >&2
    tail -8 "$OUT_BASE/${label}.log" | sed 's/^/    /' >&2
  fi
  # Count successful caption outputs when present
  return 0
}

echo "=== Caption benchmarks (no agent) ==="
echo "VIDEO=$VIDEO_URL"
echo "PLAYLIST=$PLAYLIST_URL (max-videos=$BULK_N)"
echo "OUT=$OUT_BASE"
echo

echo "--- single video ---"
time_cmd "feature_single_innertube" \
  npx --yes tsx "$ROOT/src/main.ts" \
  "url=$VIDEO_URL" lang=en auto output-format=txt \
  "out-dir=$OUT_BASE/feature-single" concurrency=1

if [[ -f "$MAIN_ROOT/src/main.ts" ]]; then
  time_cmd "main_single_html_first" \
    npx --yes tsx "$MAIN_ROOT/src/main.ts" \
    "url=$VIDEO_URL" lang=en auto output-format=txt \
    "out-dir=$OUT_BASE/main-single"
fi

if command -v yt-dlp >/dev/null 2>&1; then
  # Fair compare: one language only (en), same job shape as our CLI lang=en.
  time_cmd "ytdlp_single_subs_only" \
    yt-dlp --skip-download --write-auto-subs --sub-langs "en" --sub-format vtt \
    -o "$OUT_BASE/ytdlp-single/%(id)s" "$VIDEO_URL"
else
  echo "ytdlp_single_subs_only                           SKIP (yt-dlp not installed)"
fi

echo
echo "--- bulk playlist (max-videos=$BULK_N) ---"
time_cmd "feature_bulk_concurrency_1" \
  npx --yes tsx "$ROOT/src/main.ts" \
  "url=$PLAYLIST_URL" lang=en auto output-format=txt \
  "out-dir=$OUT_BASE/feature-bulk-1" concurrency=1 "max-videos=$BULK_N"

time_cmd "feature_bulk_concurrency_8" \
  npx --yes tsx "$ROOT/src/main.ts" \
  "url=$PLAYLIST_URL" lang=en auto output-format=txt \
  "out-dir=$OUT_BASE/feature-bulk-8" concurrency=8 "max-videos=$BULK_N"

if command -v yt-dlp >/dev/null 2>&1; then
  time_cmd "ytdlp_playlist_subs_N8" \
    yt-dlp --skip-download --write-auto-subs --sub-langs "en" --sub-format vtt \
    -N 8 --playlist-end "$BULK_N" \
    -o "$OUT_BASE/ytdlp-bulk/%(id)s" "$PLAYLIST_URL"
else
  echo "ytdlp_playlist_subs_N8                            SKIP (yt-dlp not installed)"
fi

echo
echo "--- outputs ---"
for d in feature-single main-single feature-bulk-1 feature-bulk-8 ytdlp-single ytdlp-bulk; do
  if [[ -d "$OUT_BASE/$d" ]]; then
    count=$(find "$OUT_BASE/$d" -type f ! -name '*.part' 2>/dev/null | wc -l | tr -d ' ')
    printf '%-24s %s files\n' "$d" "$count"
  fi
done

echo
echo "--- feature single log (path check) ---"
grep -E 'innertube-first|sticky|player client|Saved subtitles' "$OUT_BASE/feature_single_innertube.log" | head -20 || true

echo
echo "DONE logs in $OUT_BASE"
