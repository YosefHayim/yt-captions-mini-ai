import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

import { CONSTANTS } from './constants.js';

const { EMPTY_VALUE, FILE_ENCODING } = CONSTANTS.shared;

// Disk cache entry for one video + language + export format.
export type TranscriptCacheEntry = {
  // Cached video id.
  videoId: string;
  // Caption language tag.
  languageTag: string;
  // Export format key (txt/md/json/…).
  exportFormat: string;
  // Plain transcript body.
  transcriptBody: string;
  // Human title when known.
  videoName: string | null;
  // ISO timestamp when written.
  cachedAt: string;
};

const resolveCacheRoot = (): string => {
  // Prefer XDG, then ~/.cache/yt-captions-mini-ai.
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim() ?? EMPTY_VALUE;
  if (xdgCacheHome.length > 0) {
    return path.join(xdgCacheHome, 'yt-captions-mini-ai');
  }
  return path.join(homedir(), '.cache', 'yt-captions-mini-ai');
};

const renderCacheFilePath = (videoId: string, languageTag: string, exportFormat: string): string => {
  const safeLang = languageTag.replace(/[^A-Za-z0-9._-]+/g, '_') || 'und';
  const safeFormat = exportFormat.replace(/[^A-Za-z0-9._-]+/g, '_') || 'txt';
  return path.join(resolveCacheRoot(), 'transcripts', `${videoId}.${safeLang}.${safeFormat}.json`);
};

export const readTranscriptCache = async (
  videoId: string,
  languageTag: string,
  exportFormat: string,
): Promise<TranscriptCacheEntry | null> => {
  const cacheFilePath = renderCacheFilePath(videoId, languageTag, exportFormat);
  try {
    const rawBody = await readFile(cacheFilePath, FILE_ENCODING);
    const parsedBody = JSON.parse(rawBody) as TranscriptCacheEntry;
    if (
      typeof parsedBody.transcriptBody !== 'string'
      || parsedBody.transcriptBody.length === 0
      || parsedBody.videoId !== videoId
    ) {
      return null;
    }
    return parsedBody;
  } catch {
    return null;
  }
};

export const writeTranscriptCache = async (cacheEntry: TranscriptCacheEntry): Promise<void> => {
  const cacheFilePath = renderCacheFilePath(
    cacheEntry.videoId,
    cacheEntry.languageTag,
    cacheEntry.exportFormat,
  );
  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(
    cacheFilePath,
    `${JSON.stringify(cacheEntry, null, 2)}\n`,
    FILE_ENCODING,
  );
};

export const getTranscriptCacheRoot = (): string => resolveCacheRoot();
