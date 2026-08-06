import { outputFormatValues, subtitleFormatValues } from './types.js';
const DEFAULT_FORMAT_CSV = 'vtt';
const DEFAULT_LANGUAGE_TOKENS = 'en';
const DEFAULT_OUTPUT_DIRECTORY = './scraped-yt';
const FORMAT_OPTION_NAME = '--format';
const LANGUAGE_OPTION_NAME = '--lang';
const AUTO_OPTION_NAME = '--auto';
const STDOUT_OPTION_NAME = '--stdout';
const OUTPUT_DIR_OPTION_NAME = '--out-dir';
const OUTPUT_FORMAT_OPTION_NAME = '--output-format';
const OPTION_SEPARATOR = ',';
const FORMATS_USAGE = 'Usage: node src/main.ts <youtube-url> [--format vtt] [--lang en] [--auto] [--stdout] [--out-dir ./scraped-yt] [--output-format txt|md|json|jsonl]';
const EMPTY_OPTION_VALUE = '';
const defaultOptions = {
    formats: [DEFAULT_FORMAT_CSV],
    languageTokens: [DEFAULT_LANGUAGE_TOKENS],
    includeAutoCaptions: false,
    exportFormat: null,
    outDirectory: DEFAULT_OUTPUT_DIRECTORY,
    writeToStdout: false,
};
const parseSubtitleFormats = (rawValue) => {
    // 1) Split raw input by comma and normalize to lowercase.
    // 2) Filter only supported subtitle formats via schema union.
    // 3) Throw if no valid formats remain.
    const sanitized = rawValue.split(OPTION_SEPARATOR).map((entry) => entry.trim().toLowerCase());
    const isAllowed = (value) => subtitleFormatValues.includes(value);
    const validFormats = sanitized.filter((entry) => isAllowed(entry));
    if (!validFormats.length) {
        throw new Error(`Invalid subtitle formats: ${rawValue}`);
    }
    return validFormats;
};
const isOutputFormat = (value) => {
    // 1) Validate against known output formats.
    // 2) Use union guard for safe type narrowing.
    // 3) Avoid custom format coercion and keep behavior explicit.
    return outputFormatValues.includes(value);
};
const parseExportFormat = (rawValue) => {
    // 1) Normalize user input and trim spaces.
    // 2) Throw if unsupported output format is requested.
    // 3) Return narrowed output format for strict downstream logic.
    const normalizedValue = rawValue.trim().toLowerCase();
    if (!isOutputFormat(normalizedValue)) {
        throw new Error(`Invalid output format: ${rawValue}`);
    }
    return normalizedValue;
};
export const parseCliArguments = (argumentList) => {
    // 1) Start with defaults, then iterate positional/flag tokens.
    // 2) Parse and normalize each known option and payload token.
    // 3) The first positional token is the source URL; throw on missing source.
    const options = { ...defaultOptions };
    const positional = [];
    for (let cursor = 0; cursor < argumentList.length; cursor += 1) {
        const token = argumentList[cursor];
        if (token === FORMAT_OPTION_NAME) {
            const nextValue = argumentList[cursor + 1];
            const rawValue = nextValue === undefined ? EMPTY_OPTION_VALUE : nextValue;
            cursor += 1;
            options.formats = parseSubtitleFormats(rawValue);
            continue;
        }
        if (token === LANGUAGE_OPTION_NAME) {
            const nextValue = argumentList[cursor + 1];
            const rawValue = nextValue === undefined ? EMPTY_OPTION_VALUE : nextValue;
            cursor += 1;
            options.languageTokens = rawValue
                .split(OPTION_SEPARATOR)
                .map((entry) => entry.trim())
                .filter(Boolean);
            continue;
        }
        if (token === AUTO_OPTION_NAME) {
            options.includeAutoCaptions = true;
            continue;
        }
        if (token === STDOUT_OPTION_NAME) {
            options.writeToStdout = true;
            continue;
        }
        if (token === OUTPUT_FORMAT_OPTION_NAME) {
            const nextValue = argumentList[cursor + 1];
            const rawValue = nextValue === undefined ? EMPTY_OPTION_VALUE : nextValue;
            cursor += 1;
            options.exportFormat = parseExportFormat(rawValue);
            continue;
        }
        if (token === OUTPUT_DIR_OPTION_NAME) {
            const nextValue = argumentList[cursor + 1];
            if (nextValue !== undefined) {
                options.outDirectory = nextValue;
            }
            cursor += 1;
            continue;
        }
        positional.push(token);
    }
    const sourceUrl = positional[0];
    if (!sourceUrl) {
        throw new Error(FORMATS_USAGE);
    }
    return { sourceUrl, options };
};
