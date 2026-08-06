import { Effect, Schema } from 'effect';
import { SubtitleFormat, OutputFormat, CaptionDownload } from './types.js';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  NEWLINE,
  SINGLE_SPACE,
  JSON_INDENT: JSON_INDENT_SPACES,
} = CONSTANTS.shared;
const EMPTY_SEGMENT_TEXT = EMPTY_VALUE;
const EMPTY_STRING = EMPTY_VALUE;
const {
  MILLISECOND_PAD_WIDTH,
  FIRST_CUE_INDEX,
  MARKDOWN_BULLET_PREFIX,
  MARKDOWN_HEADER,
  START_TIME_PREFIX,
  END_TIME_SUFFIX,
  CUE_STEP,
  TAG_REMOVAL_PATTERN,
  WHITESPACE_NORMALIZER_PATTERN,
  TIMESTAMP_CAPTURE_PATTERN,
  TIMESTAMP_BASE_PART_INDEX,
  DEDUPLICATE_KEY_SEPARATOR,
  JSON3_PARSE_ERROR_PREFIX,
} = CONSTANTS.output;

// A timed cue normalized for text extraction and output serialization.
type CaptionCue = {
  // Sequence index in the subtitle timeline.
  index: number;
  // Cue start in milliseconds.
  startMs: number;
  // Cue end in milliseconds.
  endMs: number;
  // Cue readable caption line without HTML formatting.
  cueText: string;
};

// YouTube JSON3 event segment shape extracted from transcript API responses.
const json3SegmentSchema = Schema.Struct({
  // Visible text segment value.
  utf8: Schema.optional(Schema.String),
  // Optional fallback text when `utf8` key is unavailable.
  text: Schema.optional(Schema.String),
});

// One JSON3 transcript event with timing in milliseconds.
const json3EventSchema = Schema.Struct({
  // Event start in milliseconds.
  tStartMs: Schema.Number,
  // Optional event duration in milliseconds.
  dDurationMs: Schema.optional(Schema.Number),
  // Text segments for the event.
  segs: Schema.Array(json3SegmentSchema),
});

// Top-level YouTube JSON3 payload used for transcript reconstruction.
const json3PayloadSchema = Schema.Struct({
  // Ordered caption events.
  events: Schema.Array(json3EventSchema),
});

const decodeJson3Payload = Schema.decodeUnknown(json3PayloadSchema);

const parseIntegerOrZero = (numericText: string): number => {
  const trimmedText = numericText.trim();
  if (!trimmedText.length) {
    return 0;
  }
  const parsedNumber = Number.parseInt(trimmedText, 10);
  return Number.isFinite(parsedNumber) ? parsedNumber : 0;
};

const decodeHtmlEntities = (captionLine: string): string =>
  captionLine
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

const sanitizeCaptionLine = (captionLine: string): string => {
  const decodedLine = decodeHtmlEntities(captionLine);
  const taglessLine = decodedLine.replace(TAG_REMOVAL_PATTERN, EMPTY_STRING);
  return taglessLine.replace(WHITESPACE_NORMALIZER_PATTERN, SINGLE_SPACE).trim();
};

const parseTimestampToMilliseconds = (timestamp: string): number => {
  const cleanTime = timestamp.replace(',', '.').trim();
  const timeAndMillis = cleanTime.split('.');
  const baseParts = timeAndMillis[TIMESTAMP_BASE_PART_INDEX].split(':');

  const hasHour = baseParts.length > 2;
  const hours = hasHour ? parseIntegerOrZero(baseParts[0]) : 0;
  const minutes = parseIntegerOrZero(baseParts[hasHour ? 1 : 0]);
  const seconds = parseIntegerOrZero(baseParts[hasHour ? 2 : 1]);
  const milliText = timeAndMillis.length > 1 ? timeAndMillis[1] : EMPTY_STRING;
  const millisecondsText = (milliText + '000').slice(0, MILLISECOND_PAD_WIDTH);
  const milliseconds = parseIntegerOrZero(millisecondsText);

  const msFromMinutes = (hours * 60 + minutes) * 60 * 1000;
  return msFromMinutes + seconds * 1000 + milliseconds;
};

const parseTimedCaptionLines = (subtitleSource: string): CaptionCue[] => {
  const lines = subtitleSource.replace(/\r\n/g, '\n').split('\n');
  const captionCues: CaptionCue[] = [];
  let cursor = 0;
  let cueIndex = FIRST_CUE_INDEX;

  while (cursor < lines.length) {
    const maybeTimestamp = lines[cursor].trim();
    const matchedTimestamp = maybeTimestamp.match(TIMESTAMP_CAPTURE_PATTERN);
    if (!matchedTimestamp) {
      cursor += CUE_STEP;
      continue;
    }

    const startTimestamp = matchedTimestamp[1] ?? EMPTY_STRING;
    const endTimestamp = matchedTimestamp[2] ?? EMPTY_STRING;
    const startMs = parseTimestampToMilliseconds(startTimestamp);
    const endMs = parseTimestampToMilliseconds(endTimestamp);

    cursor += CUE_STEP;
    const cueTextLines: string[] = [];
    while (cursor < lines.length) {
      const candidateLine = lines[cursor].trim();
      if (!candidateLine) {
        break;
      }
      const cleanedLine = sanitizeCaptionLine(candidateLine);
      if (cleanedLine.length) {
        cueTextLines.push(cleanedLine);
      }
      cursor += CUE_STEP;
    }

    if (cueTextLines.length > 0) {
      captionCues.push({
        index: cueIndex,
        startMs,
        endMs,
        cueText: cueTextLines.join(NEWLINE),
      });
      cueIndex += CUE_STEP;
    }

    cursor += CUE_STEP;
  }

  return captionCues;
};

const segmentTextFromNode = (segmentNode: {
  utf8?: string;
  text?: string;
}): string => {
  if (segmentNode.utf8 !== undefined) {
    return segmentNode.utf8;
  }
  if (segmentNode.text !== undefined) {
    return segmentNode.text;
  }
  return EMPTY_SEGMENT_TEXT;
};

const parseJson3Captions = (json3Source: string): CaptionCue[] => {
  let decodedJson3: Schema.Schema.Type<typeof json3PayloadSchema>;
  try {
    decodedJson3 = Effect.runSync(decodeJson3Payload(JSON.parse(json3Source)));
  } catch (parseError) {
    throw new Error(`${JSON3_PARSE_ERROR_PREFIX}: ${String(parseError)}`);
  }

  const captionCues: CaptionCue[] = [];
  for (let eventIndex = 0; eventIndex < decodedJson3.events.length; eventIndex += CUE_STEP) {
    const captionEvent = decodedJson3.events[eventIndex];
    const segmentValues: string[] = [];

    for (const segmentNode of captionEvent.segs) {
      const segmentText = segmentTextFromNode(segmentNode);
      if (segmentText.length > 0) {
        segmentValues.push(sanitizeCaptionLine(segmentText));
      }
    }

    if (!segmentValues.length) {
      continue;
    }

    const startMs = captionEvent.tStartMs;
    const durationMs = captionEvent.dDurationMs ?? 0;
    captionCues.push({
      index: eventIndex + CUE_STEP,
      startMs,
      endMs: startMs + durationMs,
      cueText: segmentValues.join(NEWLINE),
    });
  }

  return captionCues;
};

const parseCaptionSourceToCueList = (
  captionSource: string,
  captionFormat: SubtitleFormat,
): CaptionCue[] => {
  if (captionFormat === 'json3') {
    return parseJson3Captions(captionSource);
  }
  return parseTimedCaptionLines(captionSource);
};

const deduplicateCaptionCues = (captionCues: CaptionCue[]): CaptionCue[] => {
  const cueKeySet = new Set<string>();
  const uniqueCaptionCues: CaptionCue[] = [];
  for (const captionCue of captionCues) {
    const cueIdentity = `${captionCue.startMs}${DEDUPLICATE_KEY_SEPARATOR}${captionCue.endMs}${DEDUPLICATE_KEY_SEPARATOR}${captionCue.cueText}`;
    if (cueKeySet.has(cueIdentity)) {
      continue;
    }
    cueKeySet.add(cueIdentity);
    uniqueCaptionCues.push(captionCue);
  }
  return uniqueCaptionCues;
};

const deduplicateConsecutiveTextLines = (captionLines: string[]): string[] => {
  const uniqueLines: string[] = [];
  for (const currentLine of captionLines) {
    const previousLine = uniqueLines[uniqueLines.length - 1];
    if (previousLine !== currentLine) {
      uniqueLines.push(currentLine);
    }
  }
  return uniqueLines;
};

const splitCaptionTextIntoLines = (captionCues: CaptionCue[]): string[] => {
  const captionLines: string[] = [];
  for (const captionCue of captionCues) {
    for (const cueLine of captionCue.cueText.split(NEWLINE)) {
      const trimmedLine = cueLine.trim();
      if (trimmedLine) {
        captionLines.push(trimmedLine);
      }
    }
  }
  return captionLines;
};

const formatMilliseconds = (durationMs: number): string => {
  const safeMilliseconds = Math.max(0, Math.floor(durationMs));
  const elapsedSeconds = Math.floor(safeMilliseconds / 1000);
  const milliseconds = safeMilliseconds % 1000;
  const hourValue = Math.floor(elapsedSeconds / 3600);
  const secondValue = elapsedSeconds % 60;
  const minuteValue = Math.floor(elapsedSeconds / 60) % 60;
  const msValue = milliseconds.toString().padStart(MILLISECOND_PAD_WIDTH, '0');

  const hourText = hourValue.toString().padStart(2, '0');
  const minuteText = minuteValue.toString().padStart(2, '0');
  const secondText = secondValue.toString().padStart(2, '0');

  return `${hourText}:${minuteText}:${secondText}.${msValue}`;
};

const formatMarkdownTranscript = (
  videoId: string,
  languageTag: string,
  captionCues: CaptionCue[],
): string => {
  const heading = `${MARKDOWN_HEADER}${NEWLINE}${NEWLINE}- video: ${videoId}${NEWLINE}- language: ${languageTag}${NEWLINE}`;
  const lines = captionCues.map((captionCue) => {
    const cueTime = formatMilliseconds(captionCue.startMs);
    return `${MARKDOWN_BULLET_PREFIX}${START_TIME_PREFIX}${cueTime}${END_TIME_SUFFIX} ${captionCue.cueText}`;
  });
  return [heading, ...lines].join(NEWLINE);
};

const composeJsonEnvelope = (
  videoId: string,
  languageTag: string,
  captionFormat: SubtitleFormat,
  captionCues: CaptionCue[],
) => ({
  videoId,
  languageTag,
  sourceFormat: captionFormat,
  cues: captionCues,
});

const formatJsonlLines = (captionCues: CaptionCue[]): string =>
  captionCues.map((captionCue) => JSON.stringify(captionCue)).join(NEWLINE);

const formatPlainTextTranscript = (captionCues: CaptionCue[]): string => {
  const captionLines = splitCaptionTextIntoLines(captionCues);
  const dedupedCaptionLines = deduplicateConsecutiveTextLines(captionLines);
  return dedupedCaptionLines.join(NEWLINE);
};

export const convertCaptionSourceToOutput = (
  downloadBundle: CaptionDownload,
  outputFormat: OutputFormat | null,
): { outputFormat: SubtitleFormat | OutputFormat; outputContent: string } => {
  const parsedCaptionCues = deduplicateCaptionCues(
    parseCaptionSourceToCueList(downloadBundle.fileContent, downloadBundle.fileFormat),
  );
  const targetFormat = outputFormat ?? downloadBundle.fileFormat;

  if (targetFormat === 'txt') {
    return {
      outputFormat: targetFormat,
      outputContent: formatPlainTextTranscript(parsedCaptionCues),
    };
  }

  if (targetFormat === 'md') {
    return {
      outputFormat: targetFormat,
      outputContent: formatMarkdownTranscript(
        downloadBundle.videoId,
        downloadBundle.languageTag,
        parsedCaptionCues,
      ),
    };
  }

  if (targetFormat === 'json') {
    return {
      outputFormat: targetFormat,
      outputContent: JSON.stringify(
        composeJsonEnvelope(
          downloadBundle.videoId,
          downloadBundle.languageTag,
          downloadBundle.fileFormat,
          parsedCaptionCues,
        ),
        null,
        JSON_INDENT_SPACES,
      ),
    };
  }

  if (targetFormat === 'jsonl') {
    return {
      outputFormat: targetFormat,
      outputContent: formatJsonlLines(parsedCaptionCues),
    };
  }

  return {
    outputFormat: downloadBundle.fileFormat,
    outputContent: downloadBundle.fileContent,
  };
};
