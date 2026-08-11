import { Effect, Schema } from 'effect';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import { fetchPlayerPayloadFromPlayerApi } from './player-api.js';
import { fetchTextResourceOptional } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { logInfo, logWarn } from './log.js';

import { CONSTANTS } from './constants.js';

const {
  BROWSER_USER_AGENT,
  YOUTUBE_ORIGIN_SLASH: DEFAULT_REFERRER_URL,
  YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER,
  EMPTY_VALUE,
} = CONSTANTS.shared;
const {
  LOG_VIDEO_DOWNLOAD_START,
  LOG_VIDEO_DOWNLOAD_DONE,
  LOG_VIDEO_PROGRESS_TEMPLATE,
  LOG_VIDEO_SAVED_TEMPLATE,
  LOG_VIDEO_MUXING,
  LOG_VIDEO_MUX_TEMPLATE,
  LOG_VIDEO_NO_FORMATS,
  LOG_WATCH_HTML_SKIPPED,
} = CONSTANTS.main;
const {
  MIME_AUDIO_PREFIX,
  MIME_MP4_MARK,
  PROGRESS_LOG_STEP_PERCENT,
  FFMPEG_BINARY_NAME,
  FFMPEG_TIMEOUT_MS,
  MEDIA_EXTENSION_MP4,
  MEDIA_EXTENSION_PART_VIDEO,
  MEDIA_EXTENSION_PART_AUDIO,
  RANGE_HEADER_NAME,
  MEDIA_PARALLEL_CHUNKS,
} = CONSTANTS.video;

// One media stream advertised by YouTube streamingData.
export type StreamingFormat = {
  // Format itag when YouTube labels the stream.
  itag: number | null;
  // Direct media URL; null when the stream needs signature deciphering.
  url: string | null;
  // MIME container family (`mp4`, `webm`, `m4a`, …).
  container: string | null;
  // Stream payload: combined audio+video, video-only, or audio-only.
  streamKind: 'video-audio' | 'video' | 'audio';
  // Codecs attribute such as `avc1.640028` when the stream declares it.
  codecs: string | null;
  // Vertical resolution in pixels for video streams.
  height: number | null;
  // Encoding bitrate in bits per second.
  bitrate: number | null;
  // Declared byte length when the server exposes it.
  contentLength: number | null;
};

const EMPTY_STREAM_NODES = [] as const;

const streamingFormatNodeSchema = Schema.Struct({
  // Numeric itag identifier when the stream is labeled.
  itag: Schema.optional(Schema.Number),
  // Direct playable URL; absent for signature-ciphered streams.
  url: Schema.optional(Schema.String),
  // Media MIME descriptor such as `video/mp4; codecs=…`.
  mimeType: Schema.optional(Schema.String),
  // Vertical resolution in pixels for video streams.
  height: Schema.optional(Schema.Number),
  // Encoding bitrate in bits per second.
  bitrate: Schema.optional(Schema.Number),
  // Declared byte length (string from YouTube, number from JSON).
  contentLength: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});

const streamingDataSchema = Schema.Struct({
  // Progressive combined audio+video formats.
  formats: Schema.optionalWith(Schema.Array(streamingFormatNodeSchema), {
    default: () => EMPTY_STREAM_NODES,
  }),
  // Adaptive separate video-only / audio-only streams.
  adaptiveFormats: Schema.optionalWith(Schema.Array(streamingFormatNodeSchema), {
    default: () => EMPTY_STREAM_NODES,
  }),
});

const playerStreamsPayloadSchema = Schema.Struct({
  // Media stream container; absent when the client has no playable set.
  streamingData: Schema.optionalWith(streamingDataSchema, {
    default: () => ({ formats: EMPTY_STREAM_NODES, adaptiveFormats: EMPTY_STREAM_NODES }),
  }),
});

const decodeStreamsPayload = Schema.decodeUnknown(playerStreamsPayloadSchema);

type PlayerStreamsPayload = Schema.Schema.Type<typeof playerStreamsPayloadSchema>;
type StreamingFormatNode = Schema.Schema.Type<typeof streamingFormatNodeSchema>;

const tryDecodeStreamsPayload = (playerPayload: unknown): PlayerStreamsPayload | null => {
  try {
    return Effect.runSync(decodeStreamsPayload(playerPayload));
  } catch {
    return null;
  }
};

const parseContentLength = (contentLengthValue: number | string | undefined): number | null => {
  if (contentLengthValue === undefined) {
    return null;
  }
  const parsedLength = Number(contentLengthValue);
  return Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null;
};

const containerFromMimeType = (mimeType: string | null): string | null => {
  if (!mimeType) {
    return null;
  }
  const containerToken = mimeType.split('/')[1]?.split(';')[0]?.trim();
  return containerToken && containerToken.length > 0 ? containerToken : null;
};

const codecsFromMimeType = (mimeType: string | null): string | null => {
  if (!mimeType) {
    return null;
  }
  const codecsParameter = mimeType
    .split(';')
    .map((parameterToken) => parameterToken.trim())
    .find((parameterToken) => parameterToken.startsWith('codecs='));
  if (!codecsParameter) {
    return null;
  }
  const codecsToken = codecsParameter.slice('codecs='.length).replace(/^"|"$/g, '');
  return codecsToken.length > 0 ? codecsToken : null;
};

const streamKindFromMimeType = (
  mimeType: string | null,
  isProgressive: boolean,
): StreamingFormat['streamKind'] => {
  if (isProgressive) {
    return 'video-audio';
  }
  if (mimeType && mimeType.startsWith(MIME_AUDIO_PREFIX)) {
    return 'audio';
  }
  return 'video';
};

const parseStreamFormatNodes = (
  formatNodes: readonly StreamingFormatNode[],
  isProgressive: boolean,
): StreamingFormat[] => {
  const streamingFormats: StreamingFormat[] = [];
  for (const formatNode of formatNodes) {
    const mimeType = formatNode.mimeType ?? null;
    streamingFormats.push({
      itag: formatNode.itag ?? null,
      url: formatNode.url ?? null,
      container: containerFromMimeType(mimeType),
      streamKind: streamKindFromMimeType(mimeType, isProgressive),
      codecs: codecsFromMimeType(mimeType),
      height: formatNode.height ?? null,
      bitrate: formatNode.bitrate ?? null,
      contentLength: parseContentLength(formatNode.contentLength),
    });
  }
  return streamingFormats;
};

export const parseStreamingFormatsFromPayload = (playerPayload: unknown): StreamingFormat[] => {
  const decodedPayload = tryDecodeStreamsPayload(playerPayload);
  if (!decodedPayload) {
    return [];
  }
  return [
    ...parseStreamFormatNodes(decodedPayload.streamingData.formats, true),
    ...parseStreamFormatNodes(decodedPayload.streamingData.adaptiveFormats, false),
  ];
};

const sortByHeightAndBitrate = (leftFormat: StreamingFormat, rightFormat: StreamingFormat): number => {
  const heightDelta = (rightFormat.height ?? -1) - (leftFormat.height ?? -1);
  if (heightDelta !== 0) {
    return heightDelta;
  }
  return (rightFormat.bitrate ?? 0) - (leftFormat.bitrate ?? 0);
};

const isH264Codec = (codecsValue: string | null): boolean => {
  // H.264 (avc1) is broadly playable in system players; prefer it over AV1/VP9.
  return codecsValue !== null && codecsValue.toLowerCase().startsWith('avc');
};

const sortVideoStreamsForQuality = (
  leftFormat: StreamingFormat,
  rightFormat: StreamingFormat,
): number => {
  // Highest resolution first; H.264 preferred over newer codecs for system-player support.
  const h264Delta = (isH264Codec(rightFormat.codecs) ? 1 : 0) - (isH264Codec(leftFormat.codecs) ? 1 : 0);
  if (h264Delta !== 0) {
    return h264Delta;
  }
  return sortByHeightAndBitrate(leftFormat, rightFormat);
};

const pickBestProgressiveMp4 = (streamingFormats: StreamingFormat[]): StreamingFormat | null => {
  const playableProgressiveMp4 = streamingFormats.filter(
    (streamingFormat) =>
      streamingFormat.url !== null
      && streamingFormat.streamKind === 'video-audio'
      && streamingFormat.container === MIME_MP4_MARK,
  );
  playableProgressiveMp4.sort(sortByHeightAndBitrate);
  return playableProgressiveMp4[0] ?? null;
};

const pickBestAdaptiveMp4Pair = (
  streamingFormats: StreamingFormat[],
): { videoStream: StreamingFormat | null; audioStream: StreamingFormat | null } => {
  const playableMp4VideoStreams = streamingFormats.filter(
    (streamingFormat) =>
      streamingFormat.url !== null
      && streamingFormat.streamKind === 'video'
      && streamingFormat.container === MIME_MP4_MARK,
  );
  const playableMp4AudioStreams = streamingFormats.filter(
    (streamingFormat) =>
      streamingFormat.url !== null
      && streamingFormat.streamKind === 'audio'
      && streamingFormat.container === MIME_MP4_MARK,
  );
  playableMp4VideoStreams.sort(sortVideoStreamsForQuality);
  playableMp4AudioStreams.sort(sortByHeightAndBitrate);
  return {
    videoStream: playableMp4VideoStreams[0] ?? null,
    audioStream: playableMp4AudioStreams[0] ?? null,
  };
};

const formatBytes = (byteCount: number): string => {
  if (byteCount >= 1024 * 1024 * 1024) {
    return `${(byteCount / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (byteCount >= 1024 * 1024) {
    return `${(byteCount / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (byteCount >= 1024) {
    return `${(byteCount / 1024).toFixed(1)} KiB`;
  }
  return `${byteCount} B`;
};

const formatStreamLabel = (streamingFormat: StreamingFormat): string => {
  const containerLabel = streamingFormat.container ?? 'unknown';
  const resolutionLabel = streamingFormat.height !== null ? `${streamingFormat.height}p ` : '';
  const itagLabel = streamingFormat.itag !== null ? `itag ${streamingFormat.itag} ` : '';
  const codecLabel = streamingFormat.codecs !== null ? ` (${streamingFormat.codecs})` : '';
  return `${itagLabel}${resolutionLabel}${containerLabel}${codecLabel}`;
};

const parseContentRangeTotal = (contentRangeHeader: string | null): number | null => {
  if (!contentRangeHeader) {
    return null;
  }
  const totalToken = contentRangeHeader.split('/')[1];
  if (!totalToken) {
    return null;
  }
  const totalBytes = Number(totalToken);
  return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
};

const appendBodyToFile = async (
  mediaStream: import('node:stream/web').ReadableStream,
  writeStream: import('node:stream').Writable,
  onBytes: (chunk: Buffer) => Promise<void> | void,
): Promise<void> => {
  const nodeStream = Readable.fromWeb(mediaStream);
  for await (const mediaChunk of nodeStream) {
    const buffer = Buffer.isBuffer(mediaChunk) ? mediaChunk : Buffer.from(mediaChunk as Uint8Array);
    await onBytes(buffer);
    if (!writeStream.write(buffer)) {
      await new Promise<void>((wakeUp) => writeStream.once('drain', wakeUp));
    }
  }
};

const probeTotalBytes = async (
  downloadUrl: string,
  mediaUserAgent: string,
): Promise<number> => {
  const probeReply = await fetch(downloadUrl, {
    headers: {
      'User-Agent': mediaUserAgent,
      Referer: DEFAULT_REFERRER_URL,
      Accept: '*/*',
      [RANGE_HEADER_NAME]: 'bytes=0-0',
    },
  });
  if (!probeReply.ok) {
    throw new Error(`HTTP ${probeReply.status} while probing stream size`);
  }
  const totalBytes = parseContentRangeTotal(probeReply.headers.get('content-range'));
  await probeReply.body?.cancel().catch(() => undefined);
  if (totalBytes === null) {
    throw new Error(`Stream size not exposed in Content-Range`);
  }
  return totalBytes;
};

const CHUNK_RETRY_ATTEMPTS = 3;

const sleepBriefly = (delayMs: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });

const downloadChunkToFile = async (
  downloadUrl: string,
  mediaUserAgent: string,
  byteRange: string,
  destFile: string,
  progressState: { downloadedBytes: number; totalBytes: number; lastPercent: number },
): Promise<void> => {
  let lastChunkError: unknown = null;
  for (let attempt = 0; attempt < CHUNK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const downloadReply = await fetch(downloadUrl, {
        headers: {
          'User-Agent': mediaUserAgent,
          Referer: DEFAULT_REFERRER_URL,
          Accept: '*/*',
          [RANGE_HEADER_NAME]: byteRange,
        },
      });
      if (!downloadReply.ok) {
        throw new Error(`HTTP ${downloadReply.status} while downloading range ${byteRange}`);
      }
      if (!downloadReply.body) {
        throw new Error(`Empty body while downloading range ${byteRange}`);
      }
      const writeStream = createWriteStream(destFile);
      writeStream.setMaxListeners(0);
      await appendBodyToFile(
        downloadReply.body as import('node:stream/web').ReadableStream,
        writeStream,
        async (mediaChunk: Buffer) => {
          progressState.downloadedBytes += mediaChunk.byteLength;
          const progressPercent = Math.floor(
            (progressState.downloadedBytes / progressState.totalBytes) * 100,
          );
          if (progressPercent >= progressState.lastPercent + PROGRESS_LOG_STEP_PERCENT) {
            progressState.lastPercent = progressPercent;
            logInfo(
              `${LOG_VIDEO_PROGRESS_TEMPLATE}: ${progressPercent}% (${formatBytes(progressState.downloadedBytes)}/${formatBytes(progressState.totalBytes)})`,
            );
          }
        },
      );
      writeStream.end();
      await new Promise<void>((wakeUp, rejectWrite) => {
        writeStream.once('finish', wakeUp);
        writeStream.once('error', rejectWrite);
      });
      return;
    } catch (chunkError) {
      lastChunkError = chunkError;
      await sleepBriefly(1000);
    }
  }
  throw lastChunkError;
};

const downloadStreamToFile = async (
  streamingFormat: StreamingFormat,
  destFile: string,
  mediaUserAgent: string,
): Promise<void> => {
  await mkdir(path.dirname(destFile), { recursive: true });
  const downloadUrl = streamingFormat.url;
  if (!downloadUrl) {
    throw new Error(`No playable url for stream ${formatStreamLabel(streamingFormat)}`);
  }

  // Bounded ranges download full-speed while unbounded (`bytes=0-`) requests are
  // throttled to ~1 Mbps; the cap is per-connection, so split the file into
  // parallel chunks that each get their own connection.
  const totalBytes =
    streamingFormat.contentLength ?? (await probeTotalBytes(downloadUrl, mediaUserAgent));
  const chunkCount = Math.min(MEDIA_PARALLEL_CHUNKS, totalBytes);
  const chunkSize = Math.ceil(totalBytes / chunkCount);
  const partFiles: string[] = [];
  const chunkRanges: string[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const rangeStart = chunkIndex * chunkSize;
    if (rangeStart >= totalBytes) {
      break;
    }
    const rangeEnd = Math.min(rangeStart + chunkSize, totalBytes) - 1;
    partFiles.push(`${destFile}.part${chunkIndex}`);
    chunkRanges.push(`bytes=${rangeStart}-${rangeEnd}`);
  }

  const progressState = {
    downloadedBytes: 0,
    totalBytes,
    lastPercent: 0,
  };
  try {
    await Promise.all(
      chunkRanges.map((byteRange, chunkIndex) =>
        downloadChunkToFile(
          downloadUrl,
          mediaUserAgent,
          byteRange,
          partFiles[chunkIndex],
          progressState,
        ),
      ),
    );

    const writeStream = createWriteStream(destFile);
    writeStream.setMaxListeners(0);
    for (const partFile of partFiles) {
      await pipeline(createReadStream(partFile), writeStream, { end: false });
    }
    writeStream.end();
    await new Promise<void>((wakeUp, rejectWrite) => {
      writeStream.once('finish', wakeUp);
      writeStream.once('error', rejectWrite);
    });
  } finally {
    await Promise.all(partFiles.map((partFile) => rm(partFile, { force: true })));
  }

  logInfo(
    `${LOG_VIDEO_DOWNLOAD_DONE} ${formatBytes(progressState.downloadedBytes)} → ${path.basename(destFile)}`,
  );
};

const muxMp4Parts = (videoPartFile: string, audioPartFile: string, muxedFile: string): boolean => {
  const ffmpegRun = spawnSync(
    FFMPEG_BINARY_NAME,
    ['-y', '-i', videoPartFile, '-i', audioPartFile, '-c', 'copy', muxedFile],
    {
      encoding: 'utf8',
      timeout: FFMPEG_TIMEOUT_MS,
      env: process.env,
    },
  );
  if (ffmpegRun.error) {
    logWarn(`ffmpeg mux: ${ffmpegRun.error.message}`);
    return false;
  }
  if (ffmpegRun.status !== 0) {
    const ffmpegErrorBody = (ffmpegRun.stderr ?? EMPTY_VALUE).trim();
    logWarn(`ffmpeg mux failed: ${ffmpegErrorBody.slice(0, 200)}`);
    return false;
  }
  return true;
};

const tryDownloadAdaptiveMp4 = async (
  videoStream: StreamingFormat,
  audioStream: StreamingFormat,
  videoId: string,
  outDirectory: string,
  mediaUserAgent: string,
): Promise<string | null> => {
  const videoPartFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_PART_VIDEO}`);
  const audioPartFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_PART_AUDIO}`);
  const muxedFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_MP4}`);
  try {
    logInfo(`[${videoId}] ${LOG_VIDEO_DOWNLOAD_START} ${formatStreamLabel(videoStream)}`);
    await downloadStreamToFile(videoStream, videoPartFile, mediaUserAgent);
    logInfo(`[${videoId}] ${LOG_VIDEO_DOWNLOAD_START} ${formatStreamLabel(audioStream)}`);
    await downloadStreamToFile(audioStream, audioPartFile, mediaUserAgent);
    logInfo(`[${videoId}] ${LOG_VIDEO_MUXING}`);
    const muxSucceeded = muxMp4Parts(videoPartFile, audioPartFile, muxedFile);
    if (muxSucceeded) {
      logInfo(`[${videoId}] ${LOG_VIDEO_MUX_TEMPLATE} ${muxedFile}`);
      return muxedFile;
    }
    logWarn(`[${videoId}] ffmpeg mux failed; using combined mp4 instead`);
    return null;
  } catch (adaptiveError) {
    // Adaptive streams refused or throttled; fall back to combined mp4.
    const failureText =
      adaptiveError instanceof Error ? adaptiveError.message : String(adaptiveError);
    logWarn(
      `[${videoId}] adaptive download unavailable (${failureText}); using combined mp4 instead`,
    );
    return null;
  } finally {
    await rm(videoPartFile, { force: true });
    await rm(audioPartFile, { force: true });
  }
};

export const downloadVideoWithPlayerApi = async (
  watchUrl: string,
  videoId: string,
  outDirectory: string,
): Promise<string> => {
  // Fast path: Innertube player payload (no watch HTML) with streaming formats.
  let playerPayloadWithClient = await fetchPlayerPayloadFromPlayerApi(watchUrl, videoId, null);

  // Slow path: watch HTML for ytInitialPlayerResponse when no client returned streams.
  if (!playerPayloadWithClient) {
    logWarn(`[${videoId}] ${LOG_WATCH_HTML_SKIPPED}`);
    const watchPage = await fetchTextResourceOptional(watchUrl);
    const pageHtml = watchPage?.bodyText ?? null;
    if (pageHtml) {
      const embeddedPayload = extractEmbeddedJson(
        pageHtml,
        YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER,
      );
      if (embeddedPayload) {
        playerPayloadWithClient = { playerPayload: embeddedPayload };
      } else {
        playerPayloadWithClient = await fetchPlayerPayloadFromPlayerApi(watchUrl, videoId, pageHtml);
      }
    }
  }
  const playerPayload = playerPayloadWithClient?.playerPayload ?? null;
  if (!playerPayload) {
    throw new Error(`${LOG_VIDEO_NO_FORMATS} ${videoId}`);
  }

  // Media requests must use the User-Agent of the client that minted the stream;
  // a mismatched (browser) UA gets throttled to ~0.1 MiB/s. Payloads lifted from
  // the watch HTML page are web-client minted, so keep the browser UA for them.
  const mediaUserAgent = playerPayloadWithClient?.clientProfile?.userAgent ?? BROWSER_USER_AGENT;

  const streamingFormats = parseStreamingFormatsFromPayload(playerPayload);
  const playableFormats = streamingFormats.filter(
    (streamingFormat) => streamingFormat.url !== null,
  );
  if (playableFormats.length === 0) {
    throw new Error(`${LOG_VIDEO_NO_FORMATS} ${videoId}`);
  }

  // 1) Highest quality: best mp4 video (H.264 preferred) + best mp4 audio, muxed.
  //    Adaptive URLs are servable after the visitor bootstrap; fall back when refused.
  const adaptivePair = pickBestAdaptiveMp4Pair(playableFormats);
  if (adaptivePair.videoStream && adaptivePair.audioStream) {
    const muxedFile = await tryDownloadAdaptiveMp4(
      adaptivePair.videoStream,
      adaptivePair.audioStream,
      videoId,
      outDirectory,
      mediaUserAgent,
    );
    if (muxedFile) {
      return muxedFile;
    }
  }

  // 2) Fallback: combined mp4 (audio+video in one stream) — no mux needed.
  const progressiveMp4 = pickBestProgressiveMp4(playableFormats);
  if (progressiveMp4) {
    logInfo(`${LOG_VIDEO_DOWNLOAD_START} ${formatStreamLabel(progressiveMp4)}`);
    const progressiveFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_MP4}`);
    await downloadStreamToFile(progressiveMp4, progressiveFile, mediaUserAgent);
    logInfo(`${LOG_VIDEO_SAVED_TEMPLATE} ${progressiveFile}`);
    return progressiveFile;
  }

  throw new Error(`${LOG_VIDEO_NO_FORMATS} ${videoId}`);
};
