import { Effect, Schema } from 'effect';
import { parseTracksFromPayload } from './captions.js';
import { fetchJsonResource } from './http.js';
const YOUTUBE_PLAYER_API_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';
const YOUTUBE_INITIAL_CONFIG_MARKER = 'ytcfg.set(';
const YOUTUBE_WEB_PLAYER_NAME = 'WEB';
const YOUTUBE_WEB_CLIENT_ID = '1';
const YOUTUBE_PREFERRED_CLIENT_VERSIONS = ['2.20260805.01.00', '2.20250925.01.00'];
const YOUTUBE_ORIGIN_URL = 'https://www.youtube.com';
const YOUTUBE_PRETTY_PRINT_QUERY = 'prettyPrint=false';
const HTML5_PREFERENCE = 'HTML5_PREF_WANTS';
const YOUTUBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const SIGNATURE_TIMESTAMP_PATTERN = /(?:signatureTimestamp|sts)\s*:\s*(?<signatureTimestamp>[0-9]{5})/;
const LANGUAGE_FALLBACK = 'en';
const REGION_FALLBACK = 'US';
const SAFE_CLIENT_NAME = 'request';
const SAFE_USE_SSL = true;
const OPEN_BRACE = '{';
const CLOSE_BRACE = '}';
const DOUBLE_QUOTE = '"';
const ESCAPE_CHARACTER = '\\';
const OPEN_BRACE_CODE = OPEN_BRACE.charCodeAt(0);
const CLOSE_BRACE_CODE = CLOSE_BRACE.charCodeAt(0);
const DOUBLE_QUOTE_CODE = DOUBLE_QUOTE.charCodeAt(0);
const ESCAPE_CHARACTER_CODE = ESCAPE_CHARACTER.charCodeAt(0);
const playerConfigSchema = Schema.Struct({
    // Public API key for youtubei/player endpoint.
    INNERTUBE_API_KEY: Schema.String,
    // Default client name used when yt-dlp switches away from compact payloads.
    INNERTUBE_CONTEXT_CLIENT_NAME: Schema.Number,
    // Default client version to send in headers and context.
    INNERTUBE_CONTEXT_CLIENT_VERSION: Schema.String,
    // Signature timestamp used in playback context for caption retrieval.
    STS: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
    // Lightweight context fields for language and region defaults.
    INNERTUBE_CONTEXT: Schema.Struct({
        client: Schema.Struct({
            hl: Schema.optional(Schema.String),
            gl: Schema.optional(Schema.String),
        }),
    }),
});
const decodePlayerConfig = Schema.decodeUnknown(playerConfigSchema);
const isCharacterWhitespace = (sourceCharacter) => {
    // Keep whitespace detection small and explicit. Ignore only control chars that appear in inline HTML scripts.
    return sourceCharacter === ' ' || sourceCharacter === '\n' || sourceCharacter === '\t' || sourceCharacter === '\r';
};
const skipWhitespace = (pageHtml, fromOffset) => {
    // Move forward from marker tail. Return first non-whitespace position for a deterministic object parse. Return -1 if only whitespace remains.
    for (let cursor = fromOffset; cursor < pageHtml.length; cursor += 1) {
        if (!isCharacterWhitespace(pageHtml[cursor])) {
            return cursor;
        }
    }
    return -1;
};
const parseJsonObjectFromOffset = (pageHtml, objectOffset) => {
    // Walk braces with JSON-aware string/escape handling. Return parsed object when brace depth closes back to zero. Return null when this candidate is not valid JSON.
    let braceDepth = 0;
    let inString = false;
    let escaping = false;
    for (let cursor = objectOffset; cursor < pageHtml.length; cursor += 1) {
        const sourceCode = pageHtml.charCodeAt(cursor);
        if (escaping) {
            escaping = false;
            continue;
        }
        if (inString) {
            if (sourceCode === ESCAPE_CHARACTER_CODE) {
                escaping = true;
            }
            else if (sourceCode === DOUBLE_QUOTE_CODE) {
                inString = false;
            }
            continue;
        }
        if (sourceCode === DOUBLE_QUOTE_CODE) {
            inString = true;
            continue;
        }
        if (sourceCode === OPEN_BRACE_CODE) {
            braceDepth += 1;
            continue;
        }
        if (sourceCode === CLOSE_BRACE_CODE) {
            braceDepth -= 1;
            if (braceDepth === 0) {
                const objectText = pageHtml.slice(objectOffset, cursor + 1);
                try {
                    return JSON.parse(objectText);
                }
                catch {
                    return null;
                }
            }
        }
    }
    return null;
};
const parsePlayerConfigPayload = (rawConfigPayload) => {
    // Validate required player API fields. Return null when schema decode fails. Keep fallback loops in caller and avoid throwing.
    try {
        return Effect.runSync(decodePlayerConfig(rawConfigPayload));
    }
    catch {
        return null;
    }
};
const parsePlayerConfig = (pageHtml) => {
    // Walk all `ytcfg.set(...)` calls and only accept object-style calls. Return the first payload that passes player config schema. Return null when no config payload is decodable.
    let markerOffset = pageHtml.indexOf(YOUTUBE_INITIAL_CONFIG_MARKER);
    while (markerOffset !== -1) {
        const firstTokenOffset = skipWhitespace(pageHtml, markerOffset + YOUTUBE_INITIAL_CONFIG_MARKER.length);
        if (firstTokenOffset !== -1 && pageHtml.charCodeAt(firstTokenOffset) === OPEN_BRACE_CODE) {
            const extractedPayload = parseJsonObjectFromOffset(pageHtml, firstTokenOffset);
            if (extractedPayload) {
                const playerConfig = parsePlayerConfigPayload(extractedPayload);
                if (playerConfig) {
                    return playerConfig;
                }
            }
        }
        markerOffset = pageHtml.indexOf(YOUTUBE_INITIAL_CONFIG_MARKER, markerOffset + YOUTUBE_INITIAL_CONFIG_MARKER.length);
    }
    return null;
};
const isNonNegativeInteger = (value) => {
    // Reject non-finite, negative, and fractional values. Keep signature timestamp validation deterministic.
    return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
};
const parseSignatureTimestamp = (playerConfig, pageHtml) => {
    // Prefer STS field from `ytcfg`. Fallback to regex extraction from page script markers. Return null when timestamp is unavailable.
    const declaredTimestamp = playerConfig.STS;
    const safeTimestamp = declaredTimestamp === undefined ? null : Number(declaredTimestamp);
    if (safeTimestamp !== null && isNonNegativeInteger(safeTimestamp)) {
        return safeTimestamp;
    }
    const signatureMatch = SIGNATURE_TIMESTAMP_PATTERN.exec(pageHtml);
    if (!signatureMatch) {
        return null;
    }
    const extractedTimestamp = Number.parseInt(signatureMatch.groups?.signatureTimestamp ?? '', 10);
    return isNonNegativeInteger(extractedTimestamp) ? extractedTimestamp : null;
};
const getPlaybackRegion = (playerConfig) => {
    // Use INNERTUBE_CONTEXT.client.gl when available. Default to US when missing for deterministic request context.
    return playerConfig.INNERTUBE_CONTEXT.client.gl ?? REGION_FALLBACK;
};
const getLanguageHint = (playerConfig) => {
    // Use INNERTUBE_CONTEXT.client.hl when available. Default to English for deterministic API behavior.
    return playerConfig.INNERTUBE_CONTEXT.client.hl ?? LANGUAGE_FALLBACK;
};
const collectClientVersions = (primaryVersion) => {
    // Keep the latest extracted client version first. Add fallback versions to mirror yt-dlp behavior. Deduplicate with insertion-order semantics.
    const configuredVersions = [primaryVersion, ...YOUTUBE_PREFERRED_CLIENT_VERSIONS];
    const distinctVersions = new Set();
    for (const versionValue of configuredVersions) {
        if (versionValue.length > 0) {
            distinctVersions.add(versionValue);
        }
    }
    return [...distinctVersions];
};
const createPlayerContext = (languageHint, regionHint, clientVersion) => ({
    client: {
        hl: languageHint,
        gl: regionHint,
        clientName: YOUTUBE_WEB_PLAYER_NAME,
        clientVersion,
        userAgent: YOUTUBE_USER_AGENT,
        userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT',
    },
    user: {
        lockedSafetyMode: false,
    },
    request: {
        [SAFE_CLIENT_NAME]: {
            useSsl: SAFE_USE_SSL,
        },
    },
});
const createPlayerRequestPayload = (videoId, languageHint, regionHint, clientVersion, signatureTimestamp) => ({
    context: createPlayerContext(languageHint, regionHint, clientVersion),
    videoId,
    playbackContext: {
        contentPlaybackContext: {
            html5Preference: HTML5_PREFERENCE,
            signatureTimestamp,
        },
    },
    contentCheckOk: true,
    racyCheckOk: true,
});
const createPlayerApiUrl = (apiKey) => {
    // Always include the API key parameter. Keep prettyPrint off to reduce response noise. Return absolute endpoint string for POST calls.
    const encodedKey = encodeURIComponent(apiKey);
    return `${YOUTUBE_PLAYER_API_ENDPOINT}?key=${encodedKey}&${YOUTUBE_PRETTY_PRINT_QUERY}`;
};
const composePlayerApiHeaders = (clientVersion, watchUrl) => {
    // Keep web headers similar to yt-dlp player requests. Ensure both client headers and browser origin are included. Keep header names explicit for deterministic debugging.
    return {
        'Content-Type': 'application/json',
        Origin: YOUTUBE_ORIGIN_URL,
        Referer: watchUrl,
        'User-Agent': YOUTUBE_USER_AGENT,
        Accept: '*/*',
        'X-Youtube-Client-Name': YOUTUBE_WEB_CLIENT_ID,
        'X-Youtube-Client-Version': clientVersion,
    };
};
const requestCaptionTracks = async (videoId, watchUrl, signatureTimestamp, playerConfig, clientVersion) => {
    // Call youtubei/player with minimal context to avoid signature-tokened URLs. Reuse existing track parser so selection logic remains unchanged. Return an empty list when no captions exist for this client version.
    const languageHint = getLanguageHint(playerConfig);
    const regionHint = getPlaybackRegion(playerConfig);
    const requestPayload = createPlayerRequestPayload(videoId, languageHint, regionHint, clientVersion, signatureTimestamp);
    const requestUrl = createPlayerApiUrl(playerConfig.INNERTUBE_API_KEY);
    const playerResponse = await fetchJsonResource(requestUrl, requestPayload, {
        method: 'POST',
        headers: composePlayerApiHeaders(clientVersion, watchUrl),
    });
    return parseTracksFromPayload(playerResponse);
};
export const fetchTracksFromPlayerApi = async (watchUrl, videoId, pageHtml) => {
    // Decode YouTube web player config from watch HTML. Try multiple safe client versions with the required signature timestamp. Return the first non-empty track list, else an empty list.
    const playerConfig = parsePlayerConfig(pageHtml);
    if (!playerConfig) {
        return [];
    }
    const signatureTimestamp = parseSignatureTimestamp(playerConfig, pageHtml);
    if (signatureTimestamp === null) {
        return [];
    }
    const clientVersions = collectClientVersions(playerConfig.INNERTUBE_CONTEXT_CLIENT_VERSION);
    for (const clientVersion of clientVersions) {
        try {
            const captionTracks = await requestCaptionTracks(videoId, watchUrl, signatureTimestamp, playerConfig, clientVersion);
            if (captionTracks.length > 0) {
                return captionTracks;
            }
        }
        catch {
            continue;
        }
    }
    return [];
};
