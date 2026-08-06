import { Effect, Schema } from 'effect';
import { fetchJsonResource, fetchTextResourceOptional } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { ChannelTabKind } from './types.js';

import { CONSTANTS } from './constants.js';

const {
  YOUTUBE_BASE_URL: YOUTUBE_ORIGIN,
  YOUTUBE_INITIAL_DATA_MARKER,
  YOUTUBE_PRETTY_PRINT_QUERY,
  DEFAULT_WEB_API_KEY,
  WEB_CLIENT_NAME,
  BROWSER_USER_AGENT,
  DEFAULT_LANGUAGE: LANGUAGE_FALLBACK,
  DEFAULT_REGION: REGION_FALLBACK,
  VIDEO_ID_PATTERN,
  CLIENT_ATTEMPT_DELAY_MS: CONTINUATION_DELAY_MS,
} = CONSTANTS.shared;
const {
  CONTENT_TYPE_HEADER,
  CONTENT_TYPE_JSON,
  USER_AGENT_HEADER,
  ACCEPT_HEADER,
  ACCEPT_ALL,
  HTTP_METHOD_POST,
} = CONSTANTS.http;
const {
  YOUTUBE_BROWSE_API_PATH,
  DEFAULT_WEB_CLIENT_VERSION,
  WEB_CLIENT_ID,
  CHANNEL_HANDLE_PATTERN,
  CHANNEL_ID_PATH_PATTERN,
  CHANNEL_CUSTOM_PATH_PATTERN,
  CHANNEL_AT_PREFIX,
  CHANNEL_VIDEOS_TAB: CHANNEL_VIDEOS_TAB_TOKEN,
  CHANNEL_SHORTS_TAB: CHANNEL_SHORTS_TAB_TOKEN,
  CHANNEL_BULK_FOLDER_PREFIX_VIDEOS,
  CHANNEL_BULK_FOLDER_PREFIX_SHORTS,
  FOLDER_UNSAFE_PATTERN,
  MAX_CONTINUATION_PAGES,
  API_KEY_PATTERN,
  CLIENT_VERSION_PATTERN,
  VISITOR_DATA_PATTERN,
} = CONSTANTS.channel;
const CHANNEL_VIDEOS_TAB: ChannelTabKind = CHANNEL_VIDEOS_TAB_TOKEN;
const CHANNEL_SHORTS_TAB: ChannelTabKind = CHANNEL_SHORTS_TAB_TOKEN;

// Watch endpoint that carries a channel grid video id.
const channelWatchEndpointSchema = Schema.Struct({
  // Nested watch endpoint with a resolvable video id.
  watchEndpoint: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  }),
});

// Shorts reel watch endpoint used on /shorts tab grids.
const channelReelWatchEndpointSchema = Schema.Struct({
  // Nested reel watch endpoint with a resolvable video id.
  reelWatchEndpoint: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  }),
});

// Compact video renderer used on some channel layouts.
const channelVideoRendererSchema = Schema.Struct({
  // Compact/grid video renderer with a video id.
  videoRenderer: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  }),
});

// Grid video renderer used on older channel layouts.
const channelGridVideoRendererSchema = Schema.Struct({
  // Grid video renderer with a video id.
  gridVideoRenderer: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  }),
});

// Reel/shorts-style item that still exposes a video id.
const channelReelItemRendererSchema = Schema.Struct({
  // Reel item renderer with a video id.
  reelItemRenderer: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  }),
});

// Continuation token wrapper used for browse pagination.
const continuationCommandSchema = Schema.Struct({
  // Continuation command with opaque browse token.
  continuationCommand: Schema.Struct({
    // Opaque continuation token for youtubei/browse.
    token: Schema.String,
  }),
});

// Generic object for recursive channel tree walks.
const dynamicObjectSchema = Schema.Record({
  // Object property name.
  key: Schema.String,
  // Nested channel payload value.
  value: Schema.Unknown,
});

const decodeWatchEndpoint = Schema.decodeUnknown(channelWatchEndpointSchema);
const decodeReelWatchEndpoint = Schema.decodeUnknown(channelReelWatchEndpointSchema);
const decodeVideoRenderer = Schema.decodeUnknown(channelVideoRendererSchema);
const decodeGridVideoRenderer = Schema.decodeUnknown(channelGridVideoRendererSchema);
const decodeReelItemRenderer = Schema.decodeUnknown(channelReelItemRendererSchema);
const decodeContinuationCommand = Schema.decodeUnknown(continuationCommandSchema);
const decodeDynamicObject = Schema.decodeUnknown(dynamicObjectSchema);

const sleepBriefly = (delayMs: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });

const asChannelObject = (channelNode: unknown): Record<string, unknown> | null => {
  try {
    return Effect.runSync(decodeDynamicObject(channelNode));
  } catch {
    return null;
  }
};

const readVideoIdFromChannelNode = (channelNode: unknown): string | null => {
  try {
    return Effect.runSync(decodeVideoRenderer(channelNode)).videoRenderer.videoId;
  } catch {
    // continue
  }
  try {
    return Effect.runSync(decodeGridVideoRenderer(channelNode)).gridVideoRenderer.videoId;
  } catch {
    // continue
  }
  try {
    return Effect.runSync(decodeReelItemRenderer(channelNode)).reelItemRenderer.videoId;
  } catch {
    // continue
  }
  try {
    return Effect.runSync(decodeReelWatchEndpoint(channelNode)).reelWatchEndpoint.videoId;
  } catch {
    // continue
  }
  try {
    return Effect.runSync(decodeWatchEndpoint(channelNode)).watchEndpoint.videoId;
  } catch {
    return null;
  }
};

const readContinuationToken = (channelNode: unknown): string | null => {
  try {
    return Effect.runSync(decodeContinuationCommand(channelNode)).continuationCommand.token;
  } catch {
    return null;
  }
};

const pushUniqueVideoId = (
  videoId: string | null,
  seenVideoIds: Set<string>,
  videoIds: string[],
): void => {
  if (!videoId || seenVideoIds.has(videoId)) {
    return;
  }
  seenVideoIds.add(videoId);
  videoIds.push(videoId);
};

const pushUniqueContinuationToken = (
  continuationToken: string | null,
  seenContinuationTokens: Set<string>,
  continuationTokens: string[],
): void => {
  if (!continuationToken || seenContinuationTokens.has(continuationToken)) {
    return;
  }
  seenContinuationTokens.add(continuationToken);
  continuationTokens.push(continuationToken);
};

export const collectChannelVideoIdsAndContinuations = (
  channelRoot: unknown,
  videoIds: string[],
  continuationTokens: string[],
): void => {
  // Walk channel ytInitialData / browse payloads for video ids + continuation tokens.
  const seenVideoIds = new Set(videoIds);
  const seenContinuationTokens = new Set(continuationTokens);

  const visitChannelNode = (channelNode: unknown): void => {
    if (Array.isArray(channelNode)) {
      for (const nestedNode of channelNode) {
        visitChannelNode(nestedNode);
      }
      return;
    }

    const channelObject = asChannelObject(channelNode);
    if (!channelObject) {
      return;
    }

    pushUniqueVideoId(readVideoIdFromChannelNode(channelObject), seenVideoIds, videoIds);
    pushUniqueContinuationToken(
      readContinuationToken(channelObject),
      seenContinuationTokens,
      continuationTokens,
    );

    for (const nestedNode of Object.values(channelObject)) {
      visitChannelNode(nestedNode);
    }
  };

  visitChannelNode(channelRoot);
};

export const isYoutubeChannelUrl = (sourceUrl: string): boolean => {
  // Accept @handle, /channel/UC…, /c/…, and /user/… channel URLs (any tab).
  return (
    CHANNEL_HANDLE_PATTERN.test(sourceUrl)
    || CHANNEL_ID_PATH_PATTERN.test(sourceUrl)
    || CHANNEL_CUSTOM_PATH_PATTERN.test(sourceUrl)
  );
};

export const resolveChannelTabKind = (sourceUrl: string): ChannelTabKind => {
  // Prefer explicit /shorts path; default bulk channel scrape uses Videos tab.
  const loweredUrl = sourceUrl.toLowerCase();
  if (loweredUrl.includes('/shorts')) {
    return CHANNEL_SHORTS_TAB;
  }
  return CHANNEL_VIDEOS_TAB;
};

const buildChannelBasePath = (sourceUrl: string): string | null => {
  // Build origin + channel root without a tab suffix.
  const handleMatch = CHANNEL_HANDLE_PATTERN.exec(sourceUrl);
  if (handleMatch) {
    return `${YOUTUBE_ORIGIN}/${CHANNEL_AT_PREFIX}${handleMatch[1]}`;
  }
  const channelIdMatch = CHANNEL_ID_PATH_PATTERN.exec(sourceUrl);
  if (channelIdMatch) {
    return `${YOUTUBE_ORIGIN}/channel/${channelIdMatch[1]}`;
  }
  const customMatch = CHANNEL_CUSTOM_PATH_PATTERN.exec(sourceUrl);
  if (customMatch) {
    const customPathToken = customMatch[1];
    const pathPrefix = sourceUrl.toLowerCase().includes('/user/') ? 'user' : 'c';
    return `${YOUTUBE_ORIGIN}/${pathPrefix}/${customPathToken}`;
  }
  return null;
};

export const normalizeChannelTabUrl = (
  sourceUrl: string,
  channelTabKind: ChannelTabKind = resolveChannelTabKind(sourceUrl),
): string => {
  // Force Videos or Shorts tab for bulk discovery.
  const channelBasePath = buildChannelBasePath(sourceUrl);
  if (!channelBasePath) {
    return sourceUrl;
  }
  return `${channelBasePath}/${channelTabKind}`;
};

export const getChannelLabel = (channelSourceUrl: string): string => {
  // Compact label for logs (handle or channel id).
  const handleMatch = CHANNEL_HANDLE_PATTERN.exec(channelSourceUrl);
  if (handleMatch) {
    return `${CHANNEL_AT_PREFIX}${handleMatch[1]}`;
  }
  const channelIdMatch = CHANNEL_ID_PATH_PATTERN.exec(channelSourceUrl);
  if (channelIdMatch) {
    return channelIdMatch[1];
  }
  const customMatch = CHANNEL_CUSTOM_PATH_PATTERN.exec(channelSourceUrl);
  if (customMatch) {
    return customMatch[1];
  }
  return channelSourceUrl;
};

export const getChannelBulkFolderName = (
  channelSourceUrl: string,
  channelTabKind: ChannelTabKind = resolveChannelTabKind(channelSourceUrl),
): string => {
  // scraped-yt/channel-<name> or scraped-yt/shorts-<name>
  const channelLabel = getChannelLabel(channelSourceUrl);
  const folderSlug = channelLabel
    .replace(/^@/, '')
    .replace(FOLDER_UNSAFE_PATTERN, '_')
    .replace(/^_+|_+$/g, '');
  const safeSlug = folderSlug.length > 0 ? folderSlug : 'unknown';
  if (channelTabKind === CHANNEL_SHORTS_TAB) {
    return `${CHANNEL_BULK_FOLDER_PREFIX_SHORTS}${safeSlug}`;
  }
  return `${CHANNEL_BULK_FOLDER_PREFIX_VIDEOS}${safeSlug}`;
};

const readInnertubeApiKey = (pageHtml: string): string => {
  const apiKeyMatch = API_KEY_PATTERN.exec(pageHtml);
  return apiKeyMatch?.[1] ?? DEFAULT_WEB_API_KEY;
};

const readClientVersion = (pageHtml: string): string => {
  const clientVersionMatch = CLIENT_VERSION_PATTERN.exec(pageHtml);
  return clientVersionMatch?.[1] ?? DEFAULT_WEB_CLIENT_VERSION;
};

const readVisitorData = (pageHtml: string): string | null => {
  const visitorDataMatch = VISITOR_DATA_PATTERN.exec(pageHtml);
  return visitorDataMatch?.[1] ?? null;
};

const createBrowseContext = (clientVersion: string, visitorData: string | null) => {
  const clientContext: Record<string, unknown> = {
    hl: LANGUAGE_FALLBACK,
    gl: REGION_FALLBACK,
    clientName: WEB_CLIENT_NAME,
    clientVersion,
    userAgent: BROWSER_USER_AGENT,
  };
  if (visitorData) {
    clientContext.visitorData = visitorData;
  }
  return {
    client: clientContext,
    user: {
      lockedSafetyMode: false,
    },
    request: {
      useSsl: true,
    },
  };
};

const createBrowseApiUrl = (apiKey: string): string => {
  const encodedKey = encodeURIComponent(apiKey);
  return `${YOUTUBE_ORIGIN}${YOUTUBE_BROWSE_API_PATH}?key=${encodedKey}&${YOUTUBE_PRETTY_PRINT_QUERY}`;
};

const fetchBrowseContinuation = async (
  continuationToken: string,
  apiKey: string,
  clientVersion: string,
  visitorData: string | null,
  channelTabUrl: string,
): Promise<unknown> => {
  // POST youtubei/browse with the continuation token to page more channel/shorts items.
  const browseUrl = createBrowseApiUrl(apiKey);
  const browseBody = {
    context: createBrowseContext(clientVersion, visitorData),
    continuation: continuationToken,
  };
  return fetchJsonResource<unknown>(browseUrl, browseBody, {
    method: HTTP_METHOD_POST,
    headers: {
      [CONTENT_TYPE_HEADER]: CONTENT_TYPE_JSON,
      Origin: YOUTUBE_ORIGIN,
      Referer: channelTabUrl,
      [USER_AGENT_HEADER]: BROWSER_USER_AGENT,
      [ACCEPT_HEADER]: ACCEPT_ALL,
      'X-Youtube-Client-Name': WEB_CLIENT_ID,
      'X-Youtube-Client-Version': clientVersion,
    },
  });
};

export const fetchChannelTabVideoIds = async (
  channelSourceUrl: string,
  channelTabKind: ChannelTabKind = resolveChannelTabKind(channelSourceUrl),
): Promise<string[]> => {
  // 1) Normalize to Videos or Shorts tab and soft-fetch the tab HTML.
  const channelTabUrl = normalizeChannelTabUrl(channelSourceUrl, channelTabKind);
  const channelPage = await fetchTextResourceOptional(channelTabUrl);
  if (!channelPage) {
    throw new Error(`Could not fetch channel ${channelTabKind} page: ${channelTabUrl}`);
  }

  // 2) Parse ytInitialData for first-page video ids + continuation tokens.
  const channelState = extractEmbeddedJson(channelPage.bodyText, YOUTUBE_INITIAL_DATA_MARKER);
  if (!channelState) {
    throw new Error(`Could not find ytInitialData for channel ${channelTabKind}: ${channelTabUrl}`);
  }

  const videoIds: string[] = [];
  const continuationTokens: string[] = [];
  collectChannelVideoIdsAndContinuations(channelState, videoIds, continuationTokens);

  // 3) Page through browse continuations until exhausted or cap is hit.
  const apiKey = readInnertubeApiKey(channelPage.bodyText);
  const clientVersion = readClientVersion(channelPage.bodyText);
  const visitorData = readVisitorData(channelPage.bodyText);
  const pendingContinuationTokens = [...continuationTokens];
  const seenContinuationTokens = new Set(continuationTokens);
  let continuationPageCount = 0;

  while (
    pendingContinuationTokens.length > 0
    && continuationPageCount < MAX_CONTINUATION_PAGES
  ) {
    const continuationToken = pendingContinuationTokens.shift();
    if (!continuationToken) {
      break;
    }

    try {
      const browsePayload = await fetchBrowseContinuation(
        continuationToken,
        apiKey,
        clientVersion,
        visitorData,
        channelTabUrl,
      );
      const nextContinuationTokens: string[] = [];
      collectChannelVideoIdsAndContinuations(browsePayload, videoIds, nextContinuationTokens);
      for (const nextContinuationToken of nextContinuationTokens) {
        if (!seenContinuationTokens.has(nextContinuationToken)) {
          seenContinuationTokens.add(nextContinuationToken);
          pendingContinuationTokens.push(nextContinuationToken);
        }
      }
    } catch {
      // Stop paging this token chain; keep videos already collected.
      break;
    }

    continuationPageCount += 1;
    await sleepBriefly(CONTINUATION_DELAY_MS);
  }

  // 4) Return ordered unique video ids discovered for this tab.
  return videoIds;
};

