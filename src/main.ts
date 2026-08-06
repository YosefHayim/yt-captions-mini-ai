import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentArtifactPaths,
  AgentMetricsFile,
  AgentRunMetrics,
  CaptionDownload,
  CliOptions,
  LocalAgent,
  OutputFormat,
  SubtitleFormat,
  TranscriptArtifact,
  TranscriptBundle,
  YoutubeCaptionTrack,
} from './types.js';
import { fetchTextResourceOptional } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { chooseTrackFromParsedTracks, composeCaptionRequestUrl, parseTracksFromPayload } from './captions.js';
import { getPlaylistIdFromUrl, isYoutubePlaylistUrl, collectPlaylistVideoIds } from './playlist.js';
import {
  fetchChannelTabVideoIds,
  getChannelBulkFolderName,
  getChannelLabel,
  isYoutubeChannelUrl,
  normalizeChannelTabUrl,
  resolveChannelTabKind,
} from './channel.js';
import { parseCliArguments } from './cli.js';
import { logInfo, logWarn, logError } from './log.js';
import { convertCaptionSourceToOutput } from './output.js';
import { fetchTracksFromPlayerApi } from './player-api.js';
import { runLocalAgent } from './agent.js';
import { requireAgentModel, sanitizeModelFolderName } from './agentModels.js';
import { loadNetscapeCookieFile } from './cookies.js';
import { parseSkillPackage, persistSkillPackage } from './skill-output.js';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  FILE_ENCODING,
  NEWLINE: STDOUT_LINE_FEED,
  FILE_PATH_EXTENSION_SEPARATOR,
  LIST_SEPARATOR: LOG_TRACKS_MESSAGE_SEPARATOR,
  YOUTUBE_BASE_URL,
  WATCH_QUERY_PREFIX,
  PLAYLIST_PATH_PREFIX,
  YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER: YOU_TUBE_INITIAL_PLAYER_RESPONSE_MARKER,
  YOUTUBE_INITIAL_DATA_MARKER: YOU_TUBE_INITIAL_DATA_MARKER,
  VIDEO_ID_PATTERN: SOURCE_BARE_ID_PATTERN,
  VIDEO_ID_CAPTURE_GROUP,
  JSON_INDENT: METRICS_JSON_INDENT,
} = CONSTANTS.shared;
const {
  SOURCE_WATCH_ID_PATTERN,
  SOURCE_SHORTS_ID_PATTERN,
  VIDEO_INDEX_OFFSET,
  SHORT_DELAY_MS,
  EXIT_CODE_FAILURE,
  LOG_TRACKS_NOT_FOUND,
  LOG_PLAYLIST_NOT_FOUND,
  LOG_NO_TRACK,
  LOG_EMPTY_OUTPUT,
  LOG_INVALID_VIDEO_ID,
  LOG_MISSING_PLAYER_PAYLOAD,
  LOG_MISSING_DATA_PAYLOAD,
  LOG_PLAYLIST_FETCHED,
  LOG_PLAYLIST_COUNT_MESSAGE,
  LOG_CHANNEL_FETCHED,
  LOG_CHANNEL_COUNT_MESSAGE,
  LOG_CHANNEL_URL,
  LOG_CHANNEL_OUT_DIR,
  LOG_VIDEO_PROGRESS,
  LOG_PLAYLIST_VIDEO_SKIPPED,
  LOG_CHANNEL_NOT_FOUND,
  LOG_TRACKS_PREFIX,
  LOG_FALLBACK_TRACKS_PREFIX,
  LOG_MULTI_CLIENT_TRACKS_PREFIX,
  LOG_WATCH_HTML_SKIPPED,
  LOG_COOKIES_LOADED,
  LOG_VIDEO_OUTPUT_TEMPLATE,
  LOG_AGENT_OUTPUT_TEMPLATE,
  LOG_AGENT_CAPTION_TEMPLATE,
  LOG_AGENT_METRICS_TEMPLATE,
  LOG_AGENT_PACKAGE_TEMPLATE,
  LOG_AGENT_SKILL_DIRS_TEMPLATE,
  AGENT_FOLDER_NAME,
  AGENT_METRICS_EXTENSION,
  AGENT_CAPTION_EXTENSION,
  AGENT_RAW_RESPONSE_EXTENSION,
  LOG_AGENT_EMPTY,
  LOG_AGENT_STARTED,
} = CONSTANTS.main;

const renderSubtitleFilePath = (
  outDirectory: string,
  videoId: string,
  languageTag: string,
  fileFormat: SubtitleFormat | OutputFormat,
): string =>
  path.join(
    outDirectory,
    `${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${fileFormat}`,
  );

const renderAgentModelFolder = (agentModel: string | null, reasoningEffort: string | null): string => {
  // Folder slug: model id, plus optional effort so multi-effort runs do not collide.
  const modelSlug = agentModel ? sanitizeModelFolderName(agentModel) : 'default';
  if (!reasoningEffort) {
    return modelSlug;
  }
  return `${modelSlug}_effort-${sanitizeModelFolderName(reasoningEffort)}`;
};

const renderAgentVideoPackageDirectory = (
  outDirectory: string,
  localAgent: LocalAgent,
  agentModel: string | null,
  reasoningEffort: string | null,
  videoId: string,
): string =>
  path.join(
    outDirectory,
    AGENT_FOLDER_NAME,
    localAgent,
    renderAgentModelFolder(agentModel, reasoningEffort),
    videoId,
  );

const persistCaptions = async (
  outDirectory: string,
  outputFormat: SubtitleFormat | OutputFormat,
  outputContent: string,
  videoId: string,
  languageTag: string,
): Promise<string> => {
  await mkdir(outDirectory, { recursive: true });
  const outputFile = renderSubtitleFilePath(outDirectory, videoId, languageTag, outputFormat);
  await writeFile(outputFile, outputContent, FILE_ENCODING);
  return outputFile;
};

const persistAgentArtifacts = async (
  outDirectory: string,
  localAgent: LocalAgent,
  agentModel: string | null,
  reasoningEffort: string | null,
  videoId: string,
  languageTag: string,
  captionBody: string,
  skillBody: string,
  runMetrics: AgentRunMetrics,
): Promise<AgentArtifactPaths> => {
  // 1) Create agents/<agent>/<model[_effort]>/<videoId>/ package root.
  const packageDirectory = renderAgentVideoPackageDirectory(
    outDirectory,
    localAgent,
    agentModel,
    reasoningEffort,
    videoId,
  );
  await mkdir(packageDirectory, { recursive: true });

  // 2) Parse official multi-skill file markers (or single SKILL.md fallback).
  const skillPackage = parseSkillPackage(skillBody);
  const skillFiles = await persistSkillPackage(packageDirectory, skillPackage);

  // 3) Keep transcript + raw agent response + metrics next to the skill package.
  const captionFile = path.join(packageDirectory, `${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${AGENT_CAPTION_EXTENSION}`);
  const rawResponseFile = path.join(packageDirectory, AGENT_RAW_RESPONSE_EXTENSION);
  const metricsFile = path.join(packageDirectory, AGENT_METRICS_EXTENSION);
  await writeFile(captionFile, captionBody, FILE_ENCODING);
  await writeFile(rawResponseFile, skillBody, FILE_ENCODING);
  const metricsFileBody: AgentMetricsFile = {
    ...runMetrics,
    skillDirectoryNames: skillPackage.skillDirectoryNames,
    skillFiles,
  };
  await writeFile(
    metricsFile,
    `${JSON.stringify(metricsFileBody, null, METRICS_JSON_INDENT)}${STDOUT_LINE_FEED}`,
    FILE_ENCODING,
  );

  if (skillPackage.skillDirectoryNames.length > 0) {
    logInfo(`${LOG_AGENT_SKILL_DIRS_TEMPLATE} ${skillPackage.skillDirectoryNames.join(', ')}`);
  }

  return { packageDirectory, captionFile, skillFiles, metricsFile };
};

const resolveVideoId = (sourceUrl: string): string | null => {
  if (SOURCE_BARE_ID_PATTERN.test(sourceUrl)) {
    return sourceUrl;
  }
  const watchMatch = SOURCE_WATCH_ID_PATTERN.exec(sourceUrl);
  if (watchMatch) {
    return watchMatch[VIDEO_ID_CAPTURE_GROUP];
  }
  const shortsMatch = SOURCE_SHORTS_ID_PATTERN.exec(sourceUrl);
  if (shortsMatch) {
    return shortsMatch[VIDEO_ID_CAPTURE_GROUP];
  }
  return null;
};

const getWatchUrl = (sourceUrl: string): string => {
  const videoId = resolveVideoId(sourceUrl);
  return videoId ? `${WATCH_QUERY_PREFIX}${videoId}` : sourceUrl;
};

const extractVideoTitleFromPlayerPayload = (
  playerPayload: Record<string, unknown>,
): string | null => {
  // ytInitialPlayerResponse.videoDetails.title is the watch-page title.
  const videoDetails = playerPayload.videoDetails;
  if (!videoDetails || typeof videoDetails !== 'object' || Array.isArray(videoDetails)) {
    return null;
  }
  const titleValue = (videoDetails as Record<string, unknown>).title;
  if (typeof titleValue !== 'string') {
    return null;
  }
  const trimmedTitle = titleValue.trim();
  return trimmedTitle.length > 0 ? trimmedTitle : null;
};

const fetchOEmbedVideoTitle = async (canonicalWatchUrl: string): Promise<string | null> => {
  // Public oEmbed endpoint: works even when watch HTML is blocked/throttled.
  const oembedUrl = `${YOUTUBE_BASE_URL}/oembed?url=${encodeURIComponent(canonicalWatchUrl)}&format=json`;
  const oembedReply = await fetchTextResourceOptional(oembedUrl);
  if (!oembedReply) {
    return null;
  }
  try {
    const parsedBody = JSON.parse(oembedReply.bodyText) as { title?: unknown };
    if (typeof parsedBody.title !== 'string') {
      return null;
    }
    const trimmedTitle = parsedBody.title.trim();
    return trimmedTitle.length > 0 ? trimmedTitle : null;
  } catch {
    return null;
  }
};

const resolveVideoName = async (
  pageHtml: string | null,
  canonicalWatchUrl: string,
): Promise<string | null> => {
  // Prefer embedded player metadata; fall back to oEmbed when HTML is missing/incomplete.
  if (pageHtml) {
    const playerPayload = extractEmbeddedJson(pageHtml, YOU_TUBE_INITIAL_PLAYER_RESPONSE_MARKER);
    if (playerPayload) {
      const titleFromPlayer = extractVideoTitleFromPlayerPayload(playerPayload);
      if (titleFromPlayer) {
        return titleFromPlayer;
      }
    }
  }
  return fetchOEmbedVideoTitle(canonicalWatchUrl);
};

const logTrackSummary = (videoId: string, sourceLabel: string, tracks: YoutubeCaptionTrack[]): void => {
  const languageLabels = tracks.map((trackEntry) => trackEntry.languageTag);
  const uniqueLabels = [...new Set(languageLabels)];
  const trackSummary =
    uniqueLabels.length > 0 ? uniqueLabels.join(LOG_TRACKS_MESSAGE_SEPARATOR) : LOG_TRACKS_NOT_FOUND;
  logInfo(`[${videoId}] ${sourceLabel} ${trackSummary}`);
};

const getCaptionSourceBody = async (
  trackEntry: YoutubeCaptionTrack,
  fileFormat: SubtitleFormat,
): Promise<string | null> => {
  const captionRequestUrl = composeCaptionRequestUrl(trackEntry.baseUrl, fileFormat);
  const captionFetch = await fetchTextResourceOptional(captionRequestUrl);
  if (!captionFetch) {
    return null;
  }
  const captionBody = captionFetch.bodyText.trim();
  return captionBody.length > 0 ? captionBody : null;
};

const loadCaptionTracksForVideo = async (
  videoId: string,
  canonicalWatchUrl: string,
): Promise<{ captionTracks: YoutubeCaptionTrack[]; pageHtml: string | null }> => {
  const watchPage = await fetchTextResourceOptional(canonicalWatchUrl);
  const pageHtml = watchPage?.bodyText ?? null;

  let captionTracks: YoutubeCaptionTrack[] = [];
  if (pageHtml) {
    const playerPayload = extractEmbeddedJson(pageHtml, YOU_TUBE_INITIAL_PLAYER_RESPONSE_MARKER);
    if (playerPayload) {
      captionTracks = parseTracksFromPayload(playerPayload);
      logTrackSummary(videoId, LOG_TRACKS_PREFIX, captionTracks);
    } else {
      logWarn(`[${videoId}] ${LOG_MISSING_PLAYER_PAYLOAD} ${videoId}`);
    }
  } else {
    logWarn(`[${videoId}] ${LOG_WATCH_HTML_SKIPPED}`);
  }

  if (captionTracks.length === 0) {
    captionTracks = await fetchTracksFromPlayerApi(canonicalWatchUrl, videoId, pageHtml);
    logTrackSummary(videoId, LOG_MULTI_CLIENT_TRACKS_PREFIX, captionTracks);
  }

  return { captionTracks, pageHtml };
};

const buildTranscriptBundleFromVideo = async (
  sourceUrl: string,
  options: CliOptions,
): Promise<TranscriptBundle> => {
  const videoId = resolveVideoId(sourceUrl);
  if (!videoId) {
    throw new Error(`${LOG_INVALID_VIDEO_ID} ${sourceUrl}`);
  }

  const canonicalWatchUrl = getWatchUrl(sourceUrl);
  const trackLoad = await loadCaptionTracksForVideo(videoId, canonicalWatchUrl);
  const pageHtml = trackLoad.pageHtml;
  let discoveredTracks = trackLoad.captionTracks;
  let captionTrack = chooseTrackFromParsedTracks(
    discoveredTracks,
    options.languageTokens,
    options.includeAutoCaptions,
  );

  if (!captionTrack) {
    const apiTracks = await fetchTracksFromPlayerApi(canonicalWatchUrl, videoId, pageHtml);
    if (!apiTracks.length) {
      throw new Error(`${LOG_NO_TRACK} ${videoId}`);
    }
    discoveredTracks = apiTracks;
    logTrackSummary(videoId, LOG_FALLBACK_TRACKS_PREFIX, apiTracks);
    captionTrack = chooseTrackFromParsedTracks(
      apiTracks,
      options.languageTokens,
      options.includeAutoCaptions,
    );
    if (!captionTrack) {
      throw new Error(`${LOG_NO_TRACK} ${videoId}`);
    }
  }

  let didFallbackUse = false;
  const loadTracksFromApiOnce = async (): Promise<YoutubeCaptionTrack[]> => {
    const apiTracks = await fetchTracksFromPlayerApi(canonicalWatchUrl, videoId, pageHtml);
    if (!apiTracks.length) {
      return [];
    }
    didFallbackUse = true;
    logTrackSummary(videoId, LOG_FALLBACK_TRACKS_PREFIX, apiTracks);
    return apiTracks;
  };

  const transcriptArtifacts: TranscriptArtifact[] = [];
  let localAgentTranscript = EMPTY_VALUE;

  for (const subtitleFormat of options.formats) {
    let captionBody = await getCaptionSourceBody(captionTrack, subtitleFormat);

    if (!captionBody && !didFallbackUse) {
      const apiTracks = await loadTracksFromApiOnce();
      if (!apiTracks.length) {
        throw new Error(`${LOG_NO_TRACK} ${videoId}`);
      }

      const fallbackTrack = chooseTrackFromParsedTracks(
        apiTracks,
        options.languageTokens,
        options.includeAutoCaptions,
      );
      if (!fallbackTrack) {
        throw new Error(`${LOG_NO_TRACK} ${videoId}`);
      }

      captionTrack = fallbackTrack;
      captionBody = await getCaptionSourceBody(captionTrack, subtitleFormat);
    }

    if (!captionBody) {
      throw new Error(`${LOG_EMPTY_OUTPUT} ${videoId}`);
    }

    const subtitleDownload: CaptionDownload = {
      videoId,
      languageTag: captionTrack.languageTag,
      fileFormat: subtitleFormat,
      fileContent: captionBody,
    };
    const transformedSubtitle = convertCaptionSourceToOutput(subtitleDownload, options.exportFormat);
    const outputContent = transformedSubtitle.outputContent.trim();
    if (!outputContent.length) {
      throw new Error(`${LOG_EMPTY_OUTPUT} ${videoId}`);
    }

    if (localAgentTranscript.length === 0) {
      const plainTranscript = convertCaptionSourceToOutput(subtitleDownload, 'txt');
      localAgentTranscript = plainTranscript.outputContent.trim();
    }

    let outputFile: string | null = null;
    if (options.writeToStdout) {
      console.log(
        `${STDOUT_LINE_FEED}--- ${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${captionTrack.languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${transformedSubtitle.outputFormat} ---${STDOUT_LINE_FEED}${outputContent}`,
      );
    } else {
      outputFile = await persistCaptions(
        options.outDirectory,
        transformedSubtitle.outputFormat,
        outputContent,
        subtitleDownload.videoId,
        subtitleDownload.languageTag,
      );
      logInfo(`${LOG_VIDEO_OUTPUT_TEMPLATE} ${outputFile}`);
    }

    transcriptArtifacts.push({
      videoId,
      languageTag: subtitleDownload.languageTag,
      sourceFormat: subtitleDownload.fileFormat,
      outputFormat: transformedSubtitle.outputFormat,
      outputText: outputContent,
      outputPath: outputFile,
    });
  }

  if (transcriptArtifacts.length === 0) {
    throw new Error(`${LOG_EMPTY_OUTPUT} ${videoId}`);
  }

  const videoName = await resolveVideoName(pageHtml, canonicalWatchUrl);
  const videoUrl = `${WATCH_QUERY_PREFIX}${videoId}`;

  return {
    videoId,
    videoName,
    videoUrl,
    languageTag: transcriptArtifacts[0].languageTag,
    artifacts: transcriptArtifacts,
    localAgentTranscript,
  };
};

const runAndPersistAgent = async (options: CliOptions, bundle: TranscriptBundle): Promise<void> => {
  if (!options.localAgent) {
    return;
  }
  if (bundle.localAgentTranscript.length === 0) {
    throw new Error(`${LOG_AGENT_EMPTY} ${bundle.videoId}`);
  }

  // Fail fast when model= is set but not listed by the agent CLI.
  const resolvedModel = requireAgentModel(options.localAgent, options.agentModel);
  const agentModelId = resolvedModel?.modelId ?? options.agentModel;
  const modelLabel = agentModelId ?? 'default';
  logInfo(
    `${LOG_AGENT_STARTED} ${options.localAgent} model=${modelLabel}` +
      (options.reasoningEffort ? ` effort=${options.reasoningEffort}` : '') +
      ` ${bundle.videoId}`,
  );
  const agentOutput = await runLocalAgent({
    localAgent: options.localAgent,
    systemPrompt: options.systemPrompt,
    languageTag: bundle.languageTag,
    transcriptBody: bundle.localAgentTranscript,
    videoId: bundle.videoId,
    videoName: bundle.videoName,
    videoUrl: bundle.videoUrl,
    agentModel: agentModelId,
    reasoningEffort: options.reasoningEffort,
  });
  if (agentOutput.skillBody.length === 0) {
    throw new Error(`${LOG_AGENT_EMPTY} ${bundle.videoId}`);
  }

  const agentFiles = await persistAgentArtifacts(
    options.outDirectory,
    options.localAgent,
    agentModelId,
    options.reasoningEffort,
    bundle.videoId,
    bundle.languageTag,
    bundle.localAgentTranscript,
    agentOutput.skillBody,
    agentOutput.runMetrics,
  );
  logInfo(`${LOG_AGENT_PACKAGE_TEMPLATE} ${agentFiles.packageDirectory}`);
  logInfo(`${LOG_AGENT_CAPTION_TEMPLATE} ${agentFiles.captionFile}`);
  for (const skillFile of agentFiles.skillFiles) {
    logInfo(`${LOG_AGENT_OUTPUT_TEMPLATE} ${skillFile}`);
  }
  logInfo(`${LOG_AGENT_METRICS_TEMPLATE} ${agentFiles.metricsFile}`);
};

const fetchPlaylistVideoIds = async (playlistId: string): Promise<string[]> => {
  const playlistPage = await fetchTextResourceOptional(`${PLAYLIST_PATH_PREFIX}${playlistId}`);
  if (!playlistPage) {
    throw new Error(`${LOG_MISSING_DATA_PAYLOAD} ${playlistId}`);
  }
  const playlistState = extractEmbeddedJson(playlistPage.bodyText, YOU_TUBE_INITIAL_DATA_MARKER);
  if (!playlistState) {
    throw new Error(`${LOG_MISSING_DATA_PAYLOAD} ${playlistId}`);
  }

  const playlistVideoIds: string[] = [];
  collectPlaylistVideoIds(playlistState, playlistVideoIds);
  return playlistVideoIds;
};

const configureSessionCookies = async (cookiesFilePath: string | null): Promise<void> => {
  if (!cookiesFilePath) {
    return;
  }
  const loadedCookieCount = await loadNetscapeCookieFile(cookiesFilePath);
  logInfo(`${LOG_COOKIES_LOADED} ${loadedCookieCount} from ${cookiesFilePath}`);
};

const processVideoIdList = async (
  videoIds: string[],
  options: CliOptions,
  bulkOutDirectory: string | null = null,
): Promise<void> => {
  // Shared loop for playlist + channel/shorts bulk caption/agent runs.
  // bulkOutDirectory overrides out-dir for channel-<name> / shorts-<name> folders.
  const runOptions: CliOptions =
    bulkOutDirectory === null
      ? options
      : {
          ...options,
          outDirectory: bulkOutDirectory,
        };

  for (let index = 0; index < videoIds.length; index += 1) {
    const videoId = videoIds[index];
    logInfo(`[#${index + VIDEO_INDEX_OFFSET}/${videoIds.length}] ${LOG_VIDEO_PROGRESS} ${videoId}`);
    try {
      const bundle = await buildTranscriptBundleFromVideo(`${WATCH_QUERY_PREFIX}${videoId}`, runOptions);
      await runAndPersistAgent(runOptions, bundle);
    } catch (downloadError) {
      logWarn(`${LOG_PLAYLIST_VIDEO_SKIPPED} ${videoId}: ${String(downloadError)}`);
    }
    await new Promise((wakeUp) => setTimeout(wakeUp, SHORT_DELAY_MS));
  }
};

const runForPlaylistUrl = async (playlistUrl: string, options: CliOptions): Promise<void> => {
  const listId = getPlaylistIdFromUrl(playlistUrl);
  if (!listId) {
    throw new Error(`Invalid playlist url: ${playlistUrl}`);
  }

  const videoIds = await fetchPlaylistVideoIds(listId);
  if (!videoIds.length) {
    throw new Error(`${LOG_PLAYLIST_NOT_FOUND} ${listId}`);
  }
  logInfo(`${LOG_PLAYLIST_FETCHED} ${listId}: ${videoIds.length} ${LOG_PLAYLIST_COUNT_MESSAGE}`);
  await processVideoIdList(videoIds, options, null);
};

const runForChannelUrl = async (channelUrl: string, options: CliOptions): Promise<void> => {
  // 1) Resolve Videos vs Shorts tab from the URL path.
  const channelTabKind = resolveChannelTabKind(channelUrl);
  const channelLabel = getChannelLabel(channelUrl);
  const channelTabUrl = normalizeChannelTabUrl(channelUrl, channelTabKind);
  const bulkFolderName = getChannelBulkFolderName(channelUrl, channelTabKind);
  const bulkOutDirectory = path.join(options.outDirectory, bulkFolderName);

  logInfo(`${LOG_CHANNEL_URL}: ${channelTabUrl}`);
  logInfo(`${LOG_CHANNEL_OUT_DIR}: ${bulkOutDirectory}`);

  // 2) Discover all video ids on that tab (with browse continuations).
  const videoIds = await fetchChannelTabVideoIds(channelUrl, channelTabKind);
  if (!videoIds.length) {
    throw new Error(`${LOG_CHANNEL_NOT_FOUND} ${channelLabel} (${channelTabKind})`);
  }
  logInfo(
    `${LOG_CHANNEL_FETCHED} ${channelLabel}: ${videoIds.length} ${LOG_CHANNEL_COUNT_MESSAGE} ${channelTabKind} tab`,
  );

  // 3) Write captions/agents under scraped-yt/channel-<name> or scraped-yt/shorts-<name>.
  await processVideoIdList(videoIds, options, bulkOutDirectory);
};

const run = async (): Promise<void> => {
  const cliValues = await parseCliArguments(process.argv.slice(2));
  const sourceUrl = cliValues.sourceUrl;
  const options = cliValues.options;
  await configureSessionCookies(options.cookiesFilePath);

  // Channel URLs first (handle / channel id), then playlists, then single video.
  if (isYoutubeChannelUrl(sourceUrl)) {
    await runForChannelUrl(sourceUrl, options);
    return;
  }

  if (isYoutubePlaylistUrl(sourceUrl) && !resolveVideoId(sourceUrl)) {
    await runForPlaylistUrl(sourceUrl, options);
    return;
  }

  const bundle = await buildTranscriptBundleFromVideo(sourceUrl, options);
  await runAndPersistAgent(options, bundle);
};

run().catch((runError) => {
  logError(String(runError instanceof Error ? runError.message : runError));
  process.exit(EXIT_CODE_FAILURE);
});
