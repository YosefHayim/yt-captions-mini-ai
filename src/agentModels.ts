import { spawnSync } from 'node:child_process';

import { AgentModelCatalog, AgentModelChoice, LocalAgent, ReasoningEffort } from './types.js';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  FILE_ENCODING: SPAWN_ENCODING,
} = CONSTANTS.shared;
const { AGENT_COMMAND_NOT_FOUND } = CONSTANTS.agent;
const {
  MODEL_FLAG_PLACEHOLDER,
  SPAWN_TIMEOUT_MS,
  DEFAULT_LABEL_MARK,
  STAR_PREFIX,
} = CONSTANTS.agentModels;

const AGENT_MODEL_CATALOGS: Record<LocalAgent, AgentModelCatalog> = {
  grok: {
    listCommandName: 'grok',
    listArgumentPlan: ['models'],
    modelFlagTokens: ['-m', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: ['--reasoning-effort'],
    docsNote: 'Official: `grok models` + `-m <MODEL>` / `--reasoning-effort` (https://docs.x.ai/)',
  },
  agent: {
    listCommandName: 'agent',
    listArgumentPlan: ['models'],
    modelFlagTokens: ['-m', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: ['--reasoning-effort'],
    docsNote: 'Grok Build alias: `agent models` + `-m <MODEL>`',
  },
  codex: {
    listCommandName: 'codex',
    listArgumentPlan: ['--help'],
    modelFlagTokens: ['-m', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Official: `codex exec -m <MODEL>` (https://developers.openai.com/codex)',
  },
  claude: {
    listCommandName: 'claude',
    listArgumentPlan: ['--help'],
    modelFlagTokens: ['--model', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Official: `claude -p --model <MODEL>` (https://code.claude.com/docs/en/overview)',
  },
  gemini: {
    listCommandName: 'gemini',
    listArgumentPlan: ['--help'],
    modelFlagTokens: ['-m', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Official: Gemini CLI model flag when listed by the CLI help',
  },
  devin: {
    listCommandName: 'devin',
    listArgumentPlan: ['models', 'list'],
    modelFlagTokens: ['--model', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Official: `devin models list` + `--model <MODEL>`',
  },
  kiro: {
    listCommandName: 'kiro-cli',
    listArgumentPlan: ['--help'],
    modelFlagTokens: ['--model', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Kiro headless model flag when exposed by the installed CLI',
  },
  kimi: {
    listCommandName: 'kimi',
    listArgumentPlan: ['--help'],
    modelFlagTokens: ['--model', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Kimi CLI model flag when exposed by the installed CLI',
  },
  cursor: {
    listCommandName: 'cursor',
    listArgumentPlan: ['--help'],
    modelFlagTokens: ['--model', MODEL_FLAG_PLACEHOLDER],
    reasoningEffortFlagTokens: null,
    docsNote: 'Cursor agent model flag when exposed by the installed CLI',
  },
};

const runListCommand = (commandName: string, listArgumentPlan: string[]): string => {
  const listRun = spawnSync(commandName, listArgumentPlan, {
    encoding: SPAWN_ENCODING,
    timeout: SPAWN_TIMEOUT_MS,
    env: process.env,
  });
  if (listRun.error) {
    const errno = (listRun.error as NodeJS.ErrnoException).code;
    if (errno === AGENT_COMMAND_NOT_FOUND) {
      throw new Error(
        `Agent CLI "${commandName}" is not on PATH. Install it or fix PATH, then re-run.`,
      );
    }
    throw new Error(`Could not list models for "${commandName}": ${listRun.error.message}`);
  }
  const stdoutBody = listRun.stdout ?? EMPTY_VALUE;
  const stderrBody = listRun.stderr ?? EMPTY_VALUE;
  return `${stdoutBody}\n${stderrBody}`;
};

const parseGrokModelsOutput = (commandOutput: string): AgentModelChoice[] => {
  const modelChoices: AgentModelChoice[] = [];
  const outputLines = commandOutput.split('\n');
  for (const outputLine of outputLines) {
    const trimmedLine = outputLine.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const starMatch = new RegExp(`^\\${STAR_PREFIX}\\s+([A-Za-z0-9._:-]+)`).exec(trimmedLine);
    if (starMatch) {
      const modelId = starMatch[1];
      const isDefault = trimmedLine.toLowerCase().includes(DEFAULT_LABEL_MARK);
      modelChoices.push({
        modelId,
        displayLabel: isDefault ? `${modelId} ${DEFAULT_LABEL_MARK}` : modelId,
        isDefault,
      });
      continue;
    }
    const plainMatch = /^([A-Za-z0-9._:-]+)\s*(?:\(default\))?$/.exec(trimmedLine);
    if (plainMatch && !trimmedLine.includes(' ') && trimmedLine.includes('grok')) {
      modelChoices.push({
        modelId: plainMatch[1],
        displayLabel: plainMatch[1],
        isDefault: false,
      });
    }
  }
  return dedupeModelChoices(modelChoices);
};

const parseDevinModelsOutput = (commandOutput: string): AgentModelChoice[] => {
  const modelChoices: AgentModelChoice[] = [];
  const outputLines = commandOutput.split('\n');
  for (const outputLine of outputLines) {
    const trimmedLine = outputLine.trim();
    // Lines like: claude-sonnet-5-medium                 Claude Sonnet 5 Medium
    const modelMatch = /^([a-z0-9][a-z0-9._-]{2,})\s{2,}/i.exec(trimmedLine);
    if (!modelMatch) {
      continue;
    }
    const modelId = modelMatch[1];
    if (modelId === 'aliases' || modelId.startsWith('Available')) {
      continue;
    }
    modelChoices.push({
      modelId,
      displayLabel: trimmedLine,
      isDefault: false,
    });
  }
  return dedupeModelChoices(modelChoices);
};

const parseHelpForModelHints = (commandOutput: string): AgentModelChoice[] => {
  // When a CLI has no list subcommand, surface documented example model ids from help text.
  const modelChoices: AgentModelChoice[] = [];
  const exampleMatches = commandOutput.matchAll(/["'`]([a-z0-9][a-z0-9._-]{2,})["'`]/gi);
  for (const exampleMatch of exampleMatches) {
    const modelId = exampleMatch[1];
    if (modelId.includes('http') || modelId.includes('path') || modelId.length < 3) {
      continue;
    }
    if (
      modelId.includes('model') ||
      modelId.includes('gpt') ||
      modelId.includes('claude') ||
      modelId.includes('gemini') ||
      modelId.includes('o3') ||
      modelId.includes('sonnet') ||
      modelId.includes('opus')
    ) {
      modelChoices.push({
        modelId,
        displayLabel: modelId,
        isDefault: false,
      });
    }
  }
  return dedupeModelChoices(modelChoices);
};

const dedupeModelChoices = (modelChoices: AgentModelChoice[]): AgentModelChoice[] => {
  const seenModelIds = new Set<string>();
  const uniqueChoices: AgentModelChoice[] = [];
  for (const modelChoice of modelChoices) {
    if (seenModelIds.has(modelChoice.modelId)) {
      continue;
    }
    seenModelIds.add(modelChoice.modelId);
    uniqueChoices.push(modelChoice);
  }
  return uniqueChoices;
};

export const getAgentModelCatalog = (localAgent: LocalAgent): AgentModelCatalog =>
  AGENT_MODEL_CATALOGS[localAgent];

export const listAgentModels = (localAgent: LocalAgent): AgentModelChoice[] => {
  const modelCatalog = AGENT_MODEL_CATALOGS[localAgent];
  const listOutput = runListCommand(modelCatalog.listCommandName, modelCatalog.listArgumentPlan);

  if (localAgent === 'grok' || localAgent === 'agent') {
    return parseGrokModelsOutput(listOutput);
  }
  if (localAgent === 'devin') {
    return parseDevinModelsOutput(listOutput);
  }
  return parseHelpForModelHints(listOutput);
};

export const requireAgentModel = (
  localAgent: LocalAgent,
  requestedModelId: string | null,
): AgentModelChoice | null => {
  // null requestedModelId means "use CLI default" (no -m flag).
  if (requestedModelId === null || requestedModelId.trim().length === 0) {
    return null;
  }

  const normalizedRequest = requestedModelId.trim();
  const availableModels = listAgentModels(localAgent);
  if (availableModels.length === 0) {
    // CLI has no discoverable list — allow freeform id; spawn will fail loudly if invalid.
    return {
      modelId: normalizedRequest,
      displayLabel: normalizedRequest,
      isDefault: false,
    };
  }

  const matchedModel = availableModels.find(
    (modelChoice) => modelChoice.modelId.toLowerCase() === normalizedRequest.toLowerCase(),
  );
  if (!matchedModel) {
    const availableIds = availableModels.map((modelChoice) => modelChoice.modelId).join(', ');
    throw new Error(
      `Model "${normalizedRequest}" is not available for agent "${localAgent}". ` +
        `Available models: ${availableIds}. ` +
        `List again with the agent CLI (${getAgentModelCatalog(localAgent).docsNote}). ` +
        `Quick fix: npm start -- url=<youtube-url> agent=${localAgent} model=<one-of-available>`,
    );
  }
  return matchedModel;
};

export const materializeModelFlags = (
  localAgent: LocalAgent,
  modelId: string | null,
  reasoningEffort: ReasoningEffort | null,
): string[] => {
  const modelCatalog = AGENT_MODEL_CATALOGS[localAgent];
  const flagTokens: string[] = [];
  if (modelId) {
    for (const flagToken of modelCatalog.modelFlagTokens) {
      flagTokens.push(flagToken === MODEL_FLAG_PLACEHOLDER ? modelId : flagToken);
    }
  }
  if (reasoningEffort && modelCatalog.reasoningEffortFlagTokens) {
    flagTokens.push(...modelCatalog.reasoningEffortFlagTokens, reasoningEffort);
  }
  return flagTokens;
};

export const sanitizeModelFolderName = (modelId: string): string =>
  modelId.replace(/[^A-Za-z0-9._-]+/g, '_');
