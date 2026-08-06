import { Effect, Schema } from 'effect';
import { SubtitleFormat, YoutubeCaptionTrack } from './types.js';

import { CONSTANTS } from './constants.js';

const { YOUTUBE_BASE_URL: YOUTUBE_WEB_HOST } = CONSTANTS.shared;
const {
  TRACK_KIND_AUTO,
  TRACK_KIND_MANUAL,
  LANGUAGE_TOKEN_WILDCARD,
  FALLBACK_LANGUAGE_TAG,
  VSS_ID_LEADING_DOT,
  VSS_ID_DOT_REPLACER,
  CAPTION_FORMAT_QUERY_PARAM,
  AUTO_LANGUAGE_PREFIX,
} = CONSTANTS.captions;
const EMPTY_CAPTION_TRACKS = [] as const;

// One normalized caption track node inside captionsTracklistRenderer.
const captionTrackNodeSchema = Schema.Struct({
  // Direct URL used to download a subtitle format for this caption track.
  baseUrl: Schema.String,
  // Optional track kind metadata; YouTube marks autosubs as "asr".
  kind: Schema.optional(Schema.String),
  // Optional legacy track language marker used in older payloads.
  vssId: Schema.optional(Schema.String),
  // Optional language code exposed by modern payloads.
  languageCode: Schema.optional(Schema.String),
});

// Wrapper for all available caption tracks for one video.
const captionsTracklistSchema = Schema.Struct({
  // Tracks that can be used to request subtitles; absent means none published.
  captionTracks: Schema.optionalWith(Schema.Array(captionTrackNodeSchema), {
    default: () => EMPTY_CAPTION_TRACKS,
  }),
});

// Optional renderer that groups track metadata.
const captionsSchema = Schema.Struct({
  // Tracklist renderer container for caption tracks.
  playerCaptionsTracklistRenderer: Schema.optionalWith(
    captionsTracklistSchema,
    { default: () => ({ captionTracks: EMPTY_CAPTION_TRACKS }) },
  ),
});

// Minimal player response slice needed for caption discovery.
const youtubePlayerPayloadSchema = Schema.Struct({
  // Captions block; absent means the video published no caption tracks.
  captions: Schema.optionalWith(
    captionsSchema,
    { default: () => ({ playerCaptionsTracklistRenderer: { captionTracks: EMPTY_CAPTION_TRACKS } }) },
  ),
});

const decodePlayerPayload = Schema.decodeUnknown(youtubePlayerPayloadSchema);

// Type after schema validation for YouTube player response.
type YoutubePlayerPayload = Schema.Schema.Type<typeof youtubePlayerPayloadSchema>;
// Type after schema validation for one caption track node.
type YoutubeCaptionTrackNode = Schema.Schema.Type<typeof captionTrackNodeSchema>;

const tryDecodePlayerPayload = (playerPayload: unknown): YoutubePlayerPayload | null => {
  try {
    return Effect.runSync(decodePlayerPayload(playerPayload));
  } catch {
    return null;
  }
};

const languageTagFromTrackNode = (trackNode: YoutubeCaptionTrackNode): string => {
  if (trackNode.vssId) {
    const cleanedLanguageTag = trackNode.vssId
      .replace(VSS_ID_LEADING_DOT, '')
      .replace(VSS_ID_DOT_REPLACER, '-');
    if (cleanedLanguageTag.startsWith(AUTO_LANGUAGE_PREFIX)) {
      return cleanedLanguageTag.slice(AUTO_LANGUAGE_PREFIX.length);
    }
    return cleanedLanguageTag;
  }
  if (trackNode.languageCode) {
    return trackNode.languageCode;
  }
  return FALLBACK_LANGUAGE_TAG;
};

const matchesLanguageTokens = (
  languageTag: string,
  languageTokenSet: Set<string>,
  wantsAllTracks: boolean,
): boolean => {
  if (wantsAllTracks) {
    return true;
  }
  const languageLower = languageTag.toLowerCase();
  if (languageTokenSet.has(languageLower)) {
    return true;
  }
  for (const languageToken of languageTokenSet) {
    if (languageLower.startsWith(languageToken)) {
      return true;
    }
  }
  return false;
};

const firstMatchingTrack = (
  candidateTracks: YoutubeCaptionTrack[],
  languageTokenSet: Set<string>,
  wantsAllTracks: boolean,
): YoutubeCaptionTrack | null => {
  for (const candidateTrack of candidateTracks) {
    if (matchesLanguageTokens(candidateTrack.languageTag, languageTokenSet, wantsAllTracks)) {
      return candidateTrack;
    }
  }
  return null;
};

export const parseTracksFromPayload = (playerPayload: unknown): YoutubeCaptionTrack[] => {
  // Empty list when shape is unknown so callers can try the next caption source.
  const decodedPlayerPayload = tryDecodePlayerPayload(playerPayload);
  if (!decodedPlayerPayload) {
    return [];
  }

  const captionTrackNodes =
    decodedPlayerPayload.captions.playerCaptionsTracklistRenderer.captionTracks;

  return captionTrackNodes.map((captionTrackNode) => {
    const sourceKind =
      captionTrackNode.kind === undefined ? TRACK_KIND_MANUAL : captionTrackNode.kind;
    return {
      baseUrl: captionTrackNode.baseUrl,
      languageTag: languageTagFromTrackNode(captionTrackNode),
      sourceKind,
    };
  });
};

export const chooseTrackFromParsedTracks = (
  captionTracks: YoutubeCaptionTrack[],
  languageTokens: string[],
  includeAutoCaptions: boolean,
): YoutubeCaptionTrack | null => {
  const languageTokenSet = new Set(
    languageTokens.map((languageToken) => languageToken.toLowerCase()),
  );
  const wantsAllTracks = languageTokenSet.has(LANGUAGE_TOKEN_WILDCARD);
  const manualTracks = captionTracks.filter(
    (captionTrack) => captionTrack.sourceKind !== TRACK_KIND_AUTO,
  );
  const autoCaptions = captionTracks.filter(
    (captionTrack) => captionTrack.sourceKind === TRACK_KIND_AUTO,
  );

  const manualTrack = firstMatchingTrack(manualTracks, languageTokenSet, wantsAllTracks);
  if (manualTrack) {
    return manualTrack;
  }
  if (!includeAutoCaptions) {
    return null;
  }
  return firstMatchingTrack(autoCaptions, languageTokenSet, wantsAllTracks);
};

export const composeCaptionRequestUrl = (
  trackUrl: string,
  fileFormat: SubtitleFormat,
): string => {
  const captionRequestUrl = new URL(trackUrl, YOUTUBE_WEB_HOST);
  captionRequestUrl.searchParams.set(CAPTION_FORMAT_QUERY_PARAM, fileFormat);
  return captionRequestUrl.toString();
};
