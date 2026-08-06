import { cancel, intro, isCancel, multiselect, outro, select, text, confirm, } from '@clack/prompts';
import { outputFormatValues, subtitleFormatValues, localAgentKeys, defaultSystemPrompt, } from './types.js';
const DEFAULT_FORMAT_TOKEN = 'vtt';
const DEFAULT_FORMAT_LIST = [DEFAULT_FORMAT_TOKEN];
const DEFAULT_LANGUAGE_TOKEN = 'en';
const DEFAULT_LANGUAGE_LIST = [DEFAULT_LANGUAGE_TOKEN];
const DEFAULT_OUTPUT_FOLDER = './scraped-yt';
const DEFAULT_INTERACTIVE_OUTPUT = 'default';
const DEFAULT_PROMPT_CHOICE = 'default';
const OPTION_TOKEN_PREFIX = '--';
const OPTION_WITH_VALUE_FORMAT = 'format';
const OPTION_WITH_VALUE_LANG = 'lang';
const OPTION_WITH_VALUE_OUT_DIR = 'out-dir';
const OPTION_WITH_VALUE_OUTPUT_FORMAT = 'output-format';
const OPTION_WITH_VALUE_AGENT = 'agent';
const OPTION_WITH_VALUE_SYSTEM_PROMPT = 'system-prompt';
const OPTION_WITH_VALUE_URL = 'url';
const OPTION_BOOLEAN_AUTO = 'auto';
const OPTION_BOOLEAN_STDOUT = 'stdout';
const OPTION_BOOLEAN_HELP = 'help';
const NONE_AGENT_VALUE = 'none';
const EMPTY_VALUE = '';
const CLI_OPTION_SEPARATOR = ',';
const USAGE_TEXT = 'Usage: npm start url=<youtube-url-or-id> [format=vtt,srt] [lang=en] [auto] [stdout] [out-dir=./scraped-yt] [output-format=txt|md|json|jsonl] [agent=codex|grok|devin|claude|gemini|kiro|kimi|agent|cursor] [system-prompt="..."]';
const HTTP_SCHEME_PREFIX = 'http://';
const HTTPS_SCHEME_PREFIX = 'https://';
const YOUTUBE_HOST_MARK = 'youtube.com';
const SHORTS_HOST_MARK = 'youtu.be';
const defaultOptions = {
    formats: DEFAULT_FORMAT_LIST,
    languageTokens: DEFAULT_LANGUAGE_LIST,
    includeAutoCaptions: false,
    exportFormat: null,
    outDirectory: DEFAULT_OUTPUT_FOLDER,
    writeToStdout: false,
    localAgent: null,
    systemPrompt: defaultSystemPrompt,
};
const isSubtitleFormat = (value) => {
    // 1) Keep format validation centralized.
    // 2) Keep parser type-safe for downstream track selection.
    return subtitleFormatValues.includes(value);
};
const isOutputFormat = (value) => {
    // 1) Keep final output format in the explicit export union.
    // 2) Reject unknown user values early.
    return outputFormatValues.includes(value);
};
const isSupportedAgent = (value) => {
    // 1) Keep local agent input in the known command map.
    // 2) Fail fast when user requests an unsupported option.
    return localAgentKeys.includes(value);
};
const parseBoolean = (textValue) => {
    // 1) Support explicit boolean shorthands used by this CLI.
    // 2) Reject unknown values to prevent silent coercion.
    const loweredValue = textValue.toLowerCase();
    if (loweredValue === 'true') {
        return true;
    }
    if (loweredValue === '1') {
        return true;
    }
    if (loweredValue === 'yes') {
        return true;
    }
    if (loweredValue === 'false') {
        return false;
    }
    if (loweredValue === '0') {
        return false;
    }
    if (loweredValue === 'no') {
        return false;
    }
    throw new Error(`Invalid boolean value: ${textValue}`);
};
const splitList = (textValue) => {
    // 1) Split a compact comma list.
    // 2) Trim each token.
    // 3) Remove empty values.
    const parts = [];
    const splitValues = textValue.split(CLI_OPTION_SEPARATOR);
    for (const splitValue of splitValues) {
        const trimmedValue = splitValue.trim();
        if (trimmedValue.length > 0) {
            parts.push(trimmedValue);
        }
    }
    return parts;
};
const parseFormatList = (textValue) => {
    // 1) Convert the raw format token list.
    // 2) Keep only supported members.
    // 3) Fail when all entries are invalid.
    const selectedValues = splitList(textValue).map((value) => value.toLowerCase());
    const selectedFormats = [];
    for (const selectedValue of selectedValues) {
        if (isSubtitleFormat(selectedValue)) {
            selectedFormats.push(selectedValue);
        }
    }
    if (selectedFormats.length === 0) {
        throw new Error(`Invalid subtitle formats: ${textValue}`);
    }
    return selectedFormats;
};
const parseLanguageList = (textValue) => {
    // 1) Convert language tokens into explicit list.
    // 2) Keep order and trim formatting noise.
    const normalizedLanguages = splitList(textValue);
    if (normalizedLanguages.length > 0) {
        return normalizedLanguages;
    }
    throw new Error(`Invalid language tokens: ${textValue}`);
};
const parseExportFormat = (textValue) => {
    // 1) Normalize and validate `output-format`.
    // 2) Return typed output format.
    const loweredValue = textValue.trim().toLowerCase();
    if (!isOutputFormat(loweredValue)) {
        throw new Error(`Invalid output format: ${textValue}`);
    }
    return loweredValue;
};
const parseKeyValue = (argumentText) => {
    // 1) Parse `key=value` tokens.
    // 2) Make key lowercased for consistent routing.
    const splitPos = argumentText.indexOf('=');
    if (splitPos < 0) {
        throw new Error(`Invalid argument: ${argumentText}`);
    }
    return {
        key: argumentText.slice(0, splitPos).trim().toLowerCase(),
        value: argumentText.slice(splitPos + 1).trim(),
    };
};
const looksLikeSourceUrl = (argumentText) => {
    // 1) Preserve positional URL inputs even when query string contains `=`.
    // 2) Keep this check before strict key-value parsing.
    const loweredText = argumentText.toLowerCase();
    const hasWebProtocol = loweredText.startsWith(HTTP_SCHEME_PREFIX) || loweredText.startsWith(HTTPS_SCHEME_PREFIX);
    if (!hasWebProtocol) {
        return false;
    }
    return loweredText.includes(YOUTUBE_HOST_MARK) || loweredText.includes(SHORTS_HOST_MARK);
};
const applyValueSetting = (optionKey, rawValue, parsedOptions) => {
    // 1) Route all key=value and --key value options to one place.
    // 2) Keep option-specific parsing localized.
    if (optionKey === OPTION_WITH_VALUE_FORMAT) {
        parsedOptions.formats = parseFormatList(rawValue);
        return;
    }
    if (optionKey === OPTION_WITH_VALUE_LANG) {
        parsedOptions.languageTokens = parseLanguageList(rawValue);
        return;
    }
    if (optionKey === OPTION_WITH_VALUE_OUT_DIR) {
        parsedOptions.outDirectory = rawValue;
        return;
    }
    if (optionKey === OPTION_WITH_VALUE_OUTPUT_FORMAT) {
        parsedOptions.exportFormat = parseExportFormat(rawValue);
        return;
    }
    if (optionKey === OPTION_WITH_VALUE_AGENT) {
        if (rawValue === NONE_AGENT_VALUE) {
            parsedOptions.localAgent = null;
            return;
        }
        if (!isSupportedAgent(rawValue)) {
            throw new Error(`Unsupported local agent: ${rawValue}`);
        }
        parsedOptions.localAgent = rawValue;
        return;
    }
    if (optionKey === OPTION_WITH_VALUE_SYSTEM_PROMPT) {
        parsedOptions.systemPrompt = rawValue;
        return;
    }
};
const parseBooleanFlag = (optionKey, parsedOptions) => {
    // 1) Parse auto and stdout booleans.
    // 2) Keep behavior explicit and reversible.
    if (optionKey === OPTION_BOOLEAN_AUTO) {
        parsedOptions.includeAutoCaptions = true;
        return;
    }
    if (optionKey === OPTION_BOOLEAN_STDOUT) {
        parsedOptions.writeToStdout = true;
    }
};
const parseInteractiveAgent = async () => {
    // 1) Ask once for preferred local agent.
    // 2) Return null when user chooses to skip post-processing.
    const choices = [
        { value: NONE_AGENT_VALUE, label: 'Skip local agent' },
        ...localAgentKeys.map((agentName) => ({ value: agentName, label: agentName })),
    ];
    const selectedAgent = await select({
        message: 'Select local agent',
        options: choices,
        initialValue: NONE_AGENT_VALUE,
    });
    if (isCancel(selectedAgent)) {
        cancel('Aborted');
        return process.exit(0);
    }
    if (selectedAgent === NONE_AGENT_VALUE) {
        return null;
    }
    if (!isSupportedAgent(selectedAgent)) {
        throw new Error(`Unsupported local agent: ${selectedAgent}`);
    }
    return selectedAgent;
};
const parseInteractiveOptions = async () => {
    // 1) Open interactive prompts for all optional configuration fields.
    // 2) Return options with defaults and overrides.
    intro('yt-captions-mini-ai options');
    const chosenFormats = await multiselect({
        message: 'Select subtitle formats',
        options: subtitleFormatValues.map((formatType) => ({ value: formatType, label: formatType })),
        required: true,
        initialValues: DEFAULT_FORMAT_LIST,
    });
    if (isCancel(chosenFormats)) {
        cancel('Aborted');
        return process.exit(0);
    }
    const languageText = await text({
        message: 'Language tokens',
        defaultValue: DEFAULT_LANGUAGE_TOKEN,
    });
    if (isCancel(languageText)) {
        cancel('Aborted');
        return process.exit(0);
    }
    const useAuto = await confirm({
        message: 'Allow auto captions',
        initialValue: false,
    });
    if (isCancel(useAuto)) {
        cancel('Aborted');
        return process.exit(0);
    }
    const chosenOutput = await select({
        message: 'Output format',
        options: [
            { value: DEFAULT_INTERACTIVE_OUTPUT, label: 'Keep source format' },
            { value: 'txt', label: 'txt' },
            { value: 'md', label: 'md' },
            { value: 'json', label: 'json' },
            { value: 'jsonl', label: 'jsonl' },
        ],
        initialValue: DEFAULT_INTERACTIVE_OUTPUT,
    });
    if (isCancel(chosenOutput)) {
        cancel('Aborted');
        return process.exit(0);
    }
    const outputFolder = await text({
        message: 'Output folder',
        defaultValue: DEFAULT_OUTPUT_FOLDER,
    });
    if (isCancel(outputFolder)) {
        cancel('Aborted');
        return process.exit(0);
    }
    const writeToStdout = await confirm({
        message: 'Write to stdout only',
        initialValue: false,
    });
    if (isCancel(writeToStdout)) {
        cancel('Aborted');
        return process.exit(0);
    }
    const selectedAgent = await parseInteractiveAgent();
    let systemPrompt = defaultSystemPrompt;
    if (selectedAgent !== null) {
        const promptMode = await select({
            message: 'System prompt',
            options: [
                { value: DEFAULT_PROMPT_CHOICE, label: 'Default prompt' },
                { value: 'custom', label: 'Custom prompt' },
            ],
            initialValue: DEFAULT_PROMPT_CHOICE,
        });
        if (isCancel(promptMode)) {
            cancel('Aborted');
            return process.exit(0);
        }
        if (promptMode !== DEFAULT_PROMPT_CHOICE) {
            const promptText = await text({
                message: 'Paste system prompt',
                defaultValue: defaultSystemPrompt,
            });
            if (isCancel(promptText)) {
                cancel('Aborted');
                return process.exit(0);
            }
            systemPrompt = promptText;
        }
    }
    const interactiveOptions = {
        formats: chosenFormats,
        languageTokens: parseLanguageList(languageText),
        includeAutoCaptions: useAuto,
        exportFormat: isOutputFormat(chosenOutput) ? chosenOutput : null,
        outDirectory: outputFolder === EMPTY_VALUE ? DEFAULT_OUTPUT_FOLDER : outputFolder,
        writeToStdout,
        localAgent: selectedAgent,
        systemPrompt,
    };
    outro('Ready');
    return interactiveOptions;
};
const collectArguments = (argumentTokens) => {
    // 1) Parse command-line tokens into options and URL.
    // 2) Accept both `key=value` and `--key value` forms.
    // 3) Preserve positional URL when no `url=` token is used.
    const parsedOptions = { ...defaultOptions };
    let sourceUrl = EMPTY_VALUE;
    for (let tokenIndex = 0; tokenIndex < argumentTokens.length; tokenIndex += 1) {
        const cliToken = argumentTokens[tokenIndex];
        if (cliToken.startsWith(OPTION_TOKEN_PREFIX)) {
            const optionKey = cliToken.slice(OPTION_TOKEN_PREFIX.length).toLowerCase();
            if (optionKey === OPTION_BOOLEAN_HELP) {
                throw new Error(USAGE_TEXT);
            }
            if (optionKey === OPTION_WITH_VALUE_FORMAT || optionKey === OPTION_WITH_VALUE_LANG || optionKey === OPTION_WITH_VALUE_OUT_DIR
                || optionKey === OPTION_WITH_VALUE_OUTPUT_FORMAT || optionKey === OPTION_WITH_VALUE_AGENT || optionKey === OPTION_WITH_VALUE_SYSTEM_PROMPT) {
                const nextValue = argumentTokens[tokenIndex + 1];
                if (nextValue === undefined) {
                    throw new Error(`${optionKey} requires value`);
                }
                tokenIndex += 1;
                applyValueSetting(optionKey, nextValue, parsedOptions);
                continue;
            }
            if (optionKey === OPTION_WITH_VALUE_URL) {
                const nextValue = argumentTokens[tokenIndex + 1];
                if (nextValue === undefined) {
                    throw new Error(`${OPTION_WITH_VALUE_URL} requires value`);
                }
                tokenIndex += 1;
                sourceUrl = nextValue;
                continue;
            }
            if (optionKey === OPTION_BOOLEAN_AUTO || optionKey === OPTION_BOOLEAN_STDOUT) {
                parseBooleanFlag(optionKey, parsedOptions);
                continue;
            }
            throw new Error(`Unknown option: ${cliToken}`);
        }
        if (cliToken.includes('=')) {
            if (looksLikeSourceUrl(cliToken) && sourceUrl.length === 0) {
                sourceUrl = cliToken;
                continue;
            }
            const { key, value } = parseKeyValue(cliToken);
            if (key === OPTION_WITH_VALUE_FORMAT || key === OPTION_WITH_VALUE_LANG || key === OPTION_WITH_VALUE_OUT_DIR || key === OPTION_WITH_VALUE_OUTPUT_FORMAT
                || key === OPTION_WITH_VALUE_AGENT || key === OPTION_WITH_VALUE_SYSTEM_PROMPT || key === OPTION_WITH_VALUE_URL) {
                if (key === OPTION_WITH_VALUE_URL) {
                    sourceUrl = value;
                }
                else {
                    applyValueSetting(key, value, parsedOptions);
                }
                continue;
            }
            if (key === OPTION_BOOLEAN_AUTO) {
                if (value.length === 0) {
                    parsedOptions.includeAutoCaptions = true;
                }
                else {
                    parsedOptions.includeAutoCaptions = parseBoolean(value);
                }
                continue;
            }
            if (key === OPTION_BOOLEAN_STDOUT) {
                if (value.length === 0) {
                    parsedOptions.writeToStdout = true;
                }
                else {
                    parsedOptions.writeToStdout = parseBoolean(value);
                }
                continue;
            }
            throw new Error(`Unknown option: ${key}`);
        }
        if (cliToken === OPTION_BOOLEAN_AUTO) {
            parsedOptions.includeAutoCaptions = true;
            continue;
        }
        if (cliToken === OPTION_BOOLEAN_STDOUT) {
            parsedOptions.writeToStdout = true;
            continue;
        }
        if (sourceUrl.length === 0) {
            sourceUrl = cliToken;
            continue;
        }
    }
    if (sourceUrl.length === 0) {
        throw new Error(USAGE_TEXT);
    }
    return { sourceUrl, options: parsedOptions };
};
export const parseCliArguments = async (argumentList) => {
    // 1) Accept fast CLI mode and preserve existing behavior.
    // 2) If no args are supplied, use interactive mode.
    // 3) Parse user input with strict validation and clear error text.
    if (argumentList.length === 0) {
        const options = await parseInteractiveOptions();
        const videoInput = await text({
            message: 'YouTube URL or ID',
        });
        if (isCancel(videoInput) || videoInput.length === 0) {
            cancel('Aborted');
            return process.exit(0);
        }
        return { sourceUrl: videoInput, options };
    }
    return collectArguments(argumentList);
};
