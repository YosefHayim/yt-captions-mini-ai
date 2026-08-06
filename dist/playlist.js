import { Effect, Schema } from 'effect';
const PLAYLIST_ID_PARAM_PATTERN = /[?&]list=([A-Za-z0-9_-]+)/;
const HAS_PLAYLIST_PARAM_PATTERN = /[?&]list=/;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const WATCHABLE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const DYNAMIC_OBJECT_KEY = Schema.String;
// Strongly typed playlist renderer item with an 11-char videoId.
const playlistVideoRendererSchema = Schema.Struct({
    // Renderer block that carries each playlist video id.
    playlistVideoRenderer: Schema.Struct({
        // 11-character YouTube video identifier.
        videoId: Schema.String.pipe(Schema.pattern(PLAYLIST_ID_PATTERN)),
    }),
});
const watchEndpointSchema = Schema.Struct({
    // Direct watch endpoint with a resolvable video id.
    watchEndpoint: Schema.Struct({
        videoId: Schema.String.pipe(Schema.pattern(WATCHABLE_VIDEO_ID_PATTERN)),
        playlistId: Schema.optional(Schema.String),
    }),
});
const watchCommandContainerSchema = Schema.Struct({
    // Command object that contains a watch endpoint.
    videoCommand: Schema.Struct({
        watchEndpoint: Schema.Struct({
            videoId: Schema.String.pipe(Schema.pattern(WATCHABLE_VIDEO_ID_PATTERN)),
            playlistId: Schema.optional(Schema.String),
        }),
    }),
});
// Generic record type for recursive playlist traversal.
const dynamicObjectSchema = Schema.Record({
    // Record keys are string property names.
    key: DYNAMIC_OBJECT_KEY,
    // Record values can be any value nested in ytInitialData.
    value: Schema.Unknown,
});
const decodePlaylistRenderer = Schema.decodeUnknown(playlistVideoRendererSchema);
const decodeWatchEndpoint = Schema.decodeUnknown(watchEndpointSchema);
const decodeWatchCommand = Schema.decodeUnknown(watchCommandContainerSchema);
const decodeDynamicObject = Schema.decodeUnknown(dynamicObjectSchema);
const readVideoIdFromWatchEndpoint = (inputNode) => {
    // Try decoding a node with direct `watchEndpoint.videoId`. Return that id when present. Return null when structure doesn't match.
    try {
        const decoded = Effect.runSync(decodeWatchEndpoint(inputNode));
        return decoded.watchEndpoint.videoId;
    }
    catch {
        return null;
    }
};
const readVideoIdFromWatchCommand = (inputNode) => {
    // Try decoding a node with `videoCommand.watchEndpoint.videoId`. Return that id when present. Return null when structure doesn't match.
    try {
        const decoded = Effect.runSync(decodeWatchCommand(inputNode));
        return decoded.videoCommand.watchEndpoint.videoId;
    }
    catch {
        return null;
    }
};
const parsePlaylistRenderer = (inputNode) => {
    // Validate node against the expected renderer schema. Return videoId when valid. Return null on mismatch so traversal can continue.
    try {
        const decodedRenderer = Effect.runSync(decodePlaylistRenderer(inputNode));
        return decodedRenderer.playlistVideoRenderer.videoId;
    }
    catch {
        return null;
    }
};
const asObjectRecord = (inputNode) => {
    // Try to treat node as a generic object record. Return typed object when decode succeeds. Return null to skip non-object branches in recursion.
    try {
        return Effect.runSync(decodeDynamicObject(inputNode));
    }
    catch {
        return null;
    }
};
export const getPlaylistIdFromUrl = (rawUrl) => {
    const playlistMatch = PLAYLIST_ID_PARAM_PATTERN.exec(rawUrl);
    return playlistMatch ? playlistMatch[1] : null;
};
export const isYoutubePlaylistUrl = (rawUrl) => {
    return HAS_PLAYLIST_PARAM_PATTERN.test(rawUrl);
};
export const collectPlaylistVideoIds = (playlistPayload, idsCollector) => {
    // Keep a Set of seen IDs while mutating the output array. Recursively visit arrays and objects, extracting playlistRenderer IDs. Push each new ID once to avoid duplicates.
    const tracker = new Set(idsCollector);
    const recurse = (node) => {
        if (Array.isArray(node)) {
            for (const arrayEntry of node) {
                recurse(arrayEntry);
            }
            return;
        }
        const frame = asObjectRecord(node);
        if (!frame) {
            return;
        }
        const extractedVideoId = parsePlaylistRenderer(frame);
        if (extractedVideoId && !tracker.has(extractedVideoId)) {
            tracker.add(extractedVideoId);
            idsCollector.push(extractedVideoId);
        }
        let endpointVideoId = readVideoIdFromWatchEndpoint(frame);
        if (endpointVideoId === null) {
            endpointVideoId = readVideoIdFromWatchCommand(frame);
        }
        if (endpointVideoId && !tracker.has(endpointVideoId)) {
            tracker.add(endpointVideoId);
            idsCollector.push(endpointVideoId);
        }
        const values = Object.values(frame);
        for (const nestedNode of values) {
            recurse(nestedNode);
        }
    };
    recurse(playlistPayload);
};
