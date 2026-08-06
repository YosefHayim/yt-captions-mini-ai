import {
  cancel,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  text as promptForLine,
  confirm,
} from '@clack/prompts';

import {
  outputFormatValues,
  subtitleFormatValues,
  SubtitleFormat,
  OutputFormat,
  CliOptions,
  LocalAgent,
  localAgentKeys,
  emptySystemPrompt,
  reasoningEffortValues,
  ReasoningEffort,
} from './types.js';
import { listAgentModels, requireAgentModel } from './agentModels.js';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  KEY_VALUE_SEPARATOR,
  YOUTUBE_HOST_MARK,
  YOUTU_BE_HOST_MARK: SHORTS_HOST_MARK,
} = CONSTANTS.shared;
const {
  DEFAULT_FORMAT_TOKEN,
  DEFAULT_LANGUAGE_TOKEN,
  DEFAULT_OUTPUT_FOLDER,
  DEFAULT_INTERACTIVE_OUTPUT,
  DEFAULT_PROMPT_CHOICE,
  OPTION_TOKEN_PREFIX,
  OPTION_WITH_VALUE_FORMAT,
  OPTION_WITH_VALUE_LANG,
  OPTION_WITH_VALUE_OUT_DIR,
  OPTION_WITH_VALUE_OUTPUT_FORMAT,
  OPTION_WITH_VALUE_AGENT,
  OPTION_WITH_VALUE_MODEL,
  OPTION_WITH_VALUE_REASONING_EFFORT,
  OPTION_WITH_VALUE_SYSTEM_PROMPT,
  OPTION_WITH_VALUE_COOKIES,
  OPTION_WITH_VALUE_URL,
  OPTION_BOOLEAN_AUTO,
  OPTION_BOOLEAN_STDOUT,
  OPTION_BOOLEAN_HELP,
  NONE_AGENT_VALUE,
  CLI_OPTION_SEPARATOR,
  BOOLEAN_TRUE,
  BOOLEAN_ONE,
  BOOLEAN_YES,
  BOOLEAN_FALSE,
  BOOLEAN_ZERO,
  BOOLEAN_NO,
  PROMPT_CHOICE_CUSTOM,
  OUTPUT_FORMAT_TXT,
  OUTPUT_FORMAT_MD,
  OUTPUT_FORMAT_JSON,
  OUTPUT_FORMAT_JSONL,
  ABORTED_LABEL,
  INTRO_MESSAGE,
  OUTRO_MESSAGE,
  PROMPT_SUBTITLE_FORMATS,
  PROMPT_LANGUAGE_TOKENS,
  PROMPT_ALLOW_AUTO,
  PROMPT_OUTPUT_FORMAT,
  PROMPT_OUTPUT_FOLDER,
  PROMPT_STDOUT_ONLY,
  PROMPT_LOCAL_AGENT,
  PROMPT_AGENT_MODEL,
  PROMPT_REASONING_EFFORT,
  PROMPT_SYSTEM_PROMPT_MODE,
  PROMPT_CUSTOM_SYSTEM_PROMPT,
  PROMPT_COOKIES_PATH,
  PROMPT_YOUTUBE_INPUT,
  LABEL_SKIP_LOCAL_AGENT,
  LABEL_KEEP_SOURCE_FORMAT,
  LABEL_OFFICIAL_SKILL_PROMPT,
  LABEL_CUSTOM_PROMPT,
  LABEL_CLI_DEFAULT_MODEL,
  LABEL_SKIP_REASONING_EFFORT,
  USAGE_TEXT,
  HTTP_SCHEME_PREFIX,
  HTTPS_SCHEME_PREFIX,
} = CONSTANTS.cli;
// Channel examples: url=https://www.youtube.com/@handle  url=https://www.youtube.com/channel/UC…
const DEFAULT_FORMAT_LIST: SubtitleFormat[] = [DEFAULT_FORMAT_TOKEN];
const DEFAULT_LANGUAGE_LIST = [DEFAULT_LANGUAGE_TOKEN];

const VALUE_OPTION_KEYS = [
  OPTION_WITH_VALUE_FORMAT,
  OPTION_WITH_VALUE_LANG,
  OPTION_WITH_VALUE_OUT_DIR,
  OPTION_WITH_VALUE_OUTPUT_FORMAT,
  OPTION_WITH_VALUE_AGENT,
  OPTION_WITH_VALUE_MODEL,
  OPTION_WITH_VALUE_REASONING_EFFORT,
  OPTION_WITH_VALUE_SYSTEM_PROMPT,
  OPTION_WITH_VALUE_COOKIES,
  OPTION_WITH_VALUE_URL,
] as const;



const defaultOptions: CliOptions = {
  formats: DEFAULT_FORMAT_LIST,
  languageTokens: DEFAULT_LANGUAGE_LIST,
  includeAutoCaptions: false,
  exportFormat: null,
  outDirectory: DEFAULT_OUTPUT_FOLDER,
  writeToStdout: false,
  localAgent: null,
  agentModel: null,
  reasoningEffort: null,
  systemPrompt: emptySystemPrompt,
  cookiesFilePath: null,
};

const isSubtitleFormat = (formatToken: string): formatToken is SubtitleFormat => {
  // Keep format validation centralized and type-safe for track selection.
  return subtitleFormatValues.includes(formatToken as SubtitleFormat);
};

const isOutputFormat = (formatToken: string): formatToken is OutputFormat => {
  // Keep final output format in the explicit export union; reject unknowns early.
  return outputFormatValues.includes(formatToken as OutputFormat);
};

const isSupportedAgent = (agentName: string): agentName is LocalAgent => {
  // Keep local agent input in the known command map; fail fast on unsupported names.
  return localAgentKeys.includes(agentName as LocalAgent);
};

const parseBoolean = (optionRawToken: string): boolean => {
  // Support explicit boolean shorthands; reject unknown tokens to prevent silent coercion.
  const loweredToken = optionRawToken.toLowerCase();
  if (loweredToken === BOOLEAN_TRUE || loweredToken === BOOLEAN_ONE || loweredToken === BOOLEAN_YES) {
    return true;
  }
  if (loweredToken === BOOLEAN_FALSE || loweredToken === BOOLEAN_ZERO || loweredToken === BOOLEAN_NO) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${optionRawToken}`);
};

const splitList = (optionRawToken: string): string[] => {
  // Split a compact comma list, trim each token, drop empties.
  const listTokens: string[] = [];
  const splitTokens = optionRawToken.split(CLI_OPTION_SEPARATOR);
  for (const splitToken of splitTokens) {
    const trimmedToken = splitToken.trim();
    if (trimmedToken.length > 0) {
      listTokens.push(trimmedToken);
    }
  }
  return listTokens;
};

const parseFormatList = (optionValue: string): SubtitleFormat[] => {
  // Convert the raw format token list; keep only supported members; fail when all invalid.
  const selectedTokens = splitList(optionValue).map((formatToken) => formatToken.toLowerCase());
  const selectedFormats: SubtitleFormat[] = [];
  for (const selectedToken of selectedTokens) {
    if (isSubtitleFormat(selectedToken)) {
      selectedFormats.push(selectedToken);
    }
  }
  if (selectedFormats.length === 0) {
    throw new Error(`Invalid subtitle formats: ${optionValue}`);
  }
  return selectedFormats;
};

const parseLanguageList = (optionValue: string): string[] => {
  // Convert language tokens into an explicit list; keep order and trim noise.
  const normalizedLanguages = splitList(optionValue);
  if (normalizedLanguages.length === 0) {
    throw new Error(`Invalid language tokens: ${optionValue}`);
  }
  return normalizedLanguages;
};

const parseExportFormat = (optionValue: string): OutputFormat => {
  // Normalize and validate `output-format`; return typed export format.
  const loweredValue = optionValue.trim().toLowerCase();
  if (!isOutputFormat(loweredValue)) {
    throw new Error(`Invalid output format: ${optionValue}`);
  }
  return loweredValue;
};

const parseKeyValue = (argumentToken: string): { optionKey: string; optionValue: string } => {
  // Parse `key=value` tokens; lowercase the key for consistent routing.
  const splitPos = argumentToken.indexOf(KEY_VALUE_SEPARATOR);
  if (splitPos < 0) {
    throw new Error(`Invalid argument: ${argumentToken}`);
  }
  return {
    optionKey: argumentToken.slice(0, splitPos).trim().toLowerCase(),
    optionValue: argumentToken.slice(splitPos + 1).trim(),
  };
};

const looksLikeSourceUrl = (argumentToken: string): boolean => {
  // Preserve positional URL inputs even when the query string contains `=`.
  const loweredToken = argumentToken.toLowerCase();
  const hasWebProtocol = loweredToken.startsWith(HTTP_SCHEME_PREFIX) || loweredToken.startsWith(HTTPS_SCHEME_PREFIX);
  if (!hasWebProtocol) {
    return false;
  }
  return loweredToken.includes(YOUTUBE_HOST_MARK) || loweredToken.includes(SHORTS_HOST_MARK);
};

const applyValueSetting = (optionKey: string, rawValue: string, parsedOptions: CliOptions): void => {
  // Route all key=value and --key value options; keep option-specific parsing localized.
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
  if (optionKey === OPTION_WITH_VALUE_MODEL) {
    parsedOptions.agentModel = rawValue.trim().length > 0 ? rawValue.trim() : null;
    return;
  }
  if (optionKey === OPTION_WITH_VALUE_REASONING_EFFORT) {
    const effortToken = rawValue.trim().toLowerCase();
    if (!(reasoningEffortValues as readonly string[]).includes(effortToken)) {
      throw new Error(
        `Invalid reasoning-effort "${rawValue}". Use one of: ${reasoningEffortValues.join(', ')}`,
      );
    }
    parsedOptions.reasoningEffort = effortToken as ReasoningEffort;
    return;
  }
  if (optionKey === OPTION_WITH_VALUE_SYSTEM_PROMPT) {
    parsedOptions.systemPrompt = rawValue;
    return;
  }
  if (optionKey === OPTION_WITH_VALUE_COOKIES) {
    if (rawValue.length > 0) {
      parsedOptions.cookiesFilePath = rawValue;
    } else {
      parsedOptions.cookiesFilePath = null;
    }
    return;
  }
};

const isValueOptionKey = (optionKey: string): boolean => {
  // Keep key membership checks in one list for --key and key=value parsers.
  return (VALUE_OPTION_KEYS as readonly string[]).includes(optionKey);
};

const parseBooleanFlag = (optionKey: string, parsedOptions: CliOptions): void => {
  // Parse auto and stdout booleans; keep behavior explicit and reversible.
  if (optionKey === OPTION_BOOLEAN_AUTO) {
    parsedOptions.includeAutoCaptions = true;
    return;
  }
  if (optionKey === OPTION_BOOLEAN_STDOUT) {
    parsedOptions.writeToStdout = true;
  }
};

const abortInteractive = (): never => {
  // Cancel interactive mode and exit cleanly.
  cancel(ABORTED_LABEL);
  return process.exit(0);
};

const parseInteractiveAgent = async (): Promise<LocalAgent | null> => {
  // Ask once for preferred local agent; return null when user skips post-processing.
  const agentChoices = [
    { value: NONE_AGENT_VALUE, label: LABEL_SKIP_LOCAL_AGENT },
    ...localAgentKeys.map((agentName) => ({ value: agentName, label: agentName })),
  ];

  const selectedAgent = await select({
    message: PROMPT_LOCAL_AGENT,
    options: agentChoices,
    initialValue: NONE_AGENT_VALUE,
  });
  if (isCancel(selectedAgent)) {
    return abortInteractive();
  }
  if (selectedAgent === NONE_AGENT_VALUE) {
    return null;
  }
  if (!isSupportedAgent(selectedAgent)) {
    throw new Error(`Unsupported local agent: ${selectedAgent}`);
  }
  return selectedAgent;
};

const parseInteractiveModel = async (localAgent: LocalAgent): Promise<string | null> => {
  // Load models from the agent CLI; if none listed, allow freeform id or CLI default.
  let modelChoices: { value: string; label: string }[] = [
    { value: EMPTY_VALUE, label: LABEL_CLI_DEFAULT_MODEL },
  ];
  try {
    const listedModels = listAgentModels(localAgent);
    if (listedModels.length > 0) {
      modelChoices = [
        { value: EMPTY_VALUE, label: LABEL_CLI_DEFAULT_MODEL },
        ...listedModels.map((modelChoice) => ({
          value: modelChoice.modelId,
          label: modelChoice.displayLabel,
        })),
      ];
    }
  } catch (listError) {
    // Surface list failures as a freeform prompt so the operator can still type a model id.
    const freeformModel = await promptForLine({
      message: `${PROMPT_AGENT_MODEL} (list failed: ${listError instanceof Error ? listError.message : String(listError)})`,
      defaultValue: EMPTY_VALUE,
    });
    if (isCancel(freeformModel)) {
      return abortInteractive();
    }
    return freeformModel.trim().length > 0 ? freeformModel.trim() : null;
  }

  const selectedModel = await select({
    message: PROMPT_AGENT_MODEL,
    options: modelChoices,
    initialValue: EMPTY_VALUE,
  });
  if (isCancel(selectedModel)) {
    return abortInteractive();
  }
  if (selectedModel === EMPTY_VALUE) {
    return null;
  }
  requireAgentModel(localAgent, selectedModel);
  return selectedModel;
};

const parseInteractiveReasoningEffort = async (
  localAgent: LocalAgent,
): Promise<ReasoningEffort | null> => {
  if (localAgent !== 'grok' && localAgent !== 'agent') {
    return null;
  }
  const effortChoice = await select({
    message: PROMPT_REASONING_EFFORT,
    options: [
      { value: EMPTY_VALUE, label: LABEL_SKIP_REASONING_EFFORT },
      ...reasoningEffortValues.map((effortToken) => ({ value: effortToken, label: effortToken })),
    ],
    initialValue: EMPTY_VALUE,
  });
  if (isCancel(effortChoice)) {
    return abortInteractive();
  }
  if (effortChoice === EMPTY_VALUE) {
    return null;
  }
  return effortChoice as ReasoningEffort;
};

const parseInteractiveOptions = async (): Promise<CliOptions> => {
  // Open interactive prompts for optional configuration; return defaults with overrides.
  intro(INTRO_MESSAGE);

  const chosenFormats = await multiselect({
    message: PROMPT_SUBTITLE_FORMATS,
    options: subtitleFormatValues.map((formatType) => ({ value: formatType, label: formatType })),
    required: true,
    initialValues: DEFAULT_FORMAT_LIST,
  });
  if (isCancel(chosenFormats)) {
    return abortInteractive();
  }

  const languageInput = await promptForLine({
    message: PROMPT_LANGUAGE_TOKENS,
    defaultValue: DEFAULT_LANGUAGE_TOKEN,
  });
  if (isCancel(languageInput)) {
    return abortInteractive();
  }

  const useAuto = await confirm({
    message: PROMPT_ALLOW_AUTO,
    initialValue: false,
  });
  if (isCancel(useAuto)) {
    return abortInteractive();
  }

  const chosenOutput = await select({
    message: PROMPT_OUTPUT_FORMAT,
    options: [
      { value: DEFAULT_INTERACTIVE_OUTPUT, label: LABEL_KEEP_SOURCE_FORMAT },
      { value: OUTPUT_FORMAT_TXT, label: OUTPUT_FORMAT_TXT },
      { value: OUTPUT_FORMAT_MD, label: OUTPUT_FORMAT_MD },
      { value: OUTPUT_FORMAT_JSON, label: OUTPUT_FORMAT_JSON },
      { value: OUTPUT_FORMAT_JSONL, label: OUTPUT_FORMAT_JSONL },
    ],
    initialValue: DEFAULT_INTERACTIVE_OUTPUT,
  });
  if (isCancel(chosenOutput)) {
    return abortInteractive();
  }

  const outputFolder = await promptForLine({
    message: PROMPT_OUTPUT_FOLDER,
    defaultValue: DEFAULT_OUTPUT_FOLDER,
  });
  if (isCancel(outputFolder)) {
    return abortInteractive();
  }

  const writeToStdout = await confirm({
    message: PROMPT_STDOUT_ONLY,
    initialValue: false,
  });
  if (isCancel(writeToStdout)) {
    return abortInteractive();
  }

  const selectedAgent = await parseInteractiveAgent();
  // Empty string means: use official per-agent skill authoring prompt in agent.ts.
  let systemPrompt = emptySystemPrompt;
  let agentModel: string | null = null;
  let reasoningEffort: ReasoningEffort | null = null;
  if (selectedAgent !== null) {
    agentModel = await parseInteractiveModel(selectedAgent);
    reasoningEffort = await parseInteractiveReasoningEffort(selectedAgent);

    const promptMode = await select({
      message: PROMPT_SYSTEM_PROMPT_MODE,
      options: [
        { value: DEFAULT_PROMPT_CHOICE, label: LABEL_OFFICIAL_SKILL_PROMPT },
        { value: PROMPT_CHOICE_CUSTOM, label: LABEL_CUSTOM_PROMPT },
      ],
      initialValue: DEFAULT_PROMPT_CHOICE,
    });
    if (isCancel(promptMode)) {
      return abortInteractive();
    }

    if (promptMode !== DEFAULT_PROMPT_CHOICE) {
      const customPromptInput = await promptForLine({
        message: PROMPT_CUSTOM_SYSTEM_PROMPT,
        defaultValue: EMPTY_VALUE,
      });
      if (isCancel(customPromptInput)) {
        return abortInteractive();
      }
      // Custom guidance is appended to the official skill contract, not a full replace.
      systemPrompt = customPromptInput;
    }
  }

  const cookiesPathInput = await promptForLine({
    message: PROMPT_COOKIES_PATH,
    defaultValue: EMPTY_VALUE,
  });
  if (isCancel(cookiesPathInput)) {
    return abortInteractive();
  }

  let exportFormat: OutputFormat | null = null;
  if (isOutputFormat(chosenOutput)) {
    exportFormat = chosenOutput;
  }

  let outDirectory = DEFAULT_OUTPUT_FOLDER;
  if (outputFolder !== EMPTY_VALUE) {
    outDirectory = outputFolder;
  }

  const trimmedCookiesPath = cookiesPathInput.trim();
  let cookiesFilePath: string | null = null;
  if (trimmedCookiesPath.length > 0) {
    cookiesFilePath = trimmedCookiesPath;
  }

  const interactiveOptions: CliOptions = {
    formats: chosenFormats,
    languageTokens: parseLanguageList(languageInput),
    includeAutoCaptions: useAuto,
    exportFormat,
    outDirectory,
    writeToStdout,
    localAgent: selectedAgent,
    agentModel,
    reasoningEffort,
    systemPrompt,
    cookiesFilePath,
  };
  outro(OUTRO_MESSAGE);
  return interactiveOptions;
};

const collectArguments = (argumentTokens: string[]): { sourceUrl: string; options: CliOptions } => {
  // Parse CLI tokens into options and URL; accept key=value and --key value; keep positional URL.
  const parsedOptions: CliOptions = { ...defaultOptions };
  let sourceUrl = EMPTY_VALUE;

  for (let tokenIndex = 0; tokenIndex < argumentTokens.length; tokenIndex += 1) {
    const cliToken = argumentTokens[tokenIndex];

    if (cliToken.startsWith(OPTION_TOKEN_PREFIX)) {
      const optionKey = cliToken.slice(OPTION_TOKEN_PREFIX.length).toLowerCase();
      if (optionKey === OPTION_BOOLEAN_HELP) {
        throw new Error(USAGE_TEXT);
      }

      if (isValueOptionKey(optionKey)) {
        const nextValue = argumentTokens[tokenIndex + 1];
        if (nextValue === undefined) {
          throw new Error(`${optionKey} requires value`);
        }
        tokenIndex += 1;
        if (optionKey === OPTION_WITH_VALUE_URL) {
          sourceUrl = nextValue;
        } else {
          applyValueSetting(optionKey, nextValue, parsedOptions);
        }
        continue;
      }

      if (optionKey === OPTION_BOOLEAN_AUTO || optionKey === OPTION_BOOLEAN_STDOUT) {
        parseBooleanFlag(optionKey, parsedOptions);
        continue;
      }
      throw new Error(`Unknown option: ${cliToken}`);
    }

    if (cliToken.includes(KEY_VALUE_SEPARATOR)) {
      if (looksLikeSourceUrl(cliToken) && sourceUrl.length === 0) {
        sourceUrl = cliToken;
        continue;
      }
      const { optionKey, optionValue } = parseKeyValue(cliToken);
      if (isValueOptionKey(optionKey)) {
        if (optionKey === OPTION_WITH_VALUE_URL) {
          sourceUrl = optionValue;
        } else {
          applyValueSetting(optionKey, optionValue, parsedOptions);
        }
        continue;
      }
      if (optionKey === OPTION_BOOLEAN_AUTO) {
        if (optionValue.length === 0) {
          parsedOptions.includeAutoCaptions = true;
        } else {
          parsedOptions.includeAutoCaptions = parseBoolean(optionValue);
        }
        continue;
      }
      if (optionKey === OPTION_BOOLEAN_STDOUT) {
        if (optionValue.length === 0) {
          parsedOptions.writeToStdout = true;
        } else {
          parsedOptions.writeToStdout = parseBoolean(optionValue);
        }
        continue;
      }
      throw new Error(`Unknown option: ${optionKey}`);
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

export const parseCliArguments = async (
  argumentList: string[],
): Promise<{ sourceUrl: string; options: CliOptions }> => {
  // Fast CLI mode when args exist; interactive mode when none; strict validation with clear errors.
  if (argumentList.length === 0) {
    const options = await parseInteractiveOptions();
    const videoInput = await promptForLine({
      message: PROMPT_YOUTUBE_INPUT,
    });
    if (isCancel(videoInput) || videoInput.length === 0) {
      return abortInteractive();
    }
    return { sourceUrl: videoInput, options };
  }
  return collectArguments(argumentList);
};
