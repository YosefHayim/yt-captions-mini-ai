export const subtitleFormatValues = ['json3', 'srv1', 'srv2', 'srv3', 'ttml', 'srt', 'vtt'];
export const outputFormatValues = ['txt', 'md', 'json', 'jsonl'];
export const localAgentKeys = ['grok', 'codex', 'devin', 'claude', 'gemini', 'kiro', 'kimi', 'agent', 'cursor'];
// Default instruction passed to every local agent when no explicit prompt is supplied.
export const defaultSystemPrompt = `You are a senior TypeScript engineer.
Read the provided transcript and produce a reusable, minimal skill-style implementation.
Return only source-ready files with clear function boundaries, typed inputs, and no speculative code.
Use a small clean structure with one file per concern and include setup notes where needed.`;
