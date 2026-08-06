import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fetchTextResource } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { chooseTrackFromParsedTracks, composeCaptionRequestUrl, parseTracksFromPayload } from './captions.js';
import { getPlaylistIdFromUrl, isYoutubePlaylistUrl, collectPlaylistVideoIds } from './playlist.js';
import { parseCliArguments } from './cli.js';
import { logInfo, logWarn, logError } from './log.js';
import { convertCaptionSourceToOutput } from './output.js';
import { fetchTracksFromPlayerApi } from './player-api.js';
import { runLocalAgent } from './agent.js';
const YOUTUBE_BASE_URL = 'https://www.youtube.com';
const WATCH_QUERY_PREFIX = `${YOUTUBE_BASE_URL}/watch?v=`;
const PLAYLIST_PATH_PREFIX = `${YOUTUBE_BASE_URL}/playlist?list=`;
const YOU_TUBE_INITIAL_PLAYER_RESPONSE_MARKER = 'ytInitialPlayerResponse = ';
const YOU_TUBE_INITIAL_DATA_MARKER = 'ytInitialData = ';
const SOURCE_WATCH_ID_PATTERN = /[?&]v=([A-Za-z0-9_-]{11})/;
const SOURCE_SHORTS_ID_PATTERN = /\/shorts\/([A-Za-z0-9_-]{11})/;
const SOURCE_BARE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const FILE_ENCODING = 'utf8';
const VIDEO_ID_CAPTURE_GROUP = 1;
const VIDEO_INDEX_OFFSET = 1;
const SHORT_DELAY_MS = 450;
const EXIT_CODE_FAILURE = 1;
const STDOUT_LINE_FEED = '\n';
const FILE_PATH_EXTENSION_SEPARATOR = '.';
const LOG_TRACKS_MESSAGE_SEPARATOR = ', ';
const LOG_TRACKS_NOT_FOUND = 'none';
const LOG_PLAYLIST_NOT_FOUND = 'No playlist videos found for';
const LOG_NO_TRACK = 'No suitable caption track for';
const LOG_EMPTY_OUTPUT = 'No transcript cues found for';
const LOG_INVALID_VIDEO_ID = 'Invalid video id/url:';
const LOG_MISSING_PLAYER_PAYLOAD = 'Could not find ytInitialPlayerResponse for';
const LOG_MISSING_DATA_PAYLOAD = 'Could not find ytInitialData for playlist';
const LOG_PLAYLIST_FETCHED = 'Playlist';
const LOG_PLAYLIST_COUNT_MESSAGE = 'videos extracted from first-page state';
const LOG_VIDEO_PROGRESS = 'processing video';
const LOG_PLAYLIST_VIDEO_SKIPPED = 'Skipping';
const LOG_TRACKS_PREFIX = 'tracks found:';
const LOG_FALLBACK_TRACKS_PREFIX = 'fallback tracks found:';
const LOG_VIDEO_OUTPUT_TEMPLATE = 'Saved subtitles:';
const LOG_AGENT_OUTPUT_TEMPLATE = 'Saved skill from transcript:';
const AGENT_FILE_EXTENSION = 'skill.md';
const LOG_AGENT_EMPTY = 'No transcript text generated for local agent';
const LOG_AGENT_STARTED = 'Running local agent:';
const EMPTY_VALUE = '';
const DEFAULT_AGENT_LANGUAGE = 'unknown';
const videoIdPatterns = {
    fromWatchUrl: SOURCE_WATCH_ID_PATTERN,
    fromShortsUrl: SOURCE_SHORTS_ID_PATTERN,
    byId: SOURCE_BARE_ID_PATTERN,
};
const renderSubtitleFilePath = (outDirectory, videoId, languageTag, fileFormat) => {
    // Join output directory with filename.
    // Compose `videoId.languageTag.format` file name.
    // Return deterministic path for writing.
    return path.join(outDirectory, `${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${fileFormat}`);
};
const renderAgentFilePath = (outDirectory, videoId, languageTag) => {
    // 1) Keep local-agent output in the same folder as transcript outputs.
    // 2) Use deterministic `videoId.languageTag.skill.md` naming.
    return path.join(outDirectory, `${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${AGENT_FILE_EXTENSION}`);
};
const persistCaptions = async (outDirectory, outputFormat, outputContent, videoId, languageTag) => {
    // 1) Ensure output directory exists before write.
    // 2) Persist normalized transcript output with deterministic filename.
    // 3) Return final path for logging/agent metadata.
    await mkdir(outDirectory, { recursive: true });
    const outputFile = renderSubtitleFilePath(outDirectory, videoId, languageTag, outputFormat);
    await writeFile(outputFile, outputContent, FILE_ENCODING);
    return outputFile;
};
const persistAgentOutput = async (outDirectory, videoId, languageTag, agentResponseText) => {
    // 1) Ensure output directory exists before agent write.
    // 2) Persist local-agent output into skill.md artifact.
    // 3) Return final path for one-line logging.
    await mkdir(outDirectory, { recursive: true });
    const outputFile = renderAgentFilePath(outDirectory, videoId, languageTag);
    await writeFile(outputFile, agentResponseText, FILE_ENCODING);
    return outputFile;
};
const resolveVideoId = (sourceUrl) => {
    // 1) Accept plain 11-char IDs.
    // 2) Extract from watch URL and shorts URL.
    // 3) Return null when no known shape exists.
    if (videoIdPatterns.byId.test(sourceUrl)) {
        return sourceUrl;
    }
    const watchMatch = videoIdPatterns.fromWatchUrl.exec(sourceUrl);
    if (watchMatch) {
        return watchMatch[VIDEO_ID_CAPTURE_GROUP];
    }
    const shortsMatch = videoIdPatterns.fromShortsUrl.exec(sourceUrl);
    if (shortsMatch) {
        return shortsMatch[VIDEO_ID_CAPTURE_GROUP];
    }
    return null;
};
const getWatchUrl = (sourceUrl) => {
    // 1) Normalize recognized inputs to watch URL.
    // 2) Keep fallback for unsupported but potentially valid URL shapes.
    const videoId = resolveVideoId(sourceUrl);
    return videoId ? `${WATCH_QUERY_PREFIX}${videoId}` : sourceUrl;
};
const logTrackSummary = (videoId, sourceLabel, tracks) => {
    // 1) Collect language labels from track list.
    // 2) Deduplicate and format for compact one-line log.
    const languageLabels = tracks.map((trackEntry) => trackEntry.languageTag);
    const uniqueLabels = [...new Set(languageLabels)];
    const trackSummary = uniqueLabels.length > 0 ? uniqueLabels.join(LOG_TRACKS_MESSAGE_SEPARATOR) : LOG_TRACKS_NOT_FOUND;
    logInfo(`[${videoId}] ${sourceLabel} ${trackSummary}`);
};
const resolveCaptionTrack = (trackEntries, languageTokens, includeAutoCaptions) => {
    // 1) Share one selector for primary and fallback arrays.
    // 2) Keep behavior centralized and deterministic.
    return chooseTrackFromParsedTracks(trackEntries, languageTokens, includeAutoCaptions);
};
const getCaptionSourceText = async (trackEntry, fileFormat) => {
    // 1) Build final caption download URL for selected format.
    // 2) Return null for empty payload instead of hard-fail.
    const captionRequestUrl = composeCaptionRequestUrl(trackEntry.baseUrl, fileFormat);
    const captionPayload = await fetchTextResource(captionRequestUrl);
    return captionPayload.trim().length > 0 ? captionPayload : null;
};
const buildTranscriptBundleFromVideo = async (sourceUrl, options) => {
    // 1) Resolve video id and player payload.
    // 2) Select preferred caption track; fallback to player API if needed.
    // 3) Download each requested format and return artifacts + plain text seed.
    const videoId = resolveVideoId(sourceUrl);
    if (!videoId) {
        throw new Error(`${LOG_INVALID_VIDEO_ID} ${sourceUrl}`);
    }
    const canonicalWatchUrl = getWatchUrl(sourceUrl);
    const pageHtml = await fetchTextResource(canonicalWatchUrl);
    const playerPayload = extractEmbeddedJson(pageHtml, YOU_TUBE_INITIAL_PLAYER_RESPONSE_MARKER);
    if (!playerPayload) {
        throw new Error(`${LOG_MISSING_PLAYER_PAYLOAD} ${videoId}`);
    }
    const primaryTracks = parseTracksFromPayload(playerPayload);
    logTrackSummary(videoId, LOG_TRACKS_PREFIX, primaryTracks);
    let captionTrack = resolveCaptionTrack(primaryTracks, options.languageTokens, options.includeAutoCaptions);
    if (!captionTrack) {
        const apiTracks = await fetchTracksFromPlayerApi(canonicalWatchUrl, videoId, pageHtml);
        if (!apiTracks.length) {
            throw new Error(`${LOG_NO_TRACK} ${videoId}`);
        }
        logTrackSummary(videoId, LOG_FALLBACK_TRACKS_PREFIX, apiTracks);
        captionTrack = resolveCaptionTrack(apiTracks, options.languageTokens, options.includeAutoCaptions);
        if (!captionTrack) {
            throw new Error(`${LOG_NO_TRACK} ${videoId}`);
        }
    }
    let didFallbackUse = false;
    const loadTracksFromApiOnce = async () => {
        const apiTracks = await fetchTracksFromPlayerApi(canonicalWatchUrl, videoId, pageHtml);
        if (!apiTracks.length) {
            return [];
        }
        didFallbackUse = true;
        logTrackSummary(videoId, LOG_FALLBACK_TRACKS_PREFIX, apiTracks);
        return apiTracks;
    };
    const transcriptArtifacts = [];
    let localAgentText = EMPTY_VALUE;
    for (const subtitleFormat of options.formats) {
        let captionPayload = await getCaptionSourceText(captionTrack, subtitleFormat);
        if (!captionPayload && !didFallbackUse) {
            const apiTracks = await loadTracksFromApiOnce();
            if (!apiTracks.length) {
                throw new Error(`${LOG_NO_TRACK} ${videoId}`);
            }
            const fallbackTrack = resolveCaptionTrack(apiTracks, options.languageTokens, options.includeAutoCaptions);
            if (!fallbackTrack) {
                throw new Error(`${LOG_NO_TRACK} ${videoId}`);
            }
            captionTrack = fallbackTrack;
            captionPayload = await getCaptionSourceText(captionTrack, subtitleFormat);
        }
        if (!captionPayload) {
            throw new Error(`${LOG_EMPTY_OUTPUT} ${videoId}`);
        }
        const subtitleDownload = {
            videoId,
            languageTag: captionTrack.languageTag,
            fileFormat: subtitleFormat,
            fileContent: captionPayload,
        };
        const transformedSubtitle = convertCaptionSourceToOutput(subtitleDownload, options.exportFormat);
        const outputText = transformedSubtitle.outputContent.trim();
        if (!outputText.length) {
            throw new Error(`${LOG_EMPTY_OUTPUT} ${videoId}`);
        }
        if (localAgentText.length === 0) {
            const plainText = convertCaptionSourceToOutput(subtitleDownload, 'txt');
            localAgentText = plainText.outputContent.trim();
        }
        let outputFile = null;
        if (options.writeToStdout) {
            console.log(`${STDOUT_LINE_FEED}--- ${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${captionTrack.languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${transformedSubtitle.outputFormat} ---${STDOUT_LINE_FEED}${outputText}`);
        }
        else {
            outputFile = await persistCaptions(options.outDirectory, transformedSubtitle.outputFormat, outputText, subtitleDownload.videoId, subtitleDownload.languageTag);
            logInfo(`${LOG_VIDEO_OUTPUT_TEMPLATE} ${outputFile}`);
        }
        transcriptArtifacts.push({
            videoId,
            languageTag: subtitleDownload.languageTag,
            sourceFormat: subtitleDownload.fileFormat,
            outputFormat: transformedSubtitle.outputFormat,
            outputText,
            outputPath: outputFile,
        });
    }
    const languageTag = transcriptArtifacts[0]?.languageTag ?? DEFAULT_AGENT_LANGUAGE;
    return {
        videoId,
        languageTag,
        artifacts: transcriptArtifacts,
        localAgentText,
    };
};
const persistAgentResponse = async (options, bundle) => {
    // 1) Run local agent only when explicitly selected.
    // 2) Pass transcript + options system prompt to selected provider.
    // 3) Write result into `.skill.md` output in the same folder as transcripts.
    if (!options.localAgent) {
        return;
    }
    if (bundle.localAgentText.length === 0) {
        throw new Error(`${LOG_AGENT_EMPTY} ${bundle.videoId}`);
    }
    logInfo(`${LOG_AGENT_STARTED} ${options.localAgent} ${bundle.videoId}`);
    const agentOutput = await runLocalAgent({
        localAgent: options.localAgent,
        systemPrompt: options.systemPrompt,
        languageTag: bundle.languageTag,
        transcriptText: bundle.localAgentText,
        videoId: bundle.videoId,
    });
    if (agentOutput.agentResponseText.length === 0) {
        throw new Error(`${LOG_AGENT_EMPTY} ${bundle.videoId}`);
    }
    const skillFile = await persistAgentOutput(options.outDirectory, bundle.videoId, bundle.languageTag, agentOutput.agentResponseText);
    logInfo(`${LOG_AGENT_OUTPUT_TEMPLATE} ${skillFile}`);
};
const getPlaylistVideoCount = async (playlistId) => {
    // 1) Fetch playlist page for discovered list ID.
    // 2) Extract `ytInitialData`.
    // 3) Collect unique video ids recursively.
    const playlistHtml = await fetchTextResource(`${PLAYLIST_PATH_PREFIX}${playlistId}`);
    const playlistState = extractEmbeddedJson(playlistHtml, YOU_TUBE_INITIAL_DATA_MARKER);
    if (!playlistState) {
        throw new Error(`${LOG_MISSING_DATA_PAYLOAD} ${playlistId}`);
    }
    const playlistVideoIds = [];
    collectPlaylistVideoIds(playlistState, playlistVideoIds);
    return playlistVideoIds;
};
const runForPlaylistUrl = async (playlistUrl, options) => {
    // 1) Parse playlist ID from URL and collect ids.
    // 2) Process each video with throttled pacing.
    // 3) If agent is enabled, run it per transcript bundle.
    const listId = getPlaylistIdFromUrl(playlistUrl);
    if (!listId) {
        throw new Error(`Invalid playlist url: ${playlistUrl}`);
    }
    const videoIds = await getPlaylistVideoCount(listId);
    if (!videoIds.length) {
        throw new Error(`${LOG_PLAYLIST_NOT_FOUND} ${listId}`);
    }
    logInfo(`${LOG_PLAYLIST_FETCHED} ${listId}: ${videoIds.length} ${LOG_PLAYLIST_COUNT_MESSAGE}`);
    for (let index = 0; index < videoIds.length; index += 1) {
        const videoId = videoIds[index];
        logInfo(`[#${index + VIDEO_INDEX_OFFSET}/${videoIds.length}] ${LOG_VIDEO_PROGRESS} ${videoId}`);
        try {
            const bundle = await buildTranscriptBundleFromVideo(`${WATCH_QUERY_PREFIX}${videoId}`, options);
            await persistAgentResponse(options, bundle);
        }
        catch (downloadError) {
            logWarn(`${LOG_PLAYLIST_VIDEO_SKIPPED} ${videoId}: ${String(downloadError)}`);
        }
        await new Promise((wakeUp) => setTimeout(wakeUp, SHORT_DELAY_MS));
    }
};
const run = async () => {
    // 1) Parse CLI arguments.
    // 2) Route playlist URLs to playlist workflow.
    // 3) For single video, run direct pipeline.
    const cliValues = await parseCliArguments(process.argv.slice(2));
    const sourceUrl = cliValues.sourceUrl;
    const options = cliValues.options;
    if (isYoutubePlaylistUrl(sourceUrl) && !resolveVideoId(sourceUrl)) {
        await runForPlaylistUrl(sourceUrl, options);
        return;
    }
    const bundle = await buildTranscriptBundleFromVideo(sourceUrl, options);
    await persistAgentResponse(options, bundle);
};
run().catch((err) => {
    logError(String(err instanceof Error ? err.message : err));
    process.exit(EXIT_CODE_FAILURE);
});
