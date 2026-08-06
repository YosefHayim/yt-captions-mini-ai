import { Effect, Schema } from 'effect';
import { fetchJsonResource } from './http.js';
import { YoutubeVideoMetadata } from './types.js';
import { CONSTANTS } from './constants.js';

const {
  WATCH_QUERY_PREFIX,
  DEFAULT_WEB_API_KEY,
  WEB_CLIENT_NAME,
  BROWSER_USER_AGENT,
  DEFAULT_LANGUAGE,
  DEFAULT_REGION,
  YOUTUBE_WWW_HOST,
  YOUTUBE_PRETTY_PRINT_QUERY,
} = CONSTANTS.shared;

const PLAYER_API_PATH = '/youtubei/v1/player';
const WEB_CLIENT_VERSION = '2.20250925.01.00';
const WEB_CLIENT_ID = '1';
const EMPTY_TITLE = '';

// Minimal player payload slice for title / length / publish time.
const videoDetailsSchema = Schema.Struct({
  // Display title.
  title: Schema.optional(Schema.String),
  // Length as decimal string seconds (YouTube convention).
  lengthSeconds: Schema.optional(Schema.String),
  // Sometimes present as number-like string publish epoch or ISO fragment.
  publishDate: Schema.optional(Schema.String),
});

const microformatSchema = Schema.Struct({
  playerMicroformatRenderer: Schema.optional(
    Schema.Struct({
      // ISO publish date when available.
      publishDate: Schema.optional(Schema.String),
      // ISO upload date fallback.
      uploadDate: Schema.optional(Schema.String),
      // Human title fallback.
      title: Schema.optional(
        Schema.Struct({
          simpleText: Schema.optional(Schema.String),
        }),
      ),
      // Length seconds as number in some clients.
      lengthSeconds: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
    }),
  ),
});

const playerMetadataPayloadSchema = Schema.Struct({
  videoDetails: Schema.optional(videoDetailsSchema),
  microformat: Schema.optional(microformatSchema),
});

const decodePlayerMetadataPayload = Schema.decodeUnknown(playerMetadataPayloadSchema);

const parseDurationSeconds = (rawDuration: string | number | undefined): number | null => {
  if (rawDuration === undefined) {
    return null;
  }
  if (typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0) {
    return Math.floor(rawDuration);
  }
  const parsedDuration = Number.parseInt(String(rawDuration), 10);
  if (!Number.isFinite(parsedDuration) || parsedDuration < 0) {
    return null;
  }
  return parsedDuration;
};

const parsePublishedAtIso = (rawDate: string | undefined): string | null => {
  if (!rawDate || rawDate.trim().length === 0) {
    return null;
  }
  // YouTube often returns YYYY-MM-DD; Date.parse accepts that as UTC midnight in modern engines.
  const parsedMs = Date.parse(rawDate);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
};

const createPlayerMetadataRequest = (videoId: string) => ({
  context: {
    client: {
      hl: DEFAULT_LANGUAGE,
      gl: DEFAULT_REGION,
      clientName: WEB_CLIENT_NAME,
      clientVersion: WEB_CLIENT_VERSION,
      userAgent: BROWSER_USER_AGENT,
    },
  },
  videoId,
  contentCheckOk: true,
  racyCheckOk: true,
});

export const fetchYoutubeVideoMetadata = async (videoId: string): Promise<YoutubeVideoMetadata> => {
  // 1) Call WEB player endpoint for public metadata (title, length, publish date).
  const requestUrl = `https://${YOUTUBE_WWW_HOST}${PLAYER_API_PATH}?key=${encodeURIComponent(DEFAULT_WEB_API_KEY)}&${YOUTUBE_PRETTY_PRINT_QUERY}`;
  const playerPayload = await fetchJsonResource<unknown>(requestUrl, createPlayerMetadataRequest(videoId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `https://${YOUTUBE_WWW_HOST}`,
      Referer: `${WATCH_QUERY_PREFIX}${videoId}`,
      'User-Agent': BROWSER_USER_AGENT,
      Accept: '*/*',
      'X-Youtube-Client-Name': WEB_CLIENT_ID,
      'X-Youtube-Client-Version': WEB_CLIENT_VERSION,
    },
  });

  // 2) Decode with Effect Schema; empty defaults when fields are missing.
  let decodedPayload: Schema.Schema.Type<typeof playerMetadataPayloadSchema>;
  try {
    decodedPayload = Effect.runSync(decodePlayerMetadataPayload(playerPayload));
  } catch {
    return {
      videoId,
      title: EMPTY_TITLE,
      publishedAtIso: null,
      durationSec: null,
    };
  }

  const videoDetails = decodedPayload.videoDetails;
  const microformat = decodedPayload.microformat?.playerMicroformatRenderer;
  const titleFromDetails = videoDetails?.title?.trim() ?? EMPTY_TITLE;
  const titleFromMicro =
    microformat?.title?.simpleText?.trim() ?? EMPTY_TITLE;
  const title = titleFromDetails.length > 0 ? titleFromDetails : titleFromMicro;

  const durationSec =
    parseDurationSeconds(videoDetails?.lengthSeconds)
    ?? parseDurationSeconds(microformat?.lengthSeconds);

  const publishedAtIso =
    parsePublishedAtIso(microformat?.publishDate)
    ?? parsePublishedAtIso(microformat?.uploadDate)
    ?? parsePublishedAtIso(videoDetails?.publishDate);

  return {
    videoId,
    title,
    publishedAtIso,
    durationSec,
  };
};
