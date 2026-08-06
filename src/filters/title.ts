import { VideoFilterCriteria, YoutubeVideoMetadata } from '../types.js';

const normalizeTitleHaystack = (title: string): string => title.trim().toLowerCase();

export const videoPassesTitleFilter = (
  videoMetadata: YoutubeVideoMetadata,
  filterCriteria: VideoFilterCriteria,
): boolean => {
  // 1) No title tokens configured → pass.
  if (
    filterCriteria.titleIncludes.length === 0
    && filterCriteria.titleExcludes.length === 0
  ) {
    return true;
  }

  const titleHaystack = normalizeTitleHaystack(videoMetadata.title);

  // 2) Empty title cannot satisfy include tokens; exclude-only can still pass empty titles.
  if (filterCriteria.titleIncludes.length > 0 && titleHaystack.length === 0) {
    return false;
  }

  // 3) Require every include token (case-insensitive substring).
  for (const includeToken of filterCriteria.titleIncludes) {
    const needle = includeToken.trim().toLowerCase();
    if (needle.length === 0) {
      continue;
    }
    if (!titleHaystack.includes(needle)) {
      return false;
    }
  }

  // 4) Reject if any exclude token appears.
  for (const excludeToken of filterCriteria.titleExcludes) {
    const needle = excludeToken.trim().toLowerCase();
    if (needle.length === 0) {
      continue;
    }
    if (titleHaystack.includes(needle)) {
      return false;
    }
  }

  return true;
};

export const parseTitleTokenList = (rawList: string): string[] => {
  // Split comma-separated title tokens; keep order; drop empties.
  const tokens: string[] = [];
  for (const rawToken of rawList.split(',')) {
    const trimmedToken = rawToken.trim();
    if (trimmedToken.length > 0) {
      tokens.push(trimmedToken);
    }
  }
  return tokens;
};
