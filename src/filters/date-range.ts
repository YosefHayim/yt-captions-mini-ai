import { VideoFilterCriteria, YoutubeVideoMetadata } from '../types.js';

const DAY_MS = 86_400_000;
const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const utcDayStartMs = (isoDay: string): number | null => {
  // Parse YYYY-MM-DD as UTC midnight.
  const dayMatch = ISO_DAY_PATTERN.exec(isoDay.trim());
  if (!dayMatch) {
    return null;
  }
  const year = Number.parseInt(dayMatch[1], 10);
  const monthIndex = Number.parseInt(dayMatch[2], 10) - 1;
  const dayOfMonth = Number.parseInt(dayMatch[3], 10);
  const startMs = Date.UTC(year, monthIndex, dayOfMonth);
  if (!Number.isFinite(startMs)) {
    return null;
  }
  return startMs;
};

const publishedDayStartMs = (publishedAtIso: string): number | null => {
  const publishedMs = Date.parse(publishedAtIso);
  if (!Number.isFinite(publishedMs)) {
    return null;
  }
  const publishedDate = new Date(publishedMs);
  return Date.UTC(
    publishedDate.getUTCFullYear(),
    publishedDate.getUTCMonth(),
    publishedDate.getUTCDate(),
  );
};

export const videoPassesDateRangeFilter = (
  videoMetadata: YoutubeVideoMetadata,
  filterCriteria: VideoFilterCriteria,
): boolean => {
  // 1) No date bounds configured → pass.
  if (!filterCriteria.sinceDate && !filterCriteria.untilDate) {
    return true;
  }

  // 2) Missing publish metadata cannot satisfy an active date filter.
  if (!videoMetadata.publishedAtIso) {
    return false;
  }
  const videoDayStartMs = publishedDayStartMs(videoMetadata.publishedAtIso);
  if (videoDayStartMs === null) {
    return false;
  }

  // 3) Inclusive since (publish day >= since day).
  if (filterCriteria.sinceDate) {
    const sinceStartMs = utcDayStartMs(filterCriteria.sinceDate);
    if (sinceStartMs === null || videoDayStartMs < sinceStartMs) {
      return false;
    }
  }

  // 4) Inclusive until (publish day <= until day).
  if (filterCriteria.untilDate) {
    const untilStartMs = utcDayStartMs(filterCriteria.untilDate);
    if (untilStartMs === null || videoDayStartMs > untilStartMs) {
      return false;
    }
  }

  return true;
};

// Exported for tests / CLI validation of YYYY-MM-DD.
export const isIsoCalendarDay = (dayToken: string): boolean => utcDayStartMs(dayToken) !== null;

// Keep DAY_MS available if callers need end-of-day math later.
export const utcDayEndExclusiveMs = (isoDay: string): number | null => {
  const startMs = utcDayStartMs(isoDay);
  return startMs === null ? null : startMs + DAY_MS;
};
