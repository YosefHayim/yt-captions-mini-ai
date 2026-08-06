import { spawn } from 'node:child_process';
import { Effect, Either, Schema } from 'effect';

import { materializeModelFlags } from './agentModels.js';
import {
  AgentCommandRun,
  AgentInvocationProfile,
  AgentRunMetrics,
  AgentTaskOutput,
  AgentTranscriptInput,
  LocalAgent,
  MetricsParserKind,
  ParsedAgentStdout,
  ReasoningEffort,
} from './types.js';
import { composeSkillSystemPrompt } from './skill-prompt.js';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  FILE_ENCODING: AGENT_OUTPUT_ENCODING,
  NEWLINE: AGENT_JSONL_LINE_SEPARATOR,
  DOUBLE_NEWLINE: AGENT_PROMPT_BREAK,
} = CONSTANTS.shared;
const {
  AGENT_INPUT_HEADER,
  AGENT_VIDEO_LABEL,
  AGENT_LANGUAGE_LABEL,
  AGENT_TRANSCRIPT_HEADER,
  AGENT_COMMAND_NOT_FOUND,
  AGENT_COMMAND_TIMEOUT_MS,
  AGENT_OUTPUT_TAG,
  PROMPT_ARG_PLACEHOLDER,
  LONG_ARG_SUMMARY_LIMIT,
  LONG_ARG_SUMMARY_PREFIX_LENGTH,
  CODEX_SPARK_MODEL,
  PROMPT_CONSUMING_FLAGS: PROMPT_CONSUMING_FLAG_LIST,
} = CONSTANTS.agent;
const PROMPT_CONSUMING_FLAGS = new Set<string>(PROMPT_CONSUMING_FLAG_LIST);

const AGENT_PROFILES: Record<LocalAgent, AgentInvocationProfile> = {
  claude: {
    commandName: 'claude',
    argumentPlans: [['-p', PROMPT_ARG_PLACEHOLDER, '--output-format', 'json']],
    sendPromptOnStdin: false,
    metricsParser: 'claude-json',
    metricsSource: 'claude -p --output-format json (official print mode)',
    unavailableNotes: [
      'contextWindowTokens is not in print-mode JSON; use interactive /context for live window fill.',
    ],
  },
  codex: {
    commandName: 'codex',
    // Pin Codex Spark model explicitly for skill generation runs.
    argumentPlans: [
      ['exec', '--json', '--skip-git-repo-check', '-m', CODEX_SPARK_MODEL, PROMPT_ARG_PLACEHOLDER],
    ],
    sendPromptOnStdin: false,
    metricsParser: 'codex-jsonl',
    metricsSource: `codex exec --json -m ${CODEX_SPARK_MODEL} (official NDJSON event stream)`,
    unavailableNotes: [
      'contextWindowTokens is not emitted on turn.completed events.',
      'toolCallCount is counted from item.completed tool-ish event types when present.',
    ],
  },
  gemini: {
    commandName: 'gemini',
    argumentPlans: [['-p', PROMPT_ARG_PLACEHOLDER, '--output-format', 'json']],
    sendPromptOnStdin: false,
    metricsParser: 'gemini-json',
    metricsSource: 'gemini -p --output-format json (official headless JSON)',
    unavailableNotes: [
      'Token fields depend on Gemini CLI JSON schema version; missing keys stay null.',
    ],
  },
  grok: {
    commandName: 'grok',
    argumentPlans: [
      ['-p', PROMPT_ARG_PLACEHOLDER, '--output-format', 'json', '--always-approve'],
    ],
    sendPromptOnStdin: false,
    metricsParser: 'grok-json',
    metricsSource: 'grok -p --output-format json -m <model> (official headless JSON)',
    unavailableNotes: [
      'Token fields depend on Grok Build event envelope; missing keys stay null.',
    ],
  },
  agent: {
    commandName: 'agent',
    argumentPlans: [
      ['-p', PROMPT_ARG_PLACEHOLDER, '--output-format', 'json', '--always-approve'],
    ],
    sendPromptOnStdin: false,
    metricsParser: 'grok-json',
    metricsSource: 'agent -p --output-format json -m <model> (Grok Build alias)',
    unavailableNotes: [
      'Token fields depend on Grok Build event envelope; missing keys stay null.',
    ],
  },
  devin: {
    commandName: 'devin',
    argumentPlans: [['-p', PROMPT_ARG_PLACEHOLDER]],
    sendPromptOnStdin: false,
    metricsParser: 'plain-text',
    metricsSource: 'devin -p (print mode; wall-clock only for usage)',
    unavailableNotes: [
      'Devin print mode does not document token/cost JSON on stdout.',
      'Use --export for conversation logs; usage lives in Devin product UI/account.',
    ],
  },
  kimi: {
    commandName: 'kimi',
    argumentPlans: [['-p', PROMPT_ARG_PLACEHOLDER], []],
    sendPromptOnStdin: false,
    metricsParser: 'plain-text',
    metricsSource: 'kimi -p (best-effort; no stable public usage JSON contract)',
    unavailableNotes: [
      'Kimi CLI does not publish a stable headless usage JSON schema for automation.',
      'Session JSONL under the Kimi data dir may hold usage offline; not scraped here.',
    ],
  },
  kiro: {
    commandName: 'kiro-cli',
    argumentPlans: [['chat', '--no-interactive', PROMPT_ARG_PLACEHOLDER]],
    sendPromptOnStdin: false,
    metricsParser: 'plain-text',
    metricsSource: 'kiro-cli chat --no-interactive (stdout text only)',
    unavailableNotes: [
      'Kiro headless mode prints assistant text only; credits/tokens are not in stdout.',
    ],
  },
  cursor: {
    commandName: 'cursor',
    argumentPlans: [['agent', PROMPT_ARG_PLACEHOLDER], ['-p', PROMPT_ARG_PLACEHOLDER], []],
    sendPromptOnStdin: false,
    metricsParser: 'plain-text',
    metricsSource: 'cursor (best-effort; no official per-run CLI usage JSON)',
    unavailableNotes: [
      'Cursor documents usage on the web dashboard, not a stable headless per-run JSON API.',
      'inputTokens/outputTokens/modelUsed stay null unless a future CLI emits them.',
    ],
  },
};

const buildAgentPrompt = (
  localAgent: LocalAgent,
  systemPrompt: string,
  transcriptBody: string,
  videoId: string,
  languageTag: string,
): string => {
  // 1) Always inject the agent-specific official skill authoring contract.
  const skillSystemPrompt = composeSkillSystemPrompt(localAgent, systemPrompt);
  // 2) Attach video metadata + transcript under explicit labels.
  return `${AGENT_INPUT_HEADER}
${skillSystemPrompt}${AGENT_PROMPT_BREAK}${AGENT_VIDEO_LABEL} ${videoId}${AGENT_PROMPT_BREAK}${AGENT_LANGUAGE_LABEL} ${languageTag}${AGENT_PROMPT_BREAK}${AGENT_TRANSCRIPT_HEADER}
${transcriptBody}`;
};

const materializeArgumentPlan = (argumentPlan: string[], promptBody: string): string[] =>
  argumentPlan.map((argumentToken) => (argumentToken === PROMPT_ARG_PLACEHOLDER ? promptBody : argumentToken));

const stripHardcodedModelFlags = (argumentPlan: string[]): string[] => {
  // Drop embedded `-m/--model <id>` so runtime model flags win.
  const cleanedTokens: string[] = [];
  for (let tokenIndex = 0; tokenIndex < argumentPlan.length; tokenIndex += 1) {
    const tokenValue = argumentPlan[tokenIndex];
    if (tokenValue === '-m' || tokenValue === '--model') {
      tokenIndex += 1;
      continue;
    }
    cleanedTokens.push(tokenValue);
  }
  return cleanedTokens;
};

const insertModelFlagsBesidePrompt = (
  argumentPlan: string[],
  flagTokens: string[],
  promptBody: string,
): string[] => {
  // 1) No model flags → keep plan as-is.
  if (flagTokens.length === 0) {
    return argumentPlan;
  }
  const promptIndex = argumentPlan.indexOf(promptBody);
  if (promptIndex < 0) {
    return [...flagTokens, ...argumentPlan];
  }

  // 2) When the prompt is the value of -p/--single/--print, place model flags AFTER that pair
  //    so the prompt is not stolen as the model id.
  const previousToken = promptIndex > 0 ? argumentPlan[promptIndex - 1] : EMPTY_VALUE;
  if (PROMPT_CONSUMING_FLAGS.has(previousToken)) {
    return [
      ...argumentPlan.slice(0, promptIndex + 1),
      ...flagTokens,
      ...argumentPlan.slice(promptIndex + 1),
    ];
  }

  // 3) Positional prompt (e.g. codex exec … <prompt>): place model flags BEFORE the prompt.
  return [
    ...argumentPlan.slice(0, promptIndex),
    ...flagTokens,
    ...argumentPlan.slice(promptIndex),
  ];
};

const summarizeCommandArgs = (commandArgs: string[], promptBody: string): string[] =>
  commandArgs.map((argumentToken) => {
    if (argumentToken === promptBody) {
      return `<prompt ${promptBody.length} chars>`;
    }
    if (argumentToken.length > LONG_ARG_SUMMARY_LIMIT) {
      return `${argumentToken.slice(0, LONG_ARG_SUMMARY_PREFIX_LENGTH)}...`;
    }
    return argumentToken;
  });

// Loose usage bag used across Claude/Codex/Gemini/Grok envelopes.
const agentUsageSchema = Schema.Struct({
  // Anthropic-style input tokens.
  input_tokens: Schema.optional(Schema.Number),
  // Camel-case input tokens.
  inputTokens: Schema.optional(Schema.Number),
  // Prompt token alias used by some Gemini envelopes.
  promptTokenCount: Schema.optional(Schema.Number),
  // Prompt token alias used by OpenAI-style usage.
  prompt_tokens: Schema.optional(Schema.Number),
  // Anthropic-style output tokens.
  output_tokens: Schema.optional(Schema.Number),
  // Camel-case output tokens.
  outputTokens: Schema.optional(Schema.Number),
  // Gemini candidates token count.
  candidatesTokenCount: Schema.optional(Schema.Number),
  // OpenAI-style completion tokens.
  completion_tokens: Schema.optional(Schema.Number),
  // Anthropic cache read tokens.
  cache_read_input_tokens: Schema.optional(Schema.Number),
  // Camel-case cache read tokens.
  cacheReadInputTokens: Schema.optional(Schema.Number),
  // Gemini cached content tokens.
  cachedContentTokenCount: Schema.optional(Schema.Number),
  // Generic cache read alias.
  cache_read_tokens: Schema.optional(Schema.Number),
  // Codex cached input tokens.
  cached_input_tokens: Schema.optional(Schema.Number),
  // Generic cached tokens alias.
  cached_tokens: Schema.optional(Schema.Number),
  // Anthropic cache write tokens.
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  // Camel-case cache write tokens.
  cacheWriteInputTokens: Schema.optional(Schema.Number),
  // Generic cache write tokens.
  cache_write_tokens: Schema.optional(Schema.Number),
  // Reasoning tokens.
  reasoning_tokens: Schema.optional(Schema.Number),
  // Thinking tokens alias.
  thinking_tokens: Schema.optional(Schema.Number),
  // Codex reasoning output tokens.
  reasoning_output_tokens: Schema.optional(Schema.Number),
  // Gemini thoughts token count.
  thoughtsTokenCount: Schema.optional(Schema.Number),
  // Tool call count when nested under usage.
  tool_calls: Schema.optional(Schema.Number),
  // Camel-case tool call count.
  toolCallCount: Schema.optional(Schema.Number),
});

// Shared top-level agent JSON envelope fields (Claude/Gemini/Grok).
const agentEnvelopeSchema = Schema.Struct({
  // Primary assistant text (Claude).
  result: Schema.optional(Schema.String),
  // Structured output alternate.
  structured_output: Schema.optional(Schema.String),
  // Gemini-style response text.
  response: Schema.optional(Schema.String),
  // Generic text field.
  text: Schema.optional(Schema.String),
  // Generic output field.
  output: Schema.optional(Schema.String),
  // Grok-style message field.
  message: Schema.optional(Schema.String),
  // Model id.
  model: Schema.optional(Schema.String),
  // Alternate model name field.
  modelName: Schema.optional(Schema.String),
  // Gemini model version field.
  modelVersion: Schema.optional(Schema.String),
  // Grok model id field.
  modelId: Schema.optional(Schema.String),
  // Nested usage object.
  usage: Schema.optional(agentUsageSchema),
  // Gemini stats object.
  stats: Schema.optional(agentUsageSchema),
  // Total cost USD.
  total_cost_usd: Schema.optional(Schema.Number),
  // Camel-case total cost.
  totalCostUsd: Schema.optional(Schema.Number),
  // Generic cost field.
  cost: Schema.optional(Schema.Number),
  // Claude turn count.
  num_turns: Schema.optional(Schema.Number),
  // Top-level tool call count.
  tool_calls: Schema.optional(Schema.Number),
  // Top-level tool call count alias.
  tool_call_count: Schema.optional(Schema.Number),
  // Context window size.
  context_window: Schema.optional(Schema.Number),
  // Camel-case context window.
  contextWindow: Schema.optional(Schema.Number),
});

// One Codex NDJSON event line.
const codexEventSchema = Schema.Struct({
  // Event type discriminator.
  type: Schema.optional(Schema.String),
  // Model id when present on the event.
  model: Schema.optional(Schema.String),
  // Nested item payload for item.completed.
  item: Schema.optional(
    Schema.Struct({
      // Item type such as agent_message or tool call.
      type: Schema.optional(Schema.String),
      // Assistant text body.
      text: Schema.optional(Schema.String),
    }),
  ),
  // Nested usage payload for turn.completed.
  usage: Schema.optional(agentUsageSchema),
});

const decodeJsonUnknown = Schema.decodeUnknown(Schema.parseJson(Schema.Unknown));
const decodeAgentEnvelope = Schema.decodeUnknown(agentEnvelopeSchema);
const decodeCodexEvent = Schema.decodeUnknown(codexEventSchema);

const blankParsedStdout = (skillBody: string): ParsedAgentStdout => ({
  skillBody,
  modelUsed: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  totalCostUsd: null,
  toolCallCount: null,
  contextWindowTokens: null,
});

const firstNonEmptyString = (...stringFields: Array<string | undefined>): string | null => {
  for (const stringField of stringFields) {
    if (stringField === undefined) {
      continue;
    }
    const trimmedField = stringField.trim();
    if (trimmedField.length > 0) {
      return trimmedField;
    }
  }
  return null;
};

const firstFiniteNumber = (...numericFields: Array<number | undefined>): number | null => {
  for (const numericField of numericFields) {
    if (numericField !== undefined && Number.isFinite(numericField)) {
      return numericField;
    }
  }
  return null;
};

const decodeJsonText = (jsonText: string): unknown | null => {
  // Decode JSON text with Effect Schema.parseJson instead of bare JSON.parse.
  const decodedEither = Effect.runSync(Effect.either(decodeJsonUnknown(jsonText)));
  return Either.isRight(decodedEither) ? decodedEither.right : null;
};

const decodeEnvelope = (jsonText: string) => {
  // Parse then validate the shared agent envelope schema.
  const parsedJson = decodeJsonText(jsonText);
  if (parsedJson === null) {
    return null;
  }
  const envelopeEither = Effect.runSync(Effect.either(decodeAgentEnvelope(parsedJson)));
  return Either.isRight(envelopeEither) ? envelopeEither.right : null;
};

const parseClaudeJson = (commandOutput: string): ParsedAgentStdout => {
  const envelope = decodeEnvelope(commandOutput);
  if (!envelope) {
    return blankParsedStdout(commandOutput.trim());
  }
  const usageNode = envelope.usage;
  const skillBody = firstNonEmptyString(envelope.result, envelope.structured_output) ?? commandOutput.trim();
  return {
    skillBody,
    modelUsed: firstNonEmptyString(envelope.model, envelope.modelName),
    inputTokens: firstFiniteNumber(usageNode?.input_tokens, usageNode?.inputTokens),
    outputTokens: firstFiniteNumber(usageNode?.output_tokens, usageNode?.outputTokens),
    cacheReadTokens: firstFiniteNumber(usageNode?.cache_read_input_tokens, usageNode?.cacheReadInputTokens),
    cacheWriteTokens: firstFiniteNumber(usageNode?.cache_creation_input_tokens, usageNode?.cacheWriteInputTokens),
    reasoningTokens: firstFiniteNumber(usageNode?.reasoning_tokens, usageNode?.thinking_tokens),
    totalCostUsd: firstFiniteNumber(envelope.total_cost_usd, envelope.totalCostUsd),
    toolCallCount: firstFiniteNumber(envelope.num_turns, envelope.tool_calls),
    contextWindowTokens: firstFiniteNumber(envelope.context_window, envelope.contextWindow),
  };
};

const parseCodexJsonl = (commandOutput: string): ParsedAgentStdout => {
  let latestMessage = EMPTY_VALUE;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let modelUsed: string | null = null;
  let toolCallCount = 0;

  for (const eventLine of commandOutput.split(AGENT_JSONL_LINE_SEPARATOR)) {
    const trimmedLine = eventLine.trim();
    if (!trimmedLine.startsWith('{')) {
      continue;
    }
    const parsedJson = decodeJsonText(trimmedLine);
    if (parsedJson === null) {
      continue;
    }
    const eventEither = Effect.runSync(Effect.either(decodeCodexEvent(parsedJson)));
    if (Either.isLeft(eventEither)) {
      continue;
    }
    const eventNode = eventEither.right;
    const eventType = eventNode.type ?? EMPTY_VALUE;

    if (eventType === 'item.completed' && eventNode.item) {
      const itemType = eventNode.item.type ?? EMPTY_VALUE;
      if (itemType === 'agent_message') {
        const messageBody = firstNonEmptyString(eventNode.item.text);
        if (messageBody) {
          latestMessage = messageBody;
        }
      } else if (itemType.length > 0) {
        // Count non-message completed items as tool/resource work (command, mcp, file, web, …).
        toolCallCount += 1;
      }
    }

    // Some Codex builds emit tool items under item.started / tool.called variants.
    if (
      eventType.includes('tool')
      || eventType.includes('command')
      || eventType === 'item.started'
    ) {
      const itemType = eventNode.item?.type ?? EMPTY_VALUE;
      if (itemType !== 'agent_message' && eventType !== 'item.completed') {
        toolCallCount += 1;
      }
    }

    if (eventType === 'turn.completed' && eventNode.usage) {
      inputTokens = firstFiniteNumber(eventNode.usage.input_tokens) ?? inputTokens;
      outputTokens = firstFiniteNumber(eventNode.usage.output_tokens) ?? outputTokens;
      cacheReadTokens = firstFiniteNumber(eventNode.usage.cached_input_tokens) ?? cacheReadTokens;
      reasoningTokens = firstFiniteNumber(eventNode.usage.reasoning_output_tokens) ?? reasoningTokens;
    }

    if (!modelUsed) {
      modelUsed = firstNonEmptyString(eventNode.model);
    }
  }

  const skillBody = latestMessage.length > 0 ? latestMessage : commandOutput.trim();
  return {
    skillBody,
    modelUsed,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: null,
    reasoningTokens,
    totalCostUsd: null,
    // 0 is meaningful: JSONL parsed successfully and no tool items were observed.
    toolCallCount,
    contextWindowTokens: null,
  };
};

const parseGeminiJson = (commandOutput: string): ParsedAgentStdout => {
  const envelope = decodeEnvelope(commandOutput);
  if (!envelope) {
    return blankParsedStdout(commandOutput.trim());
  }
  const statsNode = envelope.stats ?? envelope.usage;
  const skillBody =
    firstNonEmptyString(envelope.response, envelope.result, envelope.text, envelope.output) ??
    commandOutput.trim();
  return {
    skillBody,
    modelUsed: firstNonEmptyString(envelope.model, envelope.modelVersion),
    inputTokens: firstFiniteNumber(statsNode?.inputTokens, statsNode?.input_tokens, statsNode?.promptTokenCount),
    outputTokens: firstFiniteNumber(statsNode?.outputTokens, statsNode?.output_tokens, statsNode?.candidatesTokenCount),
    cacheReadTokens: firstFiniteNumber(statsNode?.cachedContentTokenCount, statsNode?.cache_read_tokens),
    cacheWriteTokens: null,
    reasoningTokens: firstFiniteNumber(statsNode?.thoughtsTokenCount, statsNode?.reasoning_tokens),
    totalCostUsd: firstFiniteNumber(envelope.total_cost_usd, envelope.cost),
    toolCallCount: firstFiniteNumber(statsNode?.toolCallCount, statsNode?.tool_calls),
    contextWindowTokens: firstFiniteNumber(envelope.contextWindow, envelope.context_window),
  };
};

const parseGrokJson = (commandOutput: string): ParsedAgentStdout => {
  const trimmedOutput = commandOutput.trim();
  if (!trimmedOutput.startsWith('{') && !trimmedOutput.includes('\n{')) {
    return blankParsedStdout(trimmedOutput);
  }

  if (trimmedOutput.includes('\n') && trimmedOutput.includes('"type"')) {
    return parseCodexJsonl(trimmedOutput);
  }

  const envelope = decodeEnvelope(trimmedOutput);
  if (!envelope) {
    return blankParsedStdout(trimmedOutput);
  }
  const usageNode = envelope.usage;
  const skillBody =
    firstNonEmptyString(envelope.result, envelope.message, envelope.text, envelope.output) ?? trimmedOutput;
  return {
    skillBody,
    modelUsed: firstNonEmptyString(envelope.model, envelope.modelId),
    inputTokens: firstFiniteNumber(usageNode?.input_tokens, usageNode?.inputTokens, usageNode?.prompt_tokens),
    outputTokens: firstFiniteNumber(usageNode?.output_tokens, usageNode?.outputTokens, usageNode?.completion_tokens),
    cacheReadTokens: firstFiniteNumber(usageNode?.cache_read_tokens, usageNode?.cached_tokens),
    cacheWriteTokens: firstFiniteNumber(usageNode?.cache_write_tokens),
    reasoningTokens: firstFiniteNumber(usageNode?.reasoning_tokens),
    totalCostUsd: firstFiniteNumber(envelope.total_cost_usd, envelope.cost),
    toolCallCount: firstFiniteNumber(envelope.tool_call_count, usageNode?.tool_calls),
    contextWindowTokens: firstFiniteNumber(envelope.context_window, envelope.contextWindow),
  };
};

const parseAgentStdout = (metricsParser: MetricsParserKind, commandOutput: string): ParsedAgentStdout => {
  switch (metricsParser) {
    case 'claude-json':
      return parseClaudeJson(commandOutput);
    case 'codex-jsonl':
      return parseCodexJsonl(commandOutput);
    case 'gemini-json':
      return parseGeminiJson(commandOutput);
    case 'grok-json':
      return parseGrokJson(commandOutput);
    case 'plain-text':
      return blankParsedStdout(commandOutput.trim());
  }
};

const runAgentCommand = (
  commandName: string,
  argumentPlan: string[],
  promptBody: string,
  shouldSendPromptToStdin: boolean,
): Promise<AgentCommandRun> => {
  const startedAtMs = Date.now();
  return new Promise((resolve, reject) => {
    const command = spawn(commandName, argumentPlan, { stdio: ['pipe', 'pipe', 'pipe'] });
    let capturedOutput = EMPTY_VALUE;
    let capturedError = EMPTY_VALUE;
    command.stdout.setEncoding(AGENT_OUTPUT_ENCODING);
    command.stderr.setEncoding(AGENT_OUTPUT_ENCODING);

    command.stdout.on('data', (chunk: string) => {
      capturedOutput = `${capturedOutput}${chunk}`;
    });
    command.stderr.on('data', (chunk: string) => {
      capturedError = `${capturedError}${chunk}`;
    });

    const timerHandle = setTimeout(() => {
      command.kill();
      resolve({
        commandOutput: capturedOutput,
        commandError: `${capturedError} timed out after ${AGENT_COMMAND_TIMEOUT_MS}ms`,
        statusCode: null,
        durationMs: Date.now() - startedAtMs,
        commandName,
        commandArgs: argumentPlan,
      });
    }, AGENT_COMMAND_TIMEOUT_MS);

    command.on('error', (spawnError: Error) => {
      clearTimeout(timerHandle);
      reject(spawnError);
    });

    command.on('close', (statusCode: number | null) => {
      clearTimeout(timerHandle);
      resolve({
        commandOutput: capturedOutput,
        commandError: capturedError,
        statusCode,
        durationMs: Date.now() - startedAtMs,
        commandName,
        commandArgs: argumentPlan,
      });
    });

    if (shouldSendPromptToStdin) {
      command.stdin?.write(promptBody);
    }
    command.stdin?.end();
  });
};

const isAgentMissingError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const errno = (error as NodeJS.ErrnoException).code;
  if (errno === AGENT_COMMAND_NOT_FOUND) {
    return true;
  }
  const messageLower = error.message.toLowerCase();
  return (
    messageLower.includes('not found in path') ||
    messageLower.includes('not found') ||
    messageLower.includes('command not found')
  );
};

const extractRequestedModelFromArgs = (commandArgs: string[]): string | null => {
  // Read `-m/--model <id>` from the actual argv used for this run.
  for (let tokenIndex = 0; tokenIndex < commandArgs.length; tokenIndex += 1) {
    const tokenValue = commandArgs[tokenIndex];
    if ((tokenValue === '-m' || tokenValue === '--model') && tokenIndex + 1 < commandArgs.length) {
      return commandArgs[tokenIndex + 1];
    }
  }
  return null;
};

const extractRequestedReasoningFromArgs = (commandArgs: string[]): ReasoningEffort | null => {
  // Read `--reasoning-effort <level>` from the actual argv used for this run.
  for (let tokenIndex = 0; tokenIndex < commandArgs.length; tokenIndex += 1) {
    if (commandArgs[tokenIndex] === '--reasoning-effort' && tokenIndex + 1 < commandArgs.length) {
      const effortToken = commandArgs[tokenIndex + 1];
      if (effortToken === 'low' || effortToken === 'medium' || effortToken === 'high') {
        return effortToken;
      }
    }
  }
  return null;
};

const buildUnavailableNotes = (
  agentProfile: AgentInvocationProfile,
  parsedStdout: ParsedAgentStdout,
  requestedModel: string | null,
  requestedReasoningEffort: ReasoningEffort | null,
  modelUsedFromRequest: boolean,
): string[] => {
  // 1) Start from static profile notes.
  const unavailableNotes = [...agentProfile.unavailableNotes];

  // 2) Record request-time model/effort visibility (always present in metrics fields).
  if (requestedModel) {
    unavailableNotes.push(`requestedModel=${requestedModel} (from CLI argv -m/--model).`);
  } else {
    unavailableNotes.push('requestedModel was not set on this run (no -m/--model).');
  }
  if (requestedReasoningEffort) {
    unavailableNotes.push(`requestedReasoningEffort=${requestedReasoningEffort} (from CLI --reasoning-effort).`);
  } else {
    unavailableNotes.push('requestedReasoningEffort was not set on this run (no --reasoning-effort).');
  }

  // 3) Explain null/filled fields for this concrete response.
  if (modelUsedFromRequest) {
    unavailableNotes.push('modelUsed was filled from requestedModel because stdout did not emit a model id.');
  }
  if (parsedStdout.inputTokens === null) {
    unavailableNotes.push('inputTokens missing: parser found no input/prompt token field in agent stdout.');
  }
  if (parsedStdout.outputTokens === null) {
    unavailableNotes.push('outputTokens missing: parser found no output/completion token field in agent stdout.');
  }
  if (parsedStdout.cacheReadTokens === null) {
    unavailableNotes.push('cacheReadTokens missing: agent stdout did not emit cache-read tokens.');
  }
  if (parsedStdout.cacheWriteTokens === null) {
    unavailableNotes.push('cacheWriteTokens missing: agent stdout did not emit cache-write tokens (Codex/Grok often omit this).');
  }
  if (parsedStdout.reasoningTokens === null) {
    unavailableNotes.push('reasoningTokens missing: agent stdout did not emit reasoning/thinking tokens.');
  }
  if (parsedStdout.totalCostUsd === null) {
    unavailableNotes.push('totalCostUsd missing: this CLI path does not emit USD cost in headless stdout.');
  }
  if (parsedStdout.toolCallCount === null) {
    unavailableNotes.push('toolCallCount missing: stdout was not a parseable tool-event stream.');
  }
  if (parsedStdout.contextWindowTokens === null) {
    unavailableNotes.push('contextWindowTokens missing: headless mode does not expose context-window size.');
  }

  return unavailableNotes;
};

const composeRunMetrics = (
  localAgent: LocalAgent,
  videoId: string,
  videoName: string | null,
  videoUrl: string,
  languageTag: string,
  agentProfile: AgentInvocationProfile,
  commandRun: AgentCommandRun,
  parsedStdout: ParsedAgentStdout,
  promptBody: string,
  agentModel: string | null,
  reasoningEffort: ReasoningEffort | null,
): AgentRunMetrics => {
  // 1) Prefer argv-resolved model/effort, then explicit input fields.
  const requestedModel = extractRequestedModelFromArgs(commandRun.commandArgs) ?? agentModel;
  const requestedReasoningEffort =
    extractRequestedReasoningFromArgs(commandRun.commandArgs) ?? reasoningEffort;
  // 2) Prefer stdout model; fall back to requested model so metrics are never "blank" when known.
  const modelUsedFromRequest = parsedStdout.modelUsed === null && requestedModel !== null;
  const modelUsed = parsedStdout.modelUsed ?? requestedModel;

  return {
    localAgent,
    videoId,
    videoName,
    videoUrl,
    languageTag,
    requestedModel,
    requestedReasoningEffort,
    modelUsed,
    modelUsedFromRequest,
    inputTokens: parsedStdout.inputTokens,
    outputTokens: parsedStdout.outputTokens,
    cacheReadTokens: parsedStdout.cacheReadTokens,
    cacheWriteTokens: parsedStdout.cacheWriteTokens,
    reasoningTokens: parsedStdout.reasoningTokens,
    totalCostUsd: parsedStdout.totalCostUsd,
    toolCallCount: parsedStdout.toolCallCount,
    contextWindowTokens: parsedStdout.contextWindowTokens,
    durationMs: commandRun.durationMs,
    commandName: commandRun.commandName,
    commandArgsSummary: summarizeCommandArgs(commandRun.commandArgs, promptBody),
    statusCode: commandRun.statusCode,
    metricsSource: agentProfile.metricsSource,
    capturedAt: new Date().toISOString(),
    unavailableNotes: buildUnavailableNotes(
      agentProfile,
      parsedStdout,
      requestedModel,
      requestedReasoningEffort,
      modelUsedFromRequest,
    ),
  };
};

export const runLocalAgent = async ({
  localAgent,
  systemPrompt,
  languageTag,
  transcriptBody,
  videoId,
  videoName,
  videoUrl,
  agentModel,
  reasoningEffort,
}: AgentTranscriptInput): Promise<AgentTaskOutput> => {
  const agentProfile = AGENT_PROFILES[localAgent];
  const promptBody = buildAgentPrompt(localAgent, systemPrompt, transcriptBody, videoId, languageTag);
  const modelFlagTokens = materializeModelFlags(localAgent, agentModel, reasoningEffort);
  const planCount = agentProfile.argumentPlans.length;

  for (let planIndex = 0; planIndex < planCount; planIndex += 1) {
    const basePlan = materializeArgumentPlan(agentProfile.argumentPlans[planIndex], promptBody);
    // Prefer explicit user model flags; otherwise keep plan pins (e.g. codex spark).
    const argumentPlan =
      modelFlagTokens.length > 0
        ? insertModelFlagsBesidePrompt(stripHardcodedModelFlags(basePlan), modelFlagTokens, promptBody)
        : basePlan;
    const shouldSendPromptToStdin = agentProfile.sendPromptOnStdin || argumentPlan.length === 0;
    try {
      const commandRun = await runAgentCommand(
        agentProfile.commandName,
        argumentPlan,
        promptBody,
        shouldSendPromptToStdin,
      );
      const parsedStdout = parseAgentStdout(agentProfile.metricsParser, commandRun.commandOutput);
      const skillBody = parsedStdout.skillBody.trim();
      const hasUsefulOutput = skillBody.length > 0;

      if (commandRun.statusCode === 0 && hasUsefulOutput) {
        return {
          localAgent,
          skillBody,
          runMetrics: composeRunMetrics(
            localAgent,
            videoId,
            videoName,
            videoUrl,
            languageTag,
            agentProfile,
            commandRun,
            parsedStdout,
            promptBody,
            agentModel,
            reasoningEffort,
          ),
        };
      }

      if (planIndex === planCount - 1) {
        const commandError = commandRun.commandError.trim();
        if (commandError.length > 0) {
          throw new Error(`${AGENT_OUTPUT_TAG} output: ${commandError}`);
        }
        if (!hasUsefulOutput) {
          throw new Error(`Could not get response from ${localAgent}`);
        }
        return {
          localAgent,
          skillBody,
          runMetrics: composeRunMetrics(
            localAgent,
            videoId,
            videoName,
            videoUrl,
            languageTag,
            agentProfile,
            commandRun,
            parsedStdout,
            promptBody,
            agentModel,
            reasoningEffort,
          ),
        };
      }
    } catch (commandError) {
      if (!isAgentMissingError(commandError)) {
        if (planIndex === planCount - 1) {
          throw commandError;
        }
        continue;
      }
      throw new Error(
        `Install the "${localAgent}" CLI or set PATH so "${agentProfile.commandName}" is discoverable.`,
      );
    }
  }

  throw new Error(`Could not get response from ${localAgent}`);
};
