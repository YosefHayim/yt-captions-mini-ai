import { Effect, Schema } from 'effect';
import { fetchJsonResource, fetchTextResourceOptional } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { YoutubeVideoMetadata } from './types.js';
import { CONSTANTS } from './constants.js';

const {
  WATCH_QUERY_PREFIX,
  DEFAULT_WEB_API_KEY,
  BROWSER_USER_AGENT,
  DEFAULT_LANGUAGE,
  DEFAULT_REGION,
  YOUTUBE_WWW_HOST,
  YOUTUBE_PRETTY_PRINT_QUERY,
  YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER,
} = CONSTANTS.shared;

const PLAYER_API_PATH = '/youtubei/v1/player';
const EMPTY_TITLE = '';
const DEFAULT_ANDROID_API_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';

type MetadataClientProfile = {
  profileLabel: string;
  clientName: string;
  clientId: string;
  clientVersion: string;
  apiKey: string;
  userAgent: string;
  extraClientFields: Record<string, string | number>;
};

const METADATA_CLIENT_PROFILES: MetadataClientProfile[] = [
  {
    profileLabel: 'android',
    clientName: 'ANDROID',
    clientId: '3',
    clientVersion: '20.10.38',
    apiKey: DEFAULT_ANDROID_API_KEY,
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    extraClientFields: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
  },
  {
    profileLabel: 'android_vr',
    clientName: 'ANDROID_VR',
    clientId: '28',
    clientVersion: '1.65.10',
    apiKey: DEFAULT_ANDROID_API_KEY,
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extraClientFields: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
    },
  },
  {
    profileLabel: 'tv',
    clientName: 'TVHTML5',
    clientId: '7',
    clientVersion: '7.20250923.13.00',
    apiKey: DEFAULT_WEB_API_KEY,
    userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    extraClientFields: {},
  },
  {
    profileLabel: 'mweb',
    clientName: 'MWEB',
    clientId: '2',
    clientVersion: '2.20250925.01.00',
    apiKey: DEFAULT_WEB_API_KEY,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    extraClientFields: {},
  },
  {
    profileLabel: 'web',
    clientName: 'WEB',
    clientId: '1',
    clientVersion: '2.20250925.01.00',
    apiKey: DEFAULT_WEB_API_KEY,
    userAgent: BROWSER_USER_AGENT,
    extraClientFields: {},
  },
];

const videoDetailsSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  lengthSeconds: Schema.optional(Schema.String),
  publishDate: Schema.optional(Schema.String),
});

const microformatSchema = Schema.Struct({
  playerMicroformatRenderer: Schema.optional(
    Schema.Struct({
      publishDate: Schema.optional(Schema.String),
      uploadDate: Schema.optional(Schema.String),
      title: Schema.optional(
        Schema.Struct({
          simpleText: Schema.optional(Schema.String),
        }),
      ),
      lengthSeconds: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
    }),
  ),
});

const playerMetadataPayloadSchema = Schema.Struct({
  videoDetails: Schema.optional(videoDetailsSchema),
  microformat: Schema.optional(microformatSchema),
  playabilityStatus: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.String),
    }),
  ),
});

const oembedSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
});

const decodePlayerMetadataPayload = Schema.decodeUnknown(playerMetadataPayloadSchema);
const decodeOembed = Schema.decodeUnknown(oembedSchema);

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
  const parsedMs = Date.parse(rawDate);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
};

const emptyMetadata = (videoId: string): YoutubeVideoMetadata => ({
  videoId,
  title: EMPTY_TITLE,
  publishedAtIso: null,
  durationSec: null,
});

const mergeMetadata = (
  baseMetadata: YoutubeVideoMetadata,
  nextMetadata: Partial<YoutubeVideoMetadata>,
): YoutubeVideoMetadata => ({
  videoId: baseMetadata.videoId,
  title:
    nextMetadata.title && nextMetadata.title.trim().length > 0
      ? nextMetadata.title.trim()
      : baseMetadata.title,
  publishedAtIso: nextMetadata.publishedAtIso ?? baseMetadata.publishedAtIso,
  durationSec: nextMetadata.durationSec ?? baseMetadata.durationSec,
});

const metadataFromPlayerPayload = (
  videoId: string,
  playerPayload: unknown,
): YoutubeVideoMetadata | null => {
  try {
    const decodedPayload = Effect.runSync(decodePlayerMetadataPayload(playerPayload));
    if (decodedPayload.playabilityStatus?.status === 'LOGIN_REQUIRED') {
      return null;
    }
    if (!decodedPayload.videoDetails && !decodedPayload.microformat) {
      return null;
    }
    const videoDetails = decodedPayload.videoDetails;
    const microformat = decodedPayload.microformat?.playerMicroformatRenderer;
    const titleFromDetails = videoDetails?.title?.trim() ?? EMPTY_TITLE;
    const titleFromMicro = microformat?.title?.simpleText?.trim() ?? EMPTY_TITLE;
    const title = titleFromDetails.length > 0 ? titleFromDetails : titleFromMicro;
    const durationSec =
      parseDurationSeconds(videoDetails?.lengthSeconds)
      ?? parseDurationSeconds(microformat?.lengthSeconds);
    const publishedAtIso =
      parsePublishedAtIso(microformat?.publishDate)
      ?? parsePublishedAtIso(microformat?.uploadDate)
      ?? parsePublishedAtIso(videoDetails?.publishDate);
    return { videoId, title, publishedAtIso, durationSec };
  } catch {
    return null;
  }
};

const fetchOembedTitle = async (videoId: string): Promise<string> => {
  // Public oembed title (no API key); works when player is LOGIN_REQUIRED.
  const oembedUrl = `https://${YOUTUBE_WWW_HOST}/oembed?url=${encodeURIComponent(`${WATCH_QUERY_PREFIX}${videoId}`)}&format=json`;
  const oembedResponse = await fetchTextResourceOptional(oembedUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': BROWSER_USER_AGENT,
    },
  });
  if (!oembedResponse) {
    return EMPTY_TITLE;
  }
  try {
    const parsedJson = JSON.parse(oembedResponse.bodyText) as unknown;
    const decodedOembed = Effect.runSync(decodeOembed(parsedJson));
    return decodedOembed.title?.trim() ?? EMPTY_TITLE;
  } catch {
    return EMPTY_TITLE;
  }
};

const fetchPlayerMetadataWithClients = async (videoId: string): Promise<YoutubeVideoMetadata | null> => {
  for (const clientProfile of METADATA_CLIENT_PROFILES) {
    try {
      const requestUrl = `https://${YOUTUBE_WWW_HOST}${PLAYER_API_PATH}?key=${encodeURIComponent(clientProfile.apiKey)}&${YOUTUBE_PRETTY_PRINT_QUERY}`;
      const requestBody = {
        context: {
          client: {
            hl: DEFAULT_LANGUAGE,
            gl: DEFAULT_REGION,
            clientName: clientProfile.clientName,
            clientVersion: clientProfile.clientVersion,
            userAgent: clientProfile.userAgent,
            ...clientProfile.extraClientFields,
          },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      };
      const playerPayload = await fetchJsonResource<unknown>(requestUrl, requestBody, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `https://${YOUTUBE_WWW_HOST}`,
          Referer: `${WATCH_QUERY_PREFIX}${videoId}`,
          'User-Agent': clientProfile.userAgent,
          Accept: '*/*',
          'X-Youtube-Client-Name': clientProfile.clientId,
          'X-Youtube-Client-Version': clientProfile.clientVersion,
        },
      });
      const clientMetadata = metadataFromPlayerPayload(videoId, playerPayload);
      if (clientMetadata) {
        return clientMetadata;
      }
    } catch {
      // try next client
    }
  }
  return null;
};

const fetchWatchPageMetadata = async (videoId: string): Promise<YoutubeVideoMetadata | null> => {
  const watchPage = await fetchTextResourceOptional(`${WATCH_QUERY_PREFIX}${videoId}`);
  if (!watchPage) {
    return null;
  }
  try {
    const playerPayload = extractEmbeddedJson(watchPage.bodyText, YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER);
    if (!playerPayload) {
      return null;
    }
    return metadataFromPlayerPayload(videoId, playerPayload);
  } catch {
    return null;
  }
};

export const fetchYoutubeVideoMetadata = async (videoId: string): Promise<YoutubeVideoMetadata> => {
  // 1) Start empty; fill from best available public sources.
  let videoMetadata = emptyMetadata(videoId);

  // 2) oembed title (reliable when player is LOGIN_REQUIRED).
  const oembedTitle = await fetchOembedTitle(videoId);
  videoMetadata = mergeMetadata(videoMetadata, { title: oembedTitle });

  // 3) Multi-client player for duration + publish date when YouTube allows it.
  const playerMetadata = await fetchPlayerMetadataWithClients(videoId);
  if (playerMetadata) {
    videoMetadata = mergeMetadata(videoMetadata, playerMetadata);
  }

  // 4) Watch HTML ytInitialPlayerResponse when still missing duration/date.
  if (videoMetadata.durationSec === null || videoMetadata.publishedAtIso === null) {
    const watchMetadata = await fetchWatchPageMetadata(videoId);
    if (watchMetadata) {
      videoMetadata = mergeMetadata(videoMetadata, watchMetadata);
    }
  }

  return videoMetadata;
};
