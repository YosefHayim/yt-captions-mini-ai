import { Effect, Schema } from 'effect';

import { CONSTANTS } from './constants.js';

const { VIDEO_ID_PATTERN } = CONSTANTS.shared;
const { PLAYLIST_ID_PARAM_PATTERN, HAS_PLAYLIST_PARAM_PATTERN } = CONSTANTS.playlist;

// Strongly typed playlist renderer item with an 11-char videoId.
const playlistVideoRendererSchema = Schema.Struct({
  // Renderer block that carries each playlist video id.
  playlistVideoRenderer: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  }),
});

// Navigation endpoint that points at a watchable video.
const watchEndpointSchema = Schema.Struct({
  // Direct watch endpoint with a resolvable video id.
  watchEndpoint: Schema.Struct({
    // 11-character YouTube video identifier.
    videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
    // Optional playlist context on the endpoint.
    playlistId: Schema.optional(Schema.String),
  }),
});

// Command wrapper that nests a watch endpoint.
const watchCommandContainerSchema = Schema.Struct({
  // Command object that contains a watch endpoint.
  videoCommand: Schema.Struct({
    // Nested watch endpoint with a resolvable video id.
    watchEndpoint: Schema.Struct({
      // 11-character YouTube video identifier.
      videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
      // Optional playlist context on the endpoint.
      playlistId: Schema.optional(Schema.String),
    }),
  }),
});

// Generic record type for recursive playlist traversal.
const dynamicObjectSchema = Schema.Record({
  // Record keys are string property names.
  key: Schema.String,
  // Record values can be any value nested in ytInitialData.
  value: Schema.Unknown,
});

const decodePlaylistRenderer = Schema.decodeUnknown(playlistVideoRendererSchema);
const decodeWatchEndpoint = Schema.decodeUnknown(watchEndpointSchema);
const decodeWatchCommand = Schema.decodeUnknown(watchCommandContainerSchema);
const decodeDynamicObject = Schema.decodeUnknown(dynamicObjectSchema);

const readVideoIdFromWatchEndpoint = (playlistNode: unknown): string | null => {
  try {
    const watchEndpointNode = Effect.runSync(decodeWatchEndpoint(playlistNode));
    return watchEndpointNode.watchEndpoint.videoId;
  } catch {
    return null;
  }
};

const readVideoIdFromWatchCommand = (playlistNode: unknown): string | null => {
  try {
    const watchCommandNode = Effect.runSync(decodeWatchCommand(playlistNode));
    return watchCommandNode.videoCommand.watchEndpoint.videoId;
  } catch {
    return null;
  }
};

const readVideoIdFromPlaylistRenderer = (playlistNode: unknown): string | null => {
  try {
    const playlistRendererNode = Effect.runSync(decodePlaylistRenderer(playlistNode));
    return playlistRendererNode.playlistVideoRenderer.videoId;
  } catch {
    return null;
  }
};

const asPlaylistObject = (playlistNode: unknown): Record<string, unknown> | null => {
  try {
    return Effect.runSync(decodeDynamicObject(playlistNode));
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

export const getPlaylistIdFromUrl = (sourceUrl: string): string | null => {
  const playlistMatch = PLAYLIST_ID_PARAM_PATTERN.exec(sourceUrl);
  return playlistMatch ? playlistMatch[1] : null;
};

export const isYoutubePlaylistUrl = (sourceUrl: string): boolean => {
  return HAS_PLAYLIST_PARAM_PATTERN.test(sourceUrl);
};

export const collectPlaylistVideoIds = (
  playlistRoot: unknown,
  videoIds: string[],
): void => {
  const seenVideoIds = new Set(videoIds);

  const visitPlaylistNode = (playlistNode: unknown): void => {
    if (Array.isArray(playlistNode)) {
      for (const nestedNode of playlistNode) {
        visitPlaylistNode(nestedNode);
      }
      return;
    }

    const playlistObject = asPlaylistObject(playlistNode);
    if (!playlistObject) {
      return;
    }

    pushUniqueVideoId(
      readVideoIdFromPlaylistRenderer(playlistObject),
      seenVideoIds,
      videoIds,
    );

    const endpointVideoId =
      readVideoIdFromWatchEndpoint(playlistObject) ??
      readVideoIdFromWatchCommand(playlistObject);
    pushUniqueVideoId(endpointVideoId, seenVideoIds, videoIds);

    for (const nestedNode of Object.values(playlistObject)) {
      visitPlaylistNode(nestedNode);
    }
  };

  visitPlaylistNode(playlistRoot);
};
