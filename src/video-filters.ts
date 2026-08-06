import { CliOptions, VideoFilterCriteria, YoutubeVideoMetadata } from './types.js';
import { fetchYoutubeVideoMetadata } from './video-metadata.js';
import { videoPassesDateRangeFilter } from './filters/date-range.js';
import { videoPassesDurationFilter } from './filters/duration.js';
import { videoPassesTitleFilter } from './filters/title.js';
import { logInfo, logWarn } from './log.js';
import { CONSTANTS } from './constants.js';

const { CLIENT_ATTEMPT_DELAY_MS } = CONSTANTS.shared;

const LOG_FILTER_SKIP = 'filter skip';
const LOG_FILTER_KEEP = 'filter keep';
const LOG_FILTER_META_FAIL = 'filter metadata failed';
const LOG_FILTER_SUMMARY = 'filter kept';

export const criteriaFromCliOptions = (options: CliOptions): VideoFilterCriteria => ({
  sinceDate: options.filterSinceDate,
  untilDate: options.filterUntilDate,
  minDurationSec: options.filterMinDurationSec,
  maxDurationSec: options.filterMaxDurationSec,
  titleIncludes: options.filterTitleIncludes,
  titleExcludes: options.filterTitleExcludes,
});

export const hasActiveVideoFilters = (filterCriteria: VideoFilterCriteria): boolean =>
  Boolean(
    filterCriteria.sinceDate
    || filterCriteria.untilDate
    || filterCriteria.minDurationSec !== null
    || filterCriteria.maxDurationSec !== null
    || filterCriteria.titleIncludes.length > 0
    || filterCriteria.titleExcludes.length > 0,
  );

export const videoPassesAllFilters = (
  videoMetadata: YoutubeVideoMetadata,
  filterCriteria: VideoFilterCriteria,
): boolean => {
  // AND-combine date, duration, and title gates.
  if (!videoPassesDateRangeFilter(videoMetadata, filterCriteria)) {
    return false;
  }
  if (!videoPassesDurationFilter(videoMetadata, filterCriteria)) {
    return false;
  }
  if (!videoPassesTitleFilter(videoMetadata, filterCriteria)) {
    return false;
  }
  return true;
};

const sleepBriefly = (delayMs: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });

const describeSkipReason = (
  videoMetadata: YoutubeVideoMetadata,
  filterCriteria: VideoFilterCriteria,
): string => {
  if (!videoPassesDateRangeFilter(videoMetadata, filterCriteria)) {
    return `date publishedAt=${videoMetadata.publishedAtIso ?? 'unknown'}`;
  }
  if (!videoPassesDurationFilter(videoMetadata, filterCriteria)) {
    return `durationSec=${videoMetadata.durationSec ?? 'unknown'}`;
  }
  if (!videoPassesTitleFilter(videoMetadata, filterCriteria)) {
    return `title="${videoMetadata.title}"`;
  }
  return 'unknown';
};

export const filterVideoIdsByCriteria = async (
  videoIds: string[],
  filterCriteria: VideoFilterCriteria,
): Promise<string[]> => {
  // 1) Fast path when no bulk filters are set.
  if (!hasActiveVideoFilters(filterCriteria)) {
    return videoIds;
  }

  // 2) Fetch metadata per id and keep only ids that pass every gate.
  const keptVideoIds: string[] = [];
  for (const videoId of videoIds) {
    try {
      const videoMetadata = await fetchYoutubeVideoMetadata(videoId);
      if (videoPassesAllFilters(videoMetadata, filterCriteria)) {
        keptVideoIds.push(videoId);
        logInfo(
          `${LOG_FILTER_KEEP} ${videoId} title="${videoMetadata.title}" duration=${videoMetadata.durationSec ?? '?'}s published=${videoMetadata.publishedAtIso ?? '?'}`,
        );
      } else {
        logWarn(
          `${LOG_FILTER_SKIP} ${videoId}: ${describeSkipReason(videoMetadata, filterCriteria)}`,
        );
      }
    } catch (metadataError) {
      logWarn(`${LOG_FILTER_META_FAIL} ${videoId}: ${String(metadataError)}`);
    }
    await sleepBriefly(CLIENT_ATTEMPT_DELAY_MS);
  }

  // 3) Summary for bulk runs.
  logInfo(`${LOG_FILTER_SUMMARY} ${keptVideoIds.length}/${videoIds.length}`);
  return keptVideoIds;
};
