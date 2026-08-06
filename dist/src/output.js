import { Effect, Schema } from 'effect';
const DEFAULT_SEGMENT_TEXT = '';
const DURATION_PADDING = 3;
const MIN_EVENT_INDEX = 1;
const EMPTY_LINE = '';
const MINUS_PREFIX = '- ';
const JSON_NEWLINE = '\n';
const JSONL_NEWLINE = '\n';
const DOT_REPLACER = ' ';
const RAW_MARKDOWN_HEADER = '# Transcript';
const START_TIME_PREFIX = '[';
const END_TIME_SUFFIX = ']';
const CUE_COUNTER_OFFSET = 1;
const TAG_REMOVAL_PATTERN = /<[^>]+>/g;
const WHITESPACE_NORMALIZER_PATTERN = /\s+/g;
const TIMESTAMP_CAPTURE_PATTERN = /^((?:\d+:)?\d{2}:\d{2}[\.,]\d{3})\s*\-\-\>\s*((?:\d+:)?\d{2}:\d{2}[\.,]\d{3})/;
const CAPTION_TRACK_EVENT_INDEX = 0;
const DEDUPLICATE_KEY_SEPARATOR = '|';
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
const parseIntValue = (textValue) => {
    // 1) Trim input and keep empty text as zero.
    // 2) Parse as integer with radix 10.
    // 3) Return zero when number cannot be parsed to avoid runtime exceptions.
    const trimmedText = textValue.trim();
    if (!trimmedText.length) {
        return 0;
    }
    const parsedNumber = Number.parseInt(trimmedText, 10);
    return Number.isFinite(parsedNumber) ? parsedNumber : 0;
};
const decodeHtmlEntities = (rawLine) => {
    // 1) Replace common HTML entity tokens used by caption feeds.
    // 2) Keep output plain for text and JSON consumers.
    // 3) Run before whitespace normalization and markdown conversion.
    return rawLine
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
};
const normalizeCueText = (rawLine) => {
    // 1) Remove caption markup like <i> or <b>.
    // 2) Replace persistent whitespace with a single space.
    // 3) Keep plain readable text for downstream formats.
    const decodedLine = decodeHtmlEntities(rawLine);
    const taglessText = decodedLine.replace(TAG_REMOVAL_PATTERN, EMPTY_LINE);
    return taglessText.replace(WHITESPACE_NORMALIZER_PATTERN, DOT_REPLACER).trim();
};
const parseTimestampToMilliseconds = (timestamp) => {
    // 1) Split a timecode into time + milliseconds.
    // 2) Support `00:01:02.123` and `00:01:02,123`.
    // 3) Convert into milliseconds to keep timeline ordering deterministic.
    const cleanTime = timestamp.replace(',', '.').trim();
    const parts = cleanTime.split('.');
    const baseParts = parts[CAPTION_TRACK_EVENT_INDEX].split(':');
    const hourIndex = 0;
    const minuteIndex = baseParts.length > 2 ? 1 : 0;
    const secondIndex = baseParts.length > 2 ? 2 : 1;
    const hasHour = baseParts.length > 2;
    const hours = hasHour ? parseIntValue(baseParts[hourIndex]) : 0;
    const minutes = parseIntValue(baseParts[minuteIndex]);
    const seconds = parseIntValue(baseParts[secondIndex]);
    const milliText = parts.length > 1 ? parts[1] : EMPTY_LINE;
    const millisecondsText = (milliText + '000').slice(0, DURATION_PADDING);
    const milliseconds = parseIntValue(millisecondsText);
    const msFromMinutes = (hours * 60 + minutes) * 60 * 1000;
    return msFromMinutes + seconds * 1000 + milliseconds;
};
const parseTimedCaptionLines = (rawSubtitle) => {
    // 1) Normalize line endings and iterate by line.
    // 2) Extract timestamp windows and gather text until blank separator.
    // 3) Return compact cue list with normalized and sanitized text.
    const lines = rawSubtitle.replace(/\r\n/g, '\n').split('\n');
    const cueList = [];
    let cursor = 0;
    let cueIndex = MIN_EVENT_INDEX;
    while (cursor < lines.length) {
        const maybeTimestamp = lines[cursor].trim();
        const matchedTimestamp = maybeTimestamp.match(TIMESTAMP_CAPTURE_PATTERN);
        if (!matchedTimestamp) {
            cursor += CUE_COUNTER_OFFSET;
            continue;
        }
        const startTimestamp = matchedTimestamp[1] === undefined ? EMPTY_LINE : matchedTimestamp[1];
        const endTimestamp = matchedTimestamp[2] === undefined ? EMPTY_LINE : matchedTimestamp[2];
        const startMs = parseTimestampToMilliseconds(startTimestamp);
        const endMs = parseTimestampToMilliseconds(endTimestamp);
        cursor += CUE_COUNTER_OFFSET;
        const textLines = [];
        while (cursor < lines.length) {
            const candidate = lines[cursor].trim();
            if (!candidate) {
                break;
            }
            const cleanedLine = normalizeCueText(candidate);
            if (cleanedLine.length) {
                textLines.push(cleanedLine);
            }
            cursor += CUE_COUNTER_OFFSET;
        }
        if (textLines.length > 0) {
            const lineText = textLines.join(JSON_NEWLINE);
            cueList.push({
                index: cueIndex,
                startMs,
                endMs,
                text: lineText,
            });
            cueIndex += CUE_COUNTER_OFFSET;
        }
        cursor += CUE_COUNTER_OFFSET;
    }
    return cueList;
};
const parseJson3Captions = (rawPayload) => {
    // 1) Parse YouTube JSON3 payload with schema.
    // 2) Rebuild readable text from `tStartMs`, `dDurationMs`, and `segs`.
    // 3) Return empty list on parse failure to keep caller checks explicit.
    try {
        const decodedPayload = Effect.runSync(decodeJson3Payload(JSON.parse(rawPayload)));
        const parsedEvents = [];
        for (let eventCursor = 0; eventCursor < decodedPayload.events.length; eventCursor += CUE_COUNTER_OFFSET) {
            const event = decodedPayload.events[eventCursor];
            const segmentValues = [];
            for (let segmentCursor = 0; segmentCursor < event.segs.length; segmentCursor += CUE_COUNTER_OFFSET) {
                const segmentNode = event.segs[segmentCursor];
                let segmentText = DEFAULT_SEGMENT_TEXT;
                if (segmentNode.utf8 !== undefined) {
                    segmentText = segmentNode.utf8;
                }
                else if (segmentNode.text !== undefined) {
                    segmentText = segmentNode.text;
                }
                if (segmentText.length > 0) {
                    segmentValues.push(normalizeCueText(segmentText));
                }
            }
            if (!segmentValues.length) {
                continue;
            }
            const cueText = segmentValues.join(JSON_NEWLINE);
            const startMs = event.tStartMs;
            const lengthMs = event.dDurationMs === undefined ? 0 : event.dDurationMs;
            const endMs = startMs + lengthMs;
            parsedEvents.push({
                index: eventCursor + CUE_COUNTER_OFFSET,
                startMs,
                endMs,
                text: cueText,
            });
        }
        return parsedEvents;
    }
    catch {
        return [];
    }
};
const parseCaptionSourceToCueList = (captionSource, captionFormat) => {
    // 1) Prefer native parser for JSON3 data.
    // 2) Fall back to timed-text parser for VTT/SRT-like formats.
    // 3) Return empty list for unsupported formats so callers can surface explicit errors.
    if (captionFormat === 'json3') {
        return parseJson3Captions(captionSource);
    }
    return parseTimedCaptionLines(captionSource);
};
const deduplicateCaptionCues = (captionCues) => {
    // 1) Build a deterministic key from start/end/text.
    // 2) Keep first cue for each unique key.
    // 3) Return cues in original order with repeats removed.
    const cueKeySet = new Set();
    const uniqueCaptionCues = [];
    for (const captionCue of captionCues) {
        const cueIdentity = `${captionCue.startMs}${DEDUPLICATE_KEY_SEPARATOR}${captionCue.endMs}${DEDUPLICATE_KEY_SEPARATOR}${captionCue.text}`;
        if (cueKeySet.has(cueIdentity)) {
            continue;
        }
        cueKeySet.add(cueIdentity);
        uniqueCaptionCues.push(captionCue);
    }
    return uniqueCaptionCues;
};
const formatMilliseconds = (durationMs) => {
    // 1) Convert milliseconds to total seconds.
    // 2) Render `hh:mm:ss.mmm` fixed-width for deterministic transcript logs.
    // 3) Keep values rounded down for display readability.
    const safeMilliseconds = Math.max(0, Math.floor(durationMs));
    const totalSeconds = Math.floor(safeMilliseconds / 1000);
    const milliseconds = safeMilliseconds % 1000;
    const hourValue = Math.floor(totalSeconds / 3600);
    const secondValue = totalSeconds % 60;
    const minuteValue = Math.floor(totalSeconds / 60) % 60;
    const msValue = milliseconds.toString().padStart(DURATION_PADDING, '0');
    const hourText = hourValue.toString().padStart(2, '0');
    const minuteText = minuteValue.toString().padStart(2, '0');
    const secondText = secondValue.toString().padStart(2, '0');
    return `${hourText}:${minuteText}:${secondText}.${msValue}`;
};
const buildMarkdownLines = (videoId, languageTag, captionCues) => {
    // 1) Add a markdown heading with video metadata.
    // 2) Add one bullet per cue for quick review in editors.
    // 3) Use compact timestamp formatting for easy scanning.
    const heading = `${RAW_MARKDOWN_HEADER}${JSON_NEWLINE}${JSON_NEWLINE}- video: ${videoId}${JSON_NEWLINE}- language: ${languageTag}${JSON_NEWLINE}`;
    const lines = captionCues.map((captionCue) => {
        const cueTime = formatMilliseconds(captionCue.startMs);
        return `${MINUS_PREFIX}${START_TIME_PREFIX}${cueTime}${END_TIME_SUFFIX} ${captionCue.text}`;
    });
    return [heading, ...lines].join(JSON_NEWLINE);
};
const buildJsonPayload = (videoId, languageTag, captionFormat, captionCues) => {
    // 1) Keep deterministic object shape for consumers.
    // 2) Include source format so downstream tools can reparse if needed.
    // 3) Preserve index+start/end times and text in each cue.
    return {
        videoId,
        languageTag,
        sourceFormat: captionFormat,
        cues: captionCues,
    };
};
const buildJsonLines = (captionCues) => {
    // 1) Serialize each cue as a one-line JSON object.
    // 2) Keep newline separation to support easy streaming import.
    // 3) Return empty string when no cues exist.
    return captionCues
        .map((captionCue) => JSON.stringify(captionCue))
        .join(JSONL_NEWLINE);
};
const buildRawTextOutput = (captionCues) => {
    // 1) Return cue text only, one line per cue.
    // 2) Preserve reading order.
    // 3) Keep spacing normalized and deterministic.
    return captionCues.map((captionCue) => captionCue.text).join(JSON_NEWLINE);
};
export const convertCaptionSourceToOutput = (downloadBundle, outputFormat) => {
    // 1) Use requested export format when provided.
    // 2) For `txt`, `md`, `json`, `jsonl` derive cue list from the subtitle source.
    // 3) Default to original subtitle format when no conversion is requested.
    const parsedCaptionCues = deduplicateCaptionCues(parseCaptionSourceToCueList(downloadBundle.fileContent, downloadBundle.fileFormat));
    const targetFormat = outputFormat ? outputFormat : downloadBundle.fileFormat;
    if (targetFormat === 'txt') {
        return {
            outputFormat: targetFormat,
            outputContent: buildRawTextOutput(parsedCaptionCues),
        };
    }
    if (targetFormat === 'md') {
        return {
            outputFormat: targetFormat,
            outputContent: buildMarkdownLines(downloadBundle.videoId, downloadBundle.languageTag, parsedCaptionCues),
        };
    }
    if (targetFormat === 'json') {
        return {
            outputFormat: targetFormat,
            outputContent: JSON.stringify(buildJsonPayload(downloadBundle.videoId, downloadBundle.languageTag, downloadBundle.fileFormat, parsedCaptionCues), null, 2),
        };
    }
    if (targetFormat === 'jsonl') {
        return {
            outputFormat: targetFormat,
            outputContent: buildJsonLines(parsedCaptionCues),
        };
    }
    return {
        outputFormat: downloadBundle.fileFormat,
        outputContent: downloadBundle.fileContent,
    };
};
