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
    // 1) Keep whitespace detection small and explicit.
    // 2) Ignore only control chars that appear in inline HTML scripts.
    return sourceCharacter === ' ' || sourceCharacter === '\n' || sourceCharacter === '\t' || sourceCharacter === '\r';
};
const skipWhitespace = (pageHtml, fromOffset) => {
    // 1) Move forward from marker tail.
    // 2) Return first non-whitespace position for a deterministic object parse.
    // 3) Return -1 if only whitespace remains.
    for (let cursor = fromOffset; cursor < pageHtml.length; cursor += 1) {
        if (!isCharacterWhitespace(pageHtml[cursor])) {
            return cursor;
        }
    }
    return -1;
};
const parseJsonObjectFromOffset = (pageHtml, objectOffset) => {
    // 1) Walk braces with JSON-aware string/escape handling.
    // 2) Return parsed object when brace depth closes back to zero.
    // 3) Return null when this candidate is not valid JSON.
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
    // 1) Validate required player API fields.
    // 2) Return null when schema decode fails.
    // 3) Keep fallback loops in caller and avoid throwing.
    try {
        return Effect.runSync(decodePlayerConfig(rawConfigPayload));
    }
    catch {
        return null;
    }
};
const parsePlayerConfig = (pageHtml) => {
    // 1) Walk all `ytcfg.set(...)` calls and only accept object-style calls.
    // 2) Return the first payload that passes player config schema.
    // 3) Return null when no config payload is decodable.
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
    // 1) Reject non-finite, negative, and fractional values.
    // 2) Keep signature timestamp validation deterministic.
    return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
};
const parseSignatureTimestamp = (playerConfig, pageHtml) => {
    // 1) Prefer STS field from `ytcfg`.
    // 2) Fallback to regex extraction from page script markers.
    // 3) Return null when timestamp is unavailable.
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
    // 1) Use INNERTUBE_CONTEXT.client.gl when available.
    // 2) Default to US when missing for deterministic request context.
    return playerConfig.INNERTUBE_CONTEXT.client.gl ?? REGION_FALLBACK;
};
const getLanguageHint = (playerConfig) => {
    // 1) Use INNERTUBE_CONTEXT.client.hl when available.
    // 2) Default to English for deterministic API behavior.
    return playerConfig.INNERTUBE_CONTEXT.client.hl ?? LANGUAGE_FALLBACK;
};
const collectClientVersions = (primaryVersion) => {
    // 1) Keep the latest extracted client version first.
    // 2) Add fallback versions to mirror yt-dlp behavior.
    // 3) Deduplicate with insertion-order semantics.
    const configuredVersions = [primaryVersion, ...YOUTUBE_PREFERRED_CLIENT_VERSIONS];
    const distinctVersions = new Set();
    for (const versionValue of configuredVersions) {
        if (versionValue.length > 0) {
            distinctVersions.add(versionValue);
        }
    }
    return [...distinctVersions];
};
const buildPlayerRequestContext = (languageHint, regionHint, clientVersion) => ({
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
const buildPlayerRequestPayload = (videoId, languageHint, regionHint, clientVersion, signatureTimestamp) => ({
    context: buildPlayerRequestContext(languageHint, regionHint, clientVersion),
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
const buildPlayerApiUrl = (apiKey) => {
    // 1) Always include the API key parameter.
    // 2) Keep prettyPrint off to reduce response noise.
    // 3) Return absolute endpoint string for POST calls.
    const encodedKey = encodeURIComponent(apiKey);
    return `${YOUTUBE_PLAYER_API_ENDPOINT}?key=${encodedKey}&${YOUTUBE_PRETTY_PRINT_QUERY}`;
};
const buildPlayerApiHeaders = (clientVersion, watchUrl) => {
    // 1) Keep web headers similar to yt-dlp player requests.
    // 2) Ensure both client headers and browser origin are included.
    // 3) Keep header names explicit for deterministic debugging.
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
const fetchTracksFromPlayer = async (videoId, watchUrl, signatureTimestamp, playerConfig, clientVersion) => {
    // 1) Call youtubei/player with minimal context to avoid signature-tokened URLs.
    // 2) Reuse existing track parser so selection logic remains unchanged.
    // 3) Return an empty list when no captions exist for this client version.
    const languageHint = getLanguageHint(playerConfig);
    const regionHint = getPlaybackRegion(playerConfig);
    const requestPayload = buildPlayerRequestPayload(videoId, languageHint, regionHint, clientVersion, signatureTimestamp);
    const requestUrl = buildPlayerApiUrl(playerConfig.INNERTUBE_API_KEY);
    const playerResponse = await fetchJsonResource(requestUrl, requestPayload, {
        method: 'POST',
        headers: buildPlayerApiHeaders(clientVersion, watchUrl),
    });
    return parseTracksFromPayload(playerResponse);
};
export const fetchTracksFromPlayerApi = async (watchUrl, videoId, pageHtml) => {
    // 1) Decode YouTube web player config from watch HTML.
    // 2) Try multiple safe client versions with the required signature timestamp.
    // 3) Return the first non-empty track list, else an empty list.
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
            const captionTracks = await fetchTracksFromPlayer(videoId, watchUrl, signatureTimestamp, playerConfig, clientVersion);
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
