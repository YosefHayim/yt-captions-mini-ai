import { Effect, Schema } from 'effect';
const YOUTUBE_WEB_HOST = 'https://www.youtube.com';
const TRACK_KIND_AUTO = 'asr';
const TRACK_KIND_MANUAL = 'manual';
const LANGUAGE_TOKEN_WILDCARD = 'all';
const FALLBACK_LANGUAGE_TAG = 'und';
const VSS_ID_LEADING_DOT = /^\./;
const VSS_ID_DOT_REPLACER = /\./g;
const EMPTY_CAPTION_TRACKS = [];
const DEFAULT_CAPTION_QUERY_PARAM = 'fmt';
const AUTO_LANGUAGE_PREFIX = 'a-';
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
// Wrapper for all available caption tracks for one video payload.
const captionsTracklistSchema = Schema.Struct({
    // Optional list of tracks that can be used to request subtitles.
    captionTracks: Schema.optionalWith(Schema.Array(captionTrackNodeSchema), {
        default: () => EMPTY_CAPTION_TRACKS,
    }),
});
// Optional renderer that groups track metadata.
const captionsSchema = Schema.Struct({
    // Optional tracklist renderer container for caption tracks.
    playerCaptionsTracklistRenderer: Schema.optionalWith(captionsTracklistSchema, { default: () => ({ captionTracks: EMPTY_CAPTION_TRACKS }) }),
});
// Minimal player payload slice needed by this tool.
const youtubePlayerPayloadSchema = Schema.Struct({
    // Optional captions block; if absent, decode falls back to empty tracks.
    captions: Schema.optionalWith(captionsSchema, { default: () => ({ playerCaptionsTracklistRenderer: { captionTracks: EMPTY_CAPTION_TRACKS } }) }),
});
const decodePlayerPayload = Schema.decodeUnknown(youtubePlayerPayloadSchema);
const parseYouTubePlayerPayload = (rawPayload) => {
    // 1) Run the typed schema decoder on the raw payload.
    // 2) Return null when decoding fails to keep callers decision-free.
    // 3) Keep parse errors localized inside this parser helper.
    try {
        return Effect.runSync(decodePlayerPayload(rawPayload));
    }
    catch {
        return null;
    }
};
const getTrackLanguage = (trackNode) => {
    // 1) Use `vssId` when present and normalize punctuation.
    // 2) Else use `languageCode`.
    // 3) Else return fallback `und`.
    if (trackNode.vssId) {
        const normalizedLanguageTag = trackNode.vssId.replace(VSS_ID_LEADING_DOT, '').replace(VSS_ID_DOT_REPLACER, '-');
        return normalizedLanguageTag.startsWith(AUTO_LANGUAGE_PREFIX) ? normalizedLanguageTag.slice(AUTO_LANGUAGE_PREFIX.length) : normalizedLanguageTag;
    }
    if (trackNode.languageCode) {
        return trackNode.languageCode;
    }
    return FALLBACK_LANGUAGE_TAG;
};
const selectTrackFromParsedTracks = (availableTracks, languageTokens, includeAutoCaptions) => {
    // 1) Normalize language requests and split tracks into manual/auto pools.
    // 2) Try matching manual tracks first with wildcard, exact, or prefix logic.
    // 3) Optionally try auto tracks with same logic, else return null.
    const languageTokenSet = new Set(languageTokens.map((languageToken) => languageToken.toLowerCase()));
    const wantsAllTracks = languageTokenSet.has(LANGUAGE_TOKEN_WILDCARD);
    const manualTracks = availableTracks.filter((captionTrack) => captionTrack.sourceKind !== TRACK_KIND_AUTO);
    const autoCaptions = availableTracks.filter((captionTrack) => captionTrack.sourceKind === TRACK_KIND_AUTO);
    const chooseFromCandidates = (candidateTracks) => {
        for (let index = 0; index < candidateTracks.length; index += 1) {
            const candidateTrack = candidateTracks[index];
            const languageLower = candidateTrack.languageTag.toLowerCase();
            if (wantsAllTracks) {
                return candidateTrack;
            }
            const exactLanguageMatch = languageTokenSet.has(languageLower);
            if (exactLanguageMatch) {
                return candidateTrack;
            }
            const prefixLanguageMatch = [...languageTokenSet].some((languageToken) => languageLower.startsWith(languageToken));
            if (prefixLanguageMatch) {
                return candidateTrack;
            }
        }
        return null;
    };
    const manualTrack = chooseFromCandidates(manualTracks);
    if (manualTrack) {
        return manualTrack;
    }
    if (includeAutoCaptions) {
        const autoTrack = chooseFromCandidates(autoCaptions);
        if (autoTrack) {
            return autoTrack;
        }
    }
    return null;
};
export const parseTracksFromPayload = (playerPayload) => {
    // 1) Decode payload with schema and stop with empty list on invalid payload.
    // 2) Read caption track nodes from normalized `playerCaptionsTracklistRenderer`.
    // 3) Convert nodes into internal `YoutubeCaptionTrack` records.
    const normalizedPayload = parseYouTubePlayerPayload(playerPayload);
    if (!normalizedPayload)
        return [];
    const captionRenderer = normalizedPayload.captions.playerCaptionsTracklistRenderer;
    const captionTrackNodes = captionRenderer.captionTracks;
    return captionTrackNodes.map((captionTrackNode) => {
        const sourceKind = captionTrackNode.kind === undefined ? TRACK_KIND_MANUAL : captionTrackNode.kind;
        return {
            baseUrl: captionTrackNode.baseUrl,
            languageTag: getTrackLanguage(captionTrackNode),
            sourceKind,
        };
    });
};
export const chooseTrackForDownload = (playerPayload, languageTokens, includeAutoCaptions) => {
    // 1) Parse tracks from raw payload.
    // 2) Delegate selection to shared chooser.
    // 3) Return the exact track used for download.
    const captionTracks = parseTracksFromPayload(playerPayload);
    return selectTrackFromParsedTracks(captionTracks, languageTokens, includeAutoCaptions);
};
export const chooseTrackFromParsedTracks = (parsedTracks, languageTokens, includeAutoCaptions) => {
    // 1) Receive already-parsed tracks.
    // 2) Reuse shared selector so rules stay single-sourced.
    // 3) Return selected manual/auto track or null.
    return selectTrackFromParsedTracks(parsedTracks, languageTokens, includeAutoCaptions);
};
export const buildCaptionRequestUrl = (trackUrl, fileFormat) => {
    // 1) Create URL from track base and YouTube host.
    // 2) Force requested format in `fmt`.
    // 3) Skip extra query flags so server returns the canonical transcript payload.
    const urlObject = new URL(trackUrl, YOUTUBE_WEB_HOST);
    urlObject.searchParams.set(DEFAULT_CAPTION_QUERY_PARAM, fileFormat);
    return urlObject.toString();
};
