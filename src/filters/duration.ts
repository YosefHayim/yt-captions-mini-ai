import { VideoFilterCriteria, YoutubeVideoMetadata } from '../types.js';

export const videoPassesDurationFilter = (
  videoMetadata: YoutubeVideoMetadata,
  filterCriteria: VideoFilterCriteria,
): boolean => {
  // 1) No duration bounds configured → pass.
  if (filterCriteria.minDurationSec === null && filterCriteria.maxDurationSec === null) {
    return true;
  }

  // 2) Missing duration cannot satisfy an active duration filter.
  if (videoMetadata.durationSec === null) {
    return false;
  }

  const durationSec = videoMetadata.durationSec;

  // 3) Inclusive minimum length.
  if (filterCriteria.minDurationSec !== null && durationSec < filterCriteria.minDurationSec) {
    return false;
  }

  // 4) Inclusive maximum length.
  if (filterCriteria.maxDurationSec !== null && durationSec > filterCriteria.maxDurationSec) {
    return false;
  }

  return true;
};

export const parseDurationSecondsToken = (rawToken: string): number => {
  // Accept whole non-negative seconds only (e.g. 90, 0, 3600).
  const trimmedToken = rawToken.trim();
  if (!/^\d+$/.test(trimmedToken)) {
    throw new Error(`Invalid duration seconds "${rawToken}" (use whole non-negative seconds)`);
  }
  return Number.parseInt(trimmedToken, 10);
};
