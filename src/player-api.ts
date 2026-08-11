import { Effect, Schema } from 'effect';
import { parseTracksFromPayload } from './captions.js';
import {
  applyClientOverrides,
  getPreferredClientOrder,
  getRaceClientCount,
  loadPlayerClientConfig,
} from './client-config.js';
import { fetchJsonResource } from './http.js';
import { attachPoTokenToPlayerBody, resolveOptionalPoToken } from './po-token.js';
import { YoutubeCaptionTrack } from './types.js';
import { logInfo, logWarn } from './log.js';

import { CONSTANTS } from './constants.js';

const {
  YOUTUBE_PRETTY_PRINT_QUERY,
  DEFAULT_LANGUAGE: DEFAULT_LANGUAGE_HINT,
  DEFAULT_REGION: DEFAULT_REGION_HINT,
  OPEN_BRACE_CODE,
  CLOSE_BRACE_CODE,
  DOUBLE_QUOTE_CODE,
  ESCAPE_CHARACTER_CODE,
  DEFAULT_WEB_API_KEY,
  CLIENT_ATTEMPT_DELAY_MS,
  WEB_CLIENT_NAME,
  YOUTUBE_ORIGIN_SLASH: EMBED_URL,
  YOUTUBE_WWW_HOST,
  BROWSER_USER_AGENT,
} = CONSTANTS.shared;
const {
  YOUTUBE_PLAYER_API_PATH,
  HTML5_PREFERENCE,
  YOUTUBE_INITIAL_CONFIG_MARKER,
  SIGNATURE_TIMESTAMP_PATTERN,
  DEFAULT_ANDROID_API_KEY,
  DEFAULT_IOS_API_KEY,
  LOG_CLIENT_PREFIX,
  LOG_CLIENT_EMPTY,
  LOG_CLIENT_NO_STREAMS,
  LOG_CLIENT_FAILED,
  LOG_STICKY_CLIENT,
  LOG_VISITOR_BOOTSTRAP,
  PREFERRED_CLIENT_ORDER,
} = CONSTANTS.playerApi;

// Last player client that returned caption tracks in this process (sticky fast path).
let stickyPlayerClientLabel: string | null = null;
const {
  CONTENT_TYPE_HEADER,
  CONTENT_TYPE_JSON,
  USER_AGENT_HEADER,
  ACCEPT_HEADER,
  ACCEPT_ALL,
} = CONSTANTS.http;

// Static Innertube client profile inspired by yt-dlp client table.
export type PlayerClientProfile = {
  // Short label for logs.
  profileLabel: string;
  // Host used for the player POST (www / music).
  innertubeHost: string;
  // Public API key for this client family.
  apiKey: string;
  // X-Youtube-Client-Name numeric id.
  clientId: string;
  // client.clientName inside Innertube context.
  clientName: string;
  // client.clientVersion inside Innertube context.
  clientVersion: string;
  // User-Agent matching the client family.
  userAgent: string;
  // Extra client object fields (androidSdkVersion, deviceModel, …).
  extraClientFields: Record<string, string | number>;
  // Whether to attach thirdParty.embedUrl (embedded clients).
  useEmbeddedThirdParty: boolean;
};

const PLAYER_CLIENT_PROFILES: PlayerClientProfile[] = [
  {
    profileLabel: 'android_vr',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_ANDROID_API_KEY,
    clientId: '28',
    clientName: 'ANDROID_VR',
    clientVersion: '1.65.10',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extraClientFields: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
    },
    useEmbeddedThirdParty: false,
  },
  {
    profileLabel: 'android',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_ANDROID_API_KEY,
    clientId: '3',
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    extraClientFields: {
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
    },
    useEmbeddedThirdParty: false,
  },
  {
    profileLabel: 'ios',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_IOS_API_KEY,
    clientId: '5',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extraClientFields: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
    },
    useEmbeddedThirdParty: false,
  },
  {
    profileLabel: 'tv',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_WEB_API_KEY,
    clientId: '7',
    clientName: 'TVHTML5',
    clientVersion: '7.20250923.13.00',
    userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    extraClientFields: {},
    useEmbeddedThirdParty: false,
  },
  {
    profileLabel: 'mweb',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_WEB_API_KEY,
    clientId: '2',
    clientName: 'MWEB',
    clientVersion: '2.20250925.01.00',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    extraClientFields: {},
    useEmbeddedThirdParty: false,
  },
  {
    profileLabel: 'web',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_WEB_API_KEY,
    clientId: '1',
    clientName: WEB_CLIENT_NAME,
    clientVersion: '2.20250925.01.00',
    userAgent: BROWSER_USER_AGENT,
    extraClientFields: {},
    useEmbeddedThirdParty: false,
  },
  {
    profileLabel: 'web_embedded',
    innertubeHost: YOUTUBE_WWW_HOST,
    apiKey: DEFAULT_WEB_API_KEY,
    clientId: '56',
    clientName: 'WEB_EMBEDDED_PLAYER',
    clientVersion: '1.20250923.21.00',
    userAgent: BROWSER_USER_AGENT,
    extraClientFields: {},
    useEmbeddedThirdParty: true,
  },
];

const playerConfigSchema = Schema.Struct({
  // Public API key for youtubei/player endpoint.
  INNERTUBE_API_KEY: Schema.optional(Schema.String),
  // Default client version to prefer when page HTML is available.
  INNERTUBE_CONTEXT_CLIENT_VERSION: Schema.optional(Schema.String),
  // Lightweight context fields for language and region defaults.
  INNERTUBE_CONTEXT: Schema.optional(
    Schema.Struct({
      client: Schema.Struct({
        hl: Schema.optional(Schema.String),
        gl: Schema.optional(Schema.String),
      }),
    }),
  ),
  // Signature timestamp used by WEB playback context when present.
  STS: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});

const decodePlayerConfig = Schema.decodeUnknown(playerConfigSchema);
// Validated ytcfg slice used to enrich player requests.
type YoutubePlayerConfig = Schema.Schema.Type<typeof playerConfigSchema>;

const sleepBriefly = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const isCharacterWhitespace = (sourceCharacter: string): boolean =>
  sourceCharacter === ' ' ||
  sourceCharacter === '\n' ||
  sourceCharacter === '\t' ||
  sourceCharacter === '\r';

const skipWhitespace = (pageHtml: string, fromOffset: number): number => {
  for (let cursor = fromOffset; cursor < pageHtml.length; cursor += 1) {
    if (!isCharacterWhitespace(pageHtml[cursor])) {
      return cursor;
    }
  }
  return -1;
};

const parseJsonObjectFromOffset = (
  pageHtml: string,
  objectOffset: number,
): Record<string, unknown> | null => {
  let braceDepth = 0;
  let insideString = false;
  let escapingCharacter = false;

  for (let cursor = objectOffset; cursor < pageHtml.length; cursor += 1) {
    const characterCode = pageHtml.charCodeAt(cursor);
    if (escapingCharacter) {
      escapingCharacter = false;
      continue;
    }
    if (insideString) {
      if (characterCode === ESCAPE_CHARACTER_CODE) {
        escapingCharacter = true;
      } else if (characterCode === DOUBLE_QUOTE_CODE) {
        insideString = false;
      }
      continue;
    }
    if (characterCode === DOUBLE_QUOTE_CODE) {
      insideString = true;
      continue;
    }
    if (characterCode === OPEN_BRACE_CODE) {
      braceDepth += 1;
      continue;
    }
    if (characterCode === CLOSE_BRACE_CODE) {
      braceDepth -= 1;
      if (braceDepth === 0) {
        try {
          return JSON.parse(pageHtml.slice(objectOffset, cursor + 1)) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const tryDecodePlayerConfig = (
  configObject: Record<string, unknown>,
): YoutubePlayerConfig | null => {
  try {
    return Effect.runSync(decodePlayerConfig(configObject));
  } catch {
    return null;
  }
};

const parsePlayerConfig = (pageHtml: string | null): YoutubePlayerConfig | null => {
  if (!pageHtml) {
    return null;
  }

  let markerOffset = pageHtml.indexOf(YOUTUBE_INITIAL_CONFIG_MARKER);
  while (markerOffset !== -1) {
    const firstTokenOffset = skipWhitespace(
      pageHtml,
      markerOffset + YOUTUBE_INITIAL_CONFIG_MARKER.length,
    );
    if (firstTokenOffset !== -1 && pageHtml.charCodeAt(firstTokenOffset) === OPEN_BRACE_CODE) {
      const configObject = parseJsonObjectFromOffset(pageHtml, firstTokenOffset);
      if (configObject) {
        const playerConfig = tryDecodePlayerConfig(configObject);
        if (playerConfig) {
          return playerConfig;
        }
      }
    }
    markerOffset = pageHtml.indexOf(
      YOUTUBE_INITIAL_CONFIG_MARKER,
      markerOffset + YOUTUBE_INITIAL_CONFIG_MARKER.length,
    );
  }
  return null;
};

const isNonNegativeInteger = (numericValue: number): boolean =>
  Number.isFinite(numericValue) && numericValue >= 0 && Number.isInteger(numericValue);

const parseSignatureTimestamp = (
  playerConfig: YoutubePlayerConfig | null,
  pageHtml: string | null,
): number | null => {
  if (playerConfig?.STS !== undefined) {
    const declaredTimestamp = Number(playerConfig.STS);
    if (isNonNegativeInteger(declaredTimestamp)) {
      return declaredTimestamp;
    }
  }
  if (!pageHtml) {
    return null;
  }
  const signatureMatch = SIGNATURE_TIMESTAMP_PATTERN.exec(pageHtml);
  if (!signatureMatch) {
    return null;
  }
  const extractedTimestamp = Number.parseInt(
    signatureMatch.groups?.signatureTimestamp ?? '',
    10,
  );
  return isNonNegativeInteger(extractedTimestamp) ? extractedTimestamp : null;
};

const getLanguageHint = (playerConfig: YoutubePlayerConfig | null): string =>
  playerConfig?.INNERTUBE_CONTEXT?.client.hl ?? DEFAULT_LANGUAGE_HINT;

const getPlaybackRegion = (playerConfig: YoutubePlayerConfig | null): string =>
  playerConfig?.INNERTUBE_CONTEXT?.client.gl ?? DEFAULT_REGION_HINT;

const createPlayerApiUrl = (innertubeHost: string, apiKey: string): string => {
  const encodedKey = encodeURIComponent(apiKey);
  return `https://${innertubeHost}${YOUTUBE_PLAYER_API_PATH}?key=${encodedKey}&${YOUTUBE_PRETTY_PRINT_QUERY}`;
};

const resolveClientVersion = (
  clientProfile: PlayerClientProfile,
  webClientVersionOverride: string | null,
): string => {
  if (clientProfile.clientName === WEB_CLIENT_NAME && webClientVersionOverride) {
    return webClientVersionOverride;
  }
  return clientProfile.clientVersion;
};

const resolveApiKey = (
  clientProfile: PlayerClientProfile,
  playerConfig: YoutubePlayerConfig | null,
): string => {
  if (clientProfile.clientName === WEB_CLIENT_NAME && playerConfig?.INNERTUBE_API_KEY) {
    return playerConfig.INNERTUBE_API_KEY;
  }
  return clientProfile.apiKey;
};

const createPlayerRequestBody = (
  videoId: string,
  clientProfile: PlayerClientProfile,
  languageHint: string,
  regionHint: string,
  signatureTimestamp: number | null,
  webClientVersionOverride: string | null,
  visitorData: string | null,
): Record<string, unknown> => {
  const clientContext: Record<string, unknown> = {
    hl: languageHint,
    gl: regionHint,
    clientName: clientProfile.clientName,
    clientVersion: resolveClientVersion(clientProfile, webClientVersionOverride),
    userAgent: clientProfile.userAgent,
    ...clientProfile.extraClientFields,
  };
  if (visitorData) {
    // Attaching a fresh visitorData makes YouTube serve adaptive stream URLs directly.
    clientContext.visitorData = visitorData;
  }

  const requestContext: Record<string, unknown> = {
    client: clientContext,
    user: {
      lockedSafetyMode: false,
    },
    request: {
      useSsl: true,
    },
  };

  if (clientProfile.useEmbeddedThirdParty) {
    requestContext.thirdParty = {
      embedUrl: EMBED_URL,
    };
  }

  const playerRequestBody: Record<string, unknown> = {
    context: requestContext,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  if (signatureTimestamp !== null) {
    playerRequestBody.playbackContext = {
      contentPlaybackContext: {
        html5Preference: HTML5_PREFERENCE,
        signatureTimestamp,
      },
    };
  }

  return playerRequestBody;
};

const composePlayerApiHeaders = (
  clientProfile: PlayerClientProfile,
  watchUrl: string,
  clientVersion: string,
  visitorData: string | null,
): Record<string, string> => {
  const playerApiHeaders: Record<string, string> = {
    [CONTENT_TYPE_HEADER]: CONTENT_TYPE_JSON,
    Origin: `https://${clientProfile.innertubeHost}`,
    Referer: watchUrl,
    [USER_AGENT_HEADER]: clientProfile.userAgent,
    [ACCEPT_HEADER]: ACCEPT_ALL,
    'X-Youtube-Client-Name': clientProfile.clientId,
    'X-Youtube-Client-Version': clientVersion,
  };
  if (visitorData) {
    playerApiHeaders['X-Goog-Visitor-Id'] = visitorData;
  }
  return playerApiHeaders;
};

const requestPlayerPayloadWithProfile = async (
  videoId: string,
  watchUrl: string,
  clientProfile: PlayerClientProfile,
  languageHint: string,
  regionHint: string,
  signatureTimestamp: number | null,
  webClientVersionOverride: string | null,
  playerConfig: YoutubePlayerConfig | null,
  poToken: string | null,
  visitorData: string | null,
): Promise<unknown> => {
  const clientVersion = resolveClientVersion(clientProfile, webClientVersionOverride);
  const basePlayerBody = createPlayerRequestBody(
    videoId,
    clientProfile,
    languageHint,
    regionHint,
    signatureTimestamp,
    webClientVersionOverride,
    visitorData,
  );
  const playerRequestBody = attachPoTokenToPlayerBody(basePlayerBody, poToken);
  const playerApiUrl = createPlayerApiUrl(
    clientProfile.innertubeHost,
    resolveApiKey(clientProfile, playerConfig),
  );

  return fetchJsonResource<unknown>(playerApiUrl, playerRequestBody, {
    method: 'POST',
    headers: composePlayerApiHeaders(clientProfile, watchUrl, clientVersion, visitorData),
  });
};

const requestCaptionTracksWithProfile = async (
  videoId: string,
  watchUrl: string,
  clientProfile: PlayerClientProfile,
  languageHint: string,
  regionHint: string,
  signatureTimestamp: number | null,
  webClientVersionOverride: string | null,
  playerConfig: YoutubePlayerConfig | null,
  poToken: string | null,
  visitorData: string | null,
): Promise<YoutubeCaptionTrack[]> => {
  const playerPayload = await requestPlayerPayloadWithProfile(
    videoId,
    watchUrl,
    clientProfile,
    languageHint,
    regionHint,
    signatureTimestamp,
    webClientVersionOverride,
    playerConfig,
    poToken,
    visitorData,
  );
  return parseTracksFromPayload(playerPayload);
};

const hasUsableStreamingData = (playerPayload: unknown): boolean => {
  // Streaming formats (progressive `formats` or `adaptiveFormats`) mean a playable media set exists.
  if (!playerPayload || typeof playerPayload !== 'object' || Array.isArray(playerPayload)) {
    return false;
  }
  const streamingData = (playerPayload as Record<string, unknown>).streamingData;
  if (!streamingData || typeof streamingData !== 'object' || Array.isArray(streamingData)) {
    return false;
  }
  const streamingDataObject = streamingData as Record<string, unknown>;
  const progressiveFormats = streamingDataObject.formats;
  const adaptiveFormats = streamingDataObject.adaptiveFormats;
  const hasProgressiveFormats = Array.isArray(progressiveFormats) && progressiveFormats.length > 0;
  const hasAdaptiveFormats = Array.isArray(adaptiveFormats) && adaptiveFormats.length > 0;
  return hasProgressiveFormats || hasAdaptiveFormats;
};

const tryOnePlayerPayload = async (
  videoId: string,
  watchUrl: string,
  clientProfile: PlayerClientProfile,
  languageHint: string,
  regionHint: string,
  signatureTimestamp: number | null,
  webClientVersionOverride: string | null,
  playerConfig: YoutubePlayerConfig | null,
  poToken: string | null,
  visitorData: string | null,
): Promise<unknown | null> => {
  try {
    const playerPayload = await requestPlayerPayloadWithProfile(
      videoId,
      watchUrl,
      clientProfile,
      languageHint,
      regionHint,
      signatureTimestamp,
      webClientVersionOverride,
      playerConfig,
      poToken,
      visitorData,
    );
    if (hasUsableStreamingData(playerPayload)) {
      return playerPayload;
    }
    logWarn(
      `[${videoId}] ${LOG_CLIENT_PREFIX} ${clientProfile.profileLabel} ${LOG_CLIENT_NO_STREAMS}`,
    );
    return null;
  } catch (clientError) {
    logWarn(
      `[${videoId}] ${LOG_CLIENT_PREFIX} ${clientProfile.profileLabel} ${LOG_CLIENT_FAILED}: ${String(clientError)}`,
    );
    return null;
  }
};

const orderPlayerClientProfiles = async (): Promise<PlayerClientProfile[]> => {
  // 1) Prefer sticky last-good client for subsequent videos in the same process.
  // 2) Otherwise walk preferred order from config (android first by default).
  const clientConfig = await loadPlayerClientConfig();
  const preferredOrder = await getPreferredClientOrder();
  const configuredProfiles = applyClientOverrides(PLAYER_CLIENT_PROFILES, clientConfig);
  const profilesByLabel = new Map(
    configuredProfiles.map((clientProfile) => [clientProfile.profileLabel, clientProfile]),
  );
  const orderedProfiles: PlayerClientProfile[] = [];
  const seenLabels = new Set<string>();

  const pushProfileLabel = (profileLabel: string): void => {
    if (seenLabels.has(profileLabel)) {
      return;
    }
    const clientProfile = profilesByLabel.get(profileLabel);
    if (!clientProfile) {
      return;
    }
    seenLabels.add(profileLabel);
    orderedProfiles.push(clientProfile);
  };

  if (stickyPlayerClientLabel) {
    pushProfileLabel(stickyPlayerClientLabel);
  }
  for (const preferredLabel of preferredOrder) {
    pushProfileLabel(preferredLabel);
  }
  for (const preferredLabel of PREFERRED_CLIENT_ORDER) {
    pushProfileLabel(preferredLabel);
  }
  for (const clientProfile of configuredProfiles) {
    pushProfileLabel(clientProfile.profileLabel);
  }
  return orderedProfiles;
};

const tryOnePlayerClient = async (
  videoId: string,
  watchUrl: string,
  clientProfile: PlayerClientProfile,
  languageHint: string,
  regionHint: string,
  signatureTimestamp: number | null,
  webClientVersionOverride: string | null,
  playerConfig: YoutubePlayerConfig | null,
  poToken: string | null,
  visitorData: string | null,
): Promise<YoutubeCaptionTrack[] | null> => {
  try {
    const captionTracks = await requestCaptionTracksWithProfile(
      videoId,
      watchUrl,
      clientProfile,
      languageHint,
      regionHint,
      signatureTimestamp,
      webClientVersionOverride,
      playerConfig,
      poToken,
      visitorData,
    );
    if (captionTracks.length > 0) {
      return captionTracks;
    }
    logWarn(
      `[${videoId}] ${LOG_CLIENT_PREFIX} ${clientProfile.profileLabel} ${LOG_CLIENT_EMPTY}`,
    );
    return null;
  } catch (clientError) {
    logWarn(
      `[${videoId}] ${LOG_CLIENT_PREFIX} ${clientProfile.profileLabel} ${LOG_CLIENT_FAILED}: ${String(clientError)}`,
    );
    return null;
  }
};

export const fetchTracksFromPlayerApi = async (
  watchUrl: string,
  videoId: string,
  pageHtml: string | null,
): Promise<YoutubeCaptionTrack[]> => {
  const playerConfig = parsePlayerConfig(pageHtml);
  const signatureTimestamp = parseSignatureTimestamp(playerConfig, pageHtml);
  const languageHint = getLanguageHint(playerConfig);
  const regionHint = getPlaybackRegion(playerConfig);
  const webClientVersionOverride = playerConfig?.INNERTUBE_CONTEXT_CLIENT_VERSION ?? null;
  const orderedProfiles = await orderPlayerClientProfiles();
  const poToken = await resolveOptionalPoToken(videoId);
  const raceClientCount = stickyPlayerClientLabel ? 1 : await getRaceClientCount();

  if (stickyPlayerClientLabel) {
    logInfo(`[${videoId}] ${LOG_STICKY_CLIENT}: ${stickyPlayerClientLabel}`);
  }

  // Cold miss: race top N clients; first non-empty tracks win (lower p99).
  if (!stickyPlayerClientLabel && raceClientCount > 1 && orderedProfiles.length > 1) {
    const raceProfiles = orderedProfiles.slice(0, Math.min(raceClientCount, orderedProfiles.length));
    logInfo(
      `[${videoId}] racing player clients: ${raceProfiles.map((profile) => profile.profileLabel).join(', ')}`,
    );
    const raceResults = await Promise.all(
      raceProfiles.map(async (clientProfile) => {
        const captionTracks = await tryOnePlayerClient(
          videoId,
          watchUrl,
          clientProfile,
          languageHint,
          regionHint,
          signatureTimestamp,
          webClientVersionOverride,
          playerConfig,
          poToken,
          null,
        );
        return { clientProfile, captionTracks };
      }),
    );
    const raceWinner = raceResults.find(
      (raceResult) => raceResult.captionTracks && raceResult.captionTracks.length > 0,
    );
    if (raceWinner?.captionTracks) {
      stickyPlayerClientLabel = raceWinner.clientProfile.profileLabel;
      logInfo(
        `[${videoId}] ${LOG_CLIENT_PREFIX} ${raceWinner.clientProfile.profileLabel} ok (${raceWinner.captionTracks.length} tracks, race)`,
      );
      return raceWinner.captionTracks;
    }
  }

  // Serial walk (after failed race, skip clients already tried in the race).
  const serialStartIndex =
    !stickyPlayerClientLabel && raceClientCount > 1
      ? Math.min(raceClientCount, orderedProfiles.length)
      : 0;

  for (let profileIndex = serialStartIndex; profileIndex < orderedProfiles.length; profileIndex += 1) {
    const clientProfile = orderedProfiles[profileIndex];
    const captionTracks = await tryOnePlayerClient(
      videoId,
      watchUrl,
      clientProfile,
      languageHint,
      regionHint,
      signatureTimestamp,
      webClientVersionOverride,
      playerConfig,
      poToken,
      null,
    );
    if (captionTracks && captionTracks.length > 0) {
      stickyPlayerClientLabel = clientProfile.profileLabel;
      logInfo(
        `[${videoId}] ${LOG_CLIENT_PREFIX} ${clientProfile.profileLabel} ok (${captionTracks.length} tracks)`,
      );
      return captionTracks;
    }

    if (profileIndex < orderedProfiles.length - 1) {
      await sleepBriefly(CLIENT_ATTEMPT_DELAY_MS);
    }
  }

  return [];
};

export type PlayerPayloadWithClient = {
  clientProfile?: PlayerClientProfile;
  playerPayload: unknown;
};

export const fetchPlayerPayloadFromPlayerApi = async (
  watchUrl: string,
  videoId: string,
  pageHtml: string | null,
): Promise<PlayerPayloadWithClient | null> => {
  const playerConfig = parsePlayerConfig(pageHtml);
  const signatureTimestamp = parseSignatureTimestamp(playerConfig, pageHtml);
  const languageHint = getLanguageHint(playerConfig);
  const regionHint = getPlaybackRegion(playerConfig);
  const webClientVersionOverride = playerConfig?.INNERTUBE_CONTEXT_CLIENT_VERSION ?? null;
  const orderedProfiles = await orderPlayerClientProfiles();
  const poToken = await resolveOptionalPoToken(videoId);

  const walkForPlayerPayload = async (
    clientProfiles: readonly PlayerClientProfile[],
    visitorData: string | null,
  ): Promise<{ clientProfile: PlayerClientProfile; playerPayload: unknown } | null> => {
    for (const clientProfile of clientProfiles) {
      const playerPayload = await tryOnePlayerPayload(
        videoId,
        watchUrl,
        clientProfile,
        languageHint,
        regionHint,
        signatureTimestamp,
        webClientVersionOverride,
        playerConfig,
        poToken,
        visitorData,
      );
      if (playerPayload) {
        return { clientProfile, playerPayload };
      }
      if (clientProfile !== clientProfiles[clientProfiles.length - 1]) {
        await sleepBriefly(CLIENT_ATTEMPT_DELAY_MS);
      }
    }
    return null;
  };

  // Serial client walk: first payload with usable streaming formats wins.
  const firstPass = await walkForPlayerPayload(orderedProfiles, null);
  if (!firstPass) {
    return null;
  }

  // Re-fetch with the fresh visitorData attached so the adaptive stream URLs
  // YouTube returns are actually servable (no PO token needed). ANDROID_VR
  // URLs serve full adaptive files, while plain ANDROID URLs stay chunk-capped.
  const responseContext = (firstPass.playerPayload as Record<string, unknown> | null)
    ?.responseContext as Record<string, unknown> | null | undefined;
  const bootstrapVisitorData =
    typeof responseContext?.visitorData === 'string' && responseContext.visitorData.length > 0
      ? responseContext.visitorData
      : null;
  if (bootstrapVisitorData) {
    const vrProfile =
      orderedProfiles.find((clientProfile) => clientProfile.profileLabel === 'android_vr')
      ?? firstPass.clientProfile;
    const unlockedPass = await walkForPlayerPayload([vrProfile], bootstrapVisitorData);
    if (unlockedPass) {
      logInfo(`[${videoId}] ${LOG_VISITOR_BOOTSTRAP}`);
      stickyPlayerClientLabel = unlockedPass.clientProfile.profileLabel;
      return unlockedPass;
    }
  }

  stickyPlayerClientLabel = firstPass.clientProfile.profileLabel;
  logInfo(
    `[${videoId}] ${LOG_CLIENT_PREFIX} ${firstPass.clientProfile.profileLabel} ok (streaming formats)`,
  );
  return firstPass;
};

// Test/benchmark helper: clear sticky client between runs.
export const resetStickyPlayerClient = (): void => {
  stickyPlayerClientLabel = null;
};
