import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fetchTextResource } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { chooseTrackFromParsedTracks, buildCaptionRequestUrl, parseTracksFromPayload } from './captions.js';
import { getPlaylistIdFromUrl, isYoutubePlaylistUrl, collectPlaylistVideoIds } from './playlist.js';
import { parseCliArguments } from './cli.js';
import { logInfo, logWarn, logError } from './log.js';
import { convertCaptionSourceToOutput } from './output.js';
import { fetchTracksFromPlayerApi } from './player-api.js';
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
const videoIdPatterns = {
    fromWatchUrl: SOURCE_WATCH_ID_PATTERN,
    fromShortsUrl: SOURCE_SHORTS_ID_PATTERN,
    byId: SOURCE_BARE_ID_PATTERN,
};
const renderSubtitleFilePath = (outDirectory, videoId, languageTag, fileFormat) => {
    // 1) Join output directory with filename.
    // 2) Compose filename with video, language, and format segments.
    // 3) Return a concrete filesystem path.
    return path.join(outDirectory, `${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${fileFormat}`);
};
const persistCaptions = async (outDirectory, outputFormat, outputContent, videoId, languageTag) => {
    // 1) Ensure destination directory exists.
    // 2) Build deterministic output path from `videoId/lang/format` tuple.
    // 3) Write subtitle content to disk and return the final path.
    await mkdir(outDirectory, { recursive: true });
    const outputFile = renderSubtitleFilePath(outDirectory, videoId, languageTag, outputFormat);
    await writeFile(outputFile, outputContent, FILE_ENCODING);
    return outputFile;
};
const resolveVideoId = (sourceUrl) => {
    // 1) Treat 11-char bare IDs as already canonical.
    // 2) Else extract ID from `watch?v=`.
    // 3) Else extract ID from `/shorts/`.
    // 4) Return null if no known pattern matches.
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
    // 1) Resolve an ID from the input URL/string.
    // 2) If resolvable, normalize to watch URL.
    // 3) Otherwise keep original string untouched.
    const videoId = resolveVideoId(sourceUrl);
    return videoId ? `${WATCH_QUERY_PREFIX}${videoId}` : sourceUrl;
};
const logTrackSummary = (videoId, sourceLabel, tracks) => {
    // 1) Group distinct track languages.
    // 2) Keep one-line log output consistent with default mode.
    // 3) Show `none` when no tracks are available.
    const languageLabels = tracks.map((trackEntry) => trackEntry.languageTag);
    const uniqueLabels = [...new Set(languageLabels)];
    const trackSummary = uniqueLabels.length > 0 ? uniqueLabels.join(LOG_TRACKS_MESSAGE_SEPARATOR) : LOG_TRACKS_NOT_FOUND;
    logInfo(`[${videoId}] ${sourceLabel} ${trackSummary}`);
};
const resolveCaptionTrack = (trackEntries, languageTokens, includeAutoCaptions) => {
    // 1) Share a single selector for primary and fallback track sets.
    // 2) Keep call sites compact and testable.
    // 3) Return null when no requested language exists.
    return chooseTrackFromParsedTracks(trackEntries, languageTokens, includeAutoCaptions);
};
const getCaptionSourceText = async (trackEntry, fileFormat) => {
    // 1) Build format-specific caption URL.
    // 2) Return null for empty payloads instead of hard-failing upstream.
    // 3) Surface network/parsing failures to fallback logic.
    const captionRequestUrl = buildCaptionRequestUrl(trackEntry.baseUrl, fileFormat);
    const captionPayload = await fetchTextResource(captionRequestUrl);
    return captionPayload.trim().length > 0 ? captionPayload : null;
};
const downloadSubtitleForVideo = async (sourceUrl, options) => {
    // 1) Resolve and validate the video id.
    // 2) Build track list from page payload, with player API fallback on empty responses.
    // 3) Download requested formats and write or print transformed output.
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
        if (options.writeToStdout) {
            console.log(`${STDOUT_LINE_FEED}--- ${videoId}${FILE_PATH_EXTENSION_SEPARATOR}${captionTrack.languageTag}${FILE_PATH_EXTENSION_SEPARATOR}${transformedSubtitle.outputFormat} ---${STDOUT_LINE_FEED}${outputText}`);
            continue;
        }
        const outputFile = await persistCaptions(options.outDirectory, transformedSubtitle.outputFormat, outputText, subtitleDownload.videoId, subtitleDownload.languageTag);
        logInfo(`${LOG_VIDEO_OUTPUT_TEMPLATE} ${outputFile}`);
    }
};
const getPlaylistVideoCount = async (playlistId) => {
    // 1) Fetch playlist HTML page by list ID.
    // 2) Extract `ytInitialData` JSON from page source.
    // 3) Collect and return all discovered video IDs.
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
    // 1) Validate playlist ID from URL.
    // 2) Pull all video IDs from playlist page payload.
    // 3) Download subtitles for each video with short inter-item delay and warning-only failures.
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
            await downloadSubtitleForVideo(`${WATCH_QUERY_PREFIX}${videoId}`, options);
        }
        catch (downloadError) {
            logWarn(`${LOG_PLAYLIST_VIDEO_SKIPPED} ${videoId}: ${String(downloadError)}`);
        }
        await new Promise((wakeUp) => setTimeout(wakeUp, SHORT_DELAY_MS));
    }
};
const run = async () => {
    // 1) Parse CLI options and source URL.
    // 2) Route playlist URLs through playlist flow.
    // 3) Otherwise treat input as single video and run direct download.
    const { sourceUrl, options } = parseCliArguments(process.argv.slice(2));
    if (isYoutubePlaylistUrl(sourceUrl) && !resolveVideoId(sourceUrl)) {
        await runForPlaylistUrl(sourceUrl, options);
        return;
    }
    await downloadSubtitleForVideo(sourceUrl, options);
};
run().catch((err) => {
    logError(String(err instanceof Error ? err.message : err));
    process.exit(EXIT_CODE_FAILURE);
});
