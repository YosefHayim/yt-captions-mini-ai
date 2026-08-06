// ============================================================================
// Domain constants + union types (SSOT)
// ============================================================================

// Supported subtitle container formats for download URLs and CLI `format=`.
export const subtitleFormatValues = ['json3', 'srv1', 'srv2', 'srv3', 'ttml', 'srt', 'vtt'] as const;
// One allowed YouTube subtitle format token.
export type SubtitleFormat = typeof subtitleFormatValues[number];

// Supported presentation formats for saved files and stdout.
export const outputFormatValues = ['txt', 'md', 'json', 'jsonl'] as const;
// One allowed export presentation format token.
export type OutputFormat = typeof outputFormatValues[number];

// Known local agent command targets supported by this helper.
export const localAgentKeys = ['grok', 'codex', 'devin', 'claude', 'gemini', 'kiro', 'kimi', 'agent', 'cursor'] as const;
// One allowed local agent label.
export type LocalAgent = typeof localAgentKeys[number];

// Channel bulk-scrape tab kinds (Videos vs Shorts).
export const channelTabKindValues = ['videos', 'shorts'] as const;
// One channel tab used for bulk discovery and output folder prefix.
export type ChannelTabKind = typeof channelTabKindValues[number];

// Reasoning effort tokens accepted by CLIs that support them (Grok, etc.).
export const reasoningEffortValues = ['low', 'medium', 'high'] as const;
// One allowed reasoning effort token.
export type ReasoningEffort = typeof reasoningEffortValues[number];

// Empty systemPrompt: composeSkillSystemPrompt builds the official per-agent skill authoring prompt.
export const emptySystemPrompt = '';

// ============================================================================
// CLI / orchestration
// ============================================================================

// Runtime options derived from CLI arguments.
export type CliOptions = {
  // Subtitle formats to request from YouTube.
  formats: SubtitleFormat[];
  // Language preference tokens such as `en`, `en-US`, or `all`.
  languageTokens: string[];
  // When true, fall back to auto-generated captions.
  includeAutoCaptions: boolean;
  // Final presentation format for persisted output.
  exportFormat: OutputFormat | null;
  // Directory where subtitle files are persisted.
  outDirectory: string;
  // If true, print subtitle content to stdout and skip file writes.
  writeToStdout: boolean;
  // Optional local agent label for post-processing transcripts.
  localAgent: LocalAgent | null;
  // Optional model id for the selected agent CLI (`model=`).
  agentModel: string | null;
  // Optional reasoning effort for agents that support it (`reasoning-effort=`).
  reasoningEffort: ReasoningEffort | null;
  // Extra user guidance; empty uses official skill authoring prompt only.
  systemPrompt: string;
  // Optional Netscape cookies.txt path for YouTube session cookies.
  cookiesFilePath: string | null;
  // Bulk filter: include only videos published on/after this UTC calendar day (YYYY-MM-DD).
  filterSinceDate: string | null;
  // Bulk filter: include only videos published on/before this UTC calendar day (YYYY-MM-DD).
  filterUntilDate: string | null;
  // Bulk filter: minimum video duration in whole seconds (inclusive).
  filterMinDurationSec: number | null;
  // Bulk filter: maximum video duration in whole seconds (inclusive).
  filterMaxDurationSec: number | null;
  // Bulk filter: title must include ALL of these tokens (case-insensitive).
  filterTitleIncludes: string[];
  // Bulk filter: title must include NONE of these tokens (case-insensitive).
  filterTitleExcludes: string[];
  // Max parallel video workers for playlist/channel bulk (1 = serial).
  concurrency: number;
  // Optional cap on bulk videos (playlist/channel); null = no cap.
  maxVideos: number | null;
};

// Public metadata used to decide whether a bulk video id should be scraped.
export type YoutubeVideoMetadata = {
  // 11-character YouTube video identifier.
  videoId: string;
  // Video title from player / microformat (empty string when missing).
  title: string;
  // Publish time as ISO-8601 when known; null when YouTube omits it.
  publishedAtIso: string | null;
  // Length in whole seconds when known; null when omitted.
  durationSec: number | null;
};

// Active bulk filters derived from CLI (same fields as CliOptions filter*).
export type VideoFilterCriteria = {
  // Inclusive lower bound publish day (YYYY-MM-DD) or null.
  sinceDate: string | null;
  // Inclusive upper bound publish day (YYYY-MM-DD) or null.
  untilDate: string | null;
  // Inclusive minimum duration seconds or null.
  minDurationSec: number | null;
  // Inclusive maximum duration seconds or null.
  maxDurationSec: number | null;
  // Title must contain each token (case-insensitive).
  titleIncludes: string[];
  // Title must contain none of these tokens (case-insensitive).
  titleExcludes: string[];
};

// One video's converted caption artifacts plus plain-text seed for the local agent.
export type TranscriptBundle = {
  // Identifier for this video's transcript set.
  videoId: string;
  // Human-readable title when YouTube metadata provides it.
  videoName: string | null;
  // Canonical watch URL for this video.
  videoUrl: string;
  // Language chosen for downloaded captions.
  languageTag: string;
  // One or more artifacts for selected output combinations.
  artifacts: TranscriptArtifact[];
  // Plain transcript used as local-agent input.
  localAgentTranscript: string;
};

// Paths written under scraped-yt/agents/<agent>/<model[_effort]>/<videoId>/.
export type AgentArtifactPaths = {
  // Package root for this video's agent conversion.
  packageDirectory: string;
  // Caption copy next to generated skills.
  captionFile: string;
  // Written SKILL.md (and optional support) files.
  skillFiles: string[];
  // Run metrics JSON.
  metricsFile: string;
};

// ============================================================================
// Captions / YouTube
// ============================================================================

// Transcript artifact generated from caption conversion.
export type TranscriptArtifact = {
  // Canonical YouTube video identifier.
  videoId: string;
  // Language used for the transcript variant.
  languageTag: string;
  // Captions source format from YouTube.
  sourceFormat: SubtitleFormat;
  // Final output format selected for this artifact.
  outputFormat: SubtitleFormat | OutputFormat;
  // Converted output body.
  outputText: string;
  // Persisted path when writeToStdout is false.
  outputPath: string | null;
};

// Caption track shape used by the downloader pipeline.
export type YoutubeCaptionTrack = {
  // Caption request URL extracted from player response.
  baseUrl: string;
  // Language tag used for output filename and selection.
  languageTag: string;
  // Track source classification: `manual` vs `asr`.
  sourceKind: string;
};

// Input required to identify a YouTube watch page from an id/url.
export type YoutubeVideoInput = {
  // Canonical watch URL used for fetch.
  canonicalWatchUrl: string;
  // 11-character YouTube video identifier.
  videoId: string;
};

// Final subtitle download written to filesystem or stdout.
export type CaptionDownload = {
  // Video identifier for file naming and logging.
  videoId: string;
  // Resolved language tag for file naming and logs.
  languageTag: string;
  // Requested subtitle output format.
  fileFormat: SubtitleFormat;
  // Raw subtitle body from YouTube.
  fileContent: string;
};

// Soft-fetch outcome when HTML can fall back to another client.
export type OptionalFetchBody = {
  // Decoded response body.
  bodyText: string;
  // HTTP status code of the successful reply.
  statusCode: number;
};

// ============================================================================
// Agent invocation + metrics
// ============================================================================

// Strategy key for recovering usage fields from agent stdout.
export type MetricsParserKind = 'claude-json' | 'codex-jsonl' | 'gemini-json' | 'grok-json' | 'plain-text';

// How the agent CLI is invoked and how stdout metrics are recovered.
export type AgentInvocationProfile = {
  // Executable command resolved on PATH for this local agent choice.
  commandName: string;
  // Argument shapes tried in order; `__PROMPT__` is replaced with the full prompt.
  argumentPlans: string[][];
  // When true, the full prompt is written to stdin instead of argv.
  sendPromptOnStdin: boolean;
  // Parser strategy for this agent's official machine-readable output.
  metricsParser: MetricsParserKind;
  // Documented source label written into the metrics JSON.
  metricsSource: string;
  // Static capability gaps for this agent CLI (augmented at runtime).
  unavailableNotes: string[];
};

// Parsed skill body plus optional usage fields from agent stdout.
export type ParsedAgentStdout = {
  // Skill / assistant body extracted from agent stdout.
  skillBody: string;
  // Model id when the CLI reports one.
  modelUsed: string | null;
  // Prompt/input tokens when the CLI reports them.
  inputTokens: number | null;
  // Completion/output tokens when the CLI reports them.
  outputTokens: number | null;
  // Cached prompt tokens when the CLI reports them.
  cacheReadTokens: number | null;
  // Cache-write tokens when the CLI reports them.
  cacheWriteTokens: number | null;
  // Reasoning/thinking tokens when the CLI reports them.
  reasoningTokens: number | null;
  // Estimated USD cost when the CLI reports it.
  totalCostUsd: number | null;
  // Count of tool invocations when the CLI reports them.
  toolCallCount: number | null;
  // Model context-window size when known or reported.
  contextWindowTokens: number | null;
};

// Inputs required to invoke a local agent against one transcript.
export type AgentTranscriptInput = {
  // Chosen local agent.
  localAgent: LocalAgent;
  // Instruction text / extra guidance (empty = official skill prompt only).
  systemPrompt: string;
  // Transcript language label from caption metadata.
  languageTag: string;
  // Raw transcript content to convert.
  transcriptBody: string;
  // Video id used in logs and prompt context.
  videoId: string;
  // Human-readable title when YouTube metadata provides it.
  videoName: string | null;
  // Canonical watch URL for this video.
  videoUrl: string;
  // Optional model id for the agent CLI (-m / --model).
  agentModel: string | null;
  // Optional reasoning effort for agents that support it.
  reasoningEffort: ReasoningEffort | null;
};

// Captured process I/O from one agent CLI spawn.
export type AgentCommandRun = {
  // Captured text from STDOUT.
  commandOutput: string;
  // Captured text from STDERR.
  commandError: string;
  // Process exit status.
  statusCode: number | null;
  // Wall-clock duration of the spawn.
  durationMs: number;
  // Executable that was launched.
  commandName: string;
  // Arguments actually passed (prompt may be truncated in metrics only).
  commandArgs: string[];
};

// Public result of a successful local-agent run.
export type AgentTaskOutput = {
  // Skill body produced by the selected local agent.
  skillBody: string;
  // Agent target that produced the skill.
  localAgent: LocalAgent;
  // Structured usage/resource snapshot for this run.
  runMetrics: AgentRunMetrics;
};

// Run-level usage and resource snapshot captured from a local agent CLI.
export type AgentRunMetrics = {
  // Local agent that produced the skill output.
  localAgent: LocalAgent;
  // Video the transcript belonged to.
  videoId: string;
  // Human-readable video title when resolved from YouTube metadata.
  videoName: string | null;
  // Canonical YouTube watch URL for this video.
  videoUrl: string;
  // Caption language tag paired with this run.
  languageTag: string;
  // Model id requested via CLI (`model=` / plan pin).
  requestedModel: string | null;
  // Reasoning effort requested via CLI (`reasoning-effort=`).
  requestedReasoningEffort: ReasoningEffort | null;
  // Model id resolved for the run (stdout, else requested, else null).
  modelUsed: string | null;
  // True when modelUsed was filled from request because stdout omitted model.
  modelUsedFromRequest: boolean;
  // Prompt/input tokens when the CLI reports them.
  inputTokens: number | null;
  // Completion/output tokens when the CLI reports them.
  outputTokens: number | null;
  // Cached prompt tokens when the CLI reports them.
  cacheReadTokens: number | null;
  // Cache-write tokens when the CLI reports them.
  cacheWriteTokens: number | null;
  // Reasoning/thinking tokens when the CLI reports them.
  reasoningTokens: number | null;
  // Estimated USD cost when the CLI reports it.
  totalCostUsd: number | null;
  // Count of tool invocations (0 when parsed stream had none).
  toolCallCount: number | null;
  // Model context-window size when known or reported.
  contextWindowTokens: number | null;
  // Wall-clock duration of the agent process in milliseconds.
  durationMs: number;
  // Executable invoked for this run.
  commandName: string;
  // Arguments passed to the executable (prompt body omitted for size).
  commandArgsSummary: string[];
  // Process exit code when available.
  statusCode: number | null;
  // How metrics were obtained (official JSON flag, wall-clock only, etc.).
  metricsSource: string;
  // ISO timestamp when metrics were finalized.
  capturedAt: string;
  // Explicit gaps for fields this agent CLI cannot expose / did not emit.
  unavailableNotes: string[];
};

// Metrics file written next to a skill package (run metrics + package paths).
export type AgentMetricsFile = AgentRunMetrics & {
  // Skill directory names written under the package root.
  skillDirectoryNames: string[];
  // Absolute paths of skill files written for this run.
  skillFiles: string[];
};

// One model choice discovered from an agent CLI.
export type AgentModelChoice = {
  // Stable id passed to the agent CLI `--model` / `-m` flag.
  modelId: string;
  // Human label for interactive TUI.
  displayLabel: string;
  // True when the CLI marks this model as default.
  isDefault: boolean;
};

// How models are listed and selected for one local agent.
export type AgentModelCatalog = {
  // Executable used for listing (usually same as run command).
  listCommandName: string;
  // Args that print available models to stdout.
  listArgumentPlan: string[];
  // Args that select a model for a headless run (id appended or __MODEL__).
  modelFlagTokens: string[];
  // Optional reasoning-effort flag tokens (id appended) for agents that support it.
  reasoningEffortFlagTokens: string[] | null;
  // Official docs note for operators.
  docsNote: string;
};

// ============================================================================
// Skill packages
// ============================================================================

// Official skill-format profile for one local agent target.
export type AgentSkillProfile = {
  // Local agent key.
  localAgent: LocalAgent;
  // Human label for logs/prompts.
  displayName: string;
  // Primary official docs URL when published.
  officialDocsUrl: string | null;
  // Local fallback reference when official docs are thin/missing.
  localReferencePath: string;
  // Where the user would install the skill for this agent.
  installPathHint: string;
  // Frontmatter fields required/expected for this agent.
  frontmatterRequirements: string;
  // Extra product-specific rules.
  formatNotes: string;
};

// One file extracted from the agent skill package response.
export type SkillPackageFile = {
  // Relative path inside the package (e.g. clean-naming/SKILL.md).
  relativePath: string;
  // File body including frontmatter when present.
  fileBody: string;
};

// Parsed skill package ready to persist under agents/<agent>/...
export type SkillPackage = {
  // Files to write relative to the package root.
  packageFiles: SkillPackageFile[];
  // Skill directory names discovered from SKILL.md paths.
  skillDirectoryNames: string[];
};
