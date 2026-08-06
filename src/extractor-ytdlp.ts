import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONSTANTS } from './constants.js';
import { logInfo, logWarn } from './log.js';

const { EMPTY_VALUE, FILE_ENCODING } = CONSTANTS.shared;

// Result of a yt-dlp captions-only extraction.
export type YtdlpCaptionResult = {
  // Plain-ish caption body (VTT/SRT text as written by yt-dlp).
  captionBody: string;
  // Language tag guessed from filename.
  languageTag: string;
  // Absolute path that was read.
  sourceFilePath: string;
};

const findFirstSubtitleFile = (outputDirectory: string): string | null => {
  const directoryEntries = readdirSync(outputDirectory);
  const subtitleFile = directoryEntries.find((entryName) =>
    /\.(vtt|srt|ttml)$/i.test(entryName),
  );
  return subtitleFile ? path.join(outputDirectory, subtitleFile) : null;
};

const languageFromFileName = (filePath: string): string => {
  // e.g. video.en.vtt → en
  const baseName = path.basename(filePath);
  const nameParts = baseName.split('.');
  if (nameParts.length >= 3) {
    return nameParts[nameParts.length - 2] || 'en';
  }
  return 'en';
};

export const extractCaptionsWithYtdlp = (
  watchUrl: string,
  languageTag: string,
): YtdlpCaptionResult | null => {
  // 1) Write subs only into a temp dir; never download media.
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'ytcap-ytdlp-'));
  try {
    const outputTemplate = path.join(tempDirectory, '%(id)s');
    const ytdlpArgs = [
      '--skip-download',
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs',
      languageTag,
      '--sub-format',
      'vtt/best',
      '-o',
      outputTemplate,
      watchUrl,
    ];
    logInfo(`extractor=ytdlp: yt-dlp ${ytdlpArgs.slice(0, 4).join(' ')} …`);
    const ytdlpRun = spawnSync('yt-dlp', ytdlpArgs, {
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
    });
    if (ytdlpRun.error) {
      const errno = (ytdlpRun.error as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        logWarn('extractor=ytdlp: yt-dlp not on PATH; install yt-dlp for fallback.');
        return null;
      }
      logWarn(`extractor=ytdlp: ${ytdlpRun.error.message}`);
      return null;
    }
    if (ytdlpRun.status !== 0) {
      const stderrBody = (ytdlpRun.stderr ?? EMPTY_VALUE).trim();
      logWarn(`extractor=ytdlp failed (exit ${ytdlpRun.status}): ${stderrBody.slice(0, 200)}`);
      return null;
    }
    const subtitleFilePath = findFirstSubtitleFile(tempDirectory);
    if (!subtitleFilePath) {
      logWarn('extractor=ytdlp: no subtitle file written.');
      return null;
    }
    const captionBody = readFileSync(subtitleFilePath, FILE_ENCODING).trim();
    if (captionBody.length === 0) {
      return null;
    }
    return {
      captionBody,
      languageTag: languageFromFileName(subtitleFilePath),
      sourceFilePath: subtitleFilePath,
    };
  } finally {
    try {
      rmSync(tempDirectory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
};
