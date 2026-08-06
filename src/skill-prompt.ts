import { AgentSkillProfile, LocalAgent } from './types.js';

import { CONSTANTS } from './constants.js';

const {
  LOCAL_SKILL_REFERENCE,
  FILE_MARKER_OPEN,
  FILE_MARKER_CLOSE,
  FILE_END_MARKER,
  OPEN_STANDARD_URL,
} = CONSTANTS.skillPrompt;

export const AGENT_SKILL_PROFILES: Record<LocalAgent, AgentSkillProfile> = {
  claude: {
    localAgent: 'claude',
    displayName: 'Claude Code',
    officialDocsUrl: 'https://code.claude.com/docs/en/skills',
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: '~/.claude/skills/<name>/SKILL.md or .claude/skills/<name>/SKILL.md',
    frontmatterRequirements: 'YAML frontmatter with description (required/recommended). Optional: name, when_to_use, allowed-tools, disable-model-invocation, argument-hint, paths, metadata.',
    formatNotes: 'Follow Agent Skills + Claude Code extensions. Directory name becomes /skill-name. Keep body actionable; put long material in references/.',
  },
  codex: {
    localAgent: 'codex',
    displayName: 'OpenAI Codex CLI',
    officialDocsUrl: 'https://github.com/openai/codex/blob/main/docs/skills.md',
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: '~/.codex/skills/<name>/SKILL.md or .codex/skills/<name>/SKILL.md',
    frontmatterRequirements: 'YAML frontmatter with name + description. Optional metadata.short-description.',
    formatNotes: 'Codex discovers folders containing SKILL.md. Description is the primary trigger. Progressive disclosure: read SKILL.md first, then references/ only as needed.',
  },
  grok: {
    localAgent: 'grok',
    displayName: 'Grok Build',
    officialDocsUrl: null,
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: '~/.grok/skills/<name>/SKILL.md or .grok/skills/<name>/SKILL.md',
    frontmatterRequirements: 'YAML frontmatter with name + description. Optional metadata.short-description.',
    formatNotes: 'Match Grok create-skill format exactly. name is lowercase-hyphen slug. description must include trigger phrases and /slash-command usage.',
  },
  agent: {
    localAgent: 'agent',
    displayName: 'Grok Build (agent alias)',
    officialDocsUrl: null,
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: '~/.grok/skills/<name>/SKILL.md or .grok/skills/<name>/SKILL.md',
    frontmatterRequirements: 'YAML frontmatter with name + description. Optional metadata.short-description.',
    formatNotes: 'Same as Grok Build skills.',
  },
  gemini: {
    localAgent: 'gemini',
    displayName: 'Gemini CLI',
    officialDocsUrl: 'https://geminicli.com/docs/',
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: 'Prefer portable Agent Skills layout (skill-name/SKILL.md) for cross-agent reuse.',
    frontmatterRequirements: 'Portable name + description frontmatter (agentskills.io).',
    formatNotes: 'If Gemini-specific skill packaging is unavailable, emit portable SKILL.md packages and note install mapping in the body.',
  },
  cursor: {
    localAgent: 'cursor',
    displayName: 'Cursor',
    officialDocsUrl: null,
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: 'Prefer portable Agent Skills layout; map into Cursor rules/skills as needed.',
    frontmatterRequirements: 'Portable name + description frontmatter (agentskills.io).',
    formatNotes: 'Use portable SKILL.md so the skill can also run in Claude/Codex/Grok. Include clear when-to-use triggers.',
  },
  devin: {
    localAgent: 'devin',
    displayName: 'Devin',
    officialDocsUrl: null,
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: 'Prefer portable Agent Skills layout (skill-name/SKILL.md).',
    frontmatterRequirements: 'Portable name + description frontmatter (agentskills.io).',
    formatNotes: 'When Devin-native skill docs are unavailable, follow docs/skill-authoring.md and agentskills.io.',
  },
  kiro: {
    localAgent: 'kiro',
    displayName: 'Kiro',
    officialDocsUrl: 'https://kiro.dev/docs/',
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: 'Prefer portable Agent Skills layout; also note .kiro/agents/ custom-agent patterns when relevant.',
    frontmatterRequirements: 'Portable name + description frontmatter unless Kiro agent JSON/YAML is clearly better for the task.',
    formatNotes: 'Default to SKILL.md packages for portability. Mention Kiro steering/agent config only when the transcript is about Kiro itself.',
  },
  kimi: {
    localAgent: 'kimi',
    displayName: 'Kimi CLI',
    officialDocsUrl: 'https://moonshotai.github.io/kimi-cli/en/',
    localReferencePath: LOCAL_SKILL_REFERENCE,
    installPathHint: 'Prefer portable Agent Skills layout (skill-name/SKILL.md).',
    frontmatterRequirements: 'Portable name + description frontmatter (agentskills.io).',
    formatNotes: 'Emit portable SKILL.md packages suitable for cross-agent reuse.',
  },
};

export const buildDefaultSkillSystemPrompt = (localAgent: LocalAgent): string => {
  // 1) Load the official skill profile for the selected agent.
  const skillProfile = AGENT_SKILL_PROFILES[localAgent];
  const officialDocsLine = skillProfile.officialDocsUrl
    ? `Official docs (follow first): ${skillProfile.officialDocsUrl}`
    : `Official product skill docs: not published / incomplete for ${skillProfile.displayName}.`;

  // 2) Build a strict skill-authoring system prompt (not a generic code dump prompt).
  return `You are a skill author for ${skillProfile.displayName}.

Your ONLY job: convert the transcript into one or more production-quality agent skills in official SKILL.md format.

## Sources of truth (in order)
1. ${officialDocsLine}
2. Open standard: ${OPEN_STANDARD_URL}
3. Local fallback reference in this repo: ${skillProfile.localReferencePath}
If (1) is missing, follow (2) + (3) exactly. Do not invent a proprietary skill format.

## Target agent
- Agent: ${skillProfile.displayName} (\`${skillProfile.localAgent}\`)
- Install path hint: ${skillProfile.installPathHint}
- Frontmatter: ${skillProfile.frontmatterRequirements}
- Notes: ${skillProfile.formatNotes}

## What to produce
- One skill if the transcript is a single workflow.
- Multiple skills if the transcript covers distinct workflows/triggers (preferred over one mega-skill).
- Each skill is a directory with SKILL.md (required). Optionally mention scripts/ or references/ when needed.
- Every SKILL.md MUST start with YAML frontmatter between --- markers.
- Required frontmatter fields at minimum:
  - name: lowercase-hyphen slug
  - description: what it does AND when to use it (trigger phrases, slash command)
- Body MUST include:
  - When to use
  - When not to use
  - Step-by-step procedure the agent can follow
  - Best practices / constraints from the transcript
  - Concrete examples
  - Expected inputs/outputs
  - Failure modes / verification
- Keep each body concise and actionable (prefer under 500 lines). Put long reference material in references/*.md notes inside the file markers if needed.
- Do NOT dump unrelated TypeScript app code unless the skill procedure requires a small script snippet.
- Do NOT invent facts that are not grounded in the transcript. If the transcript is incomplete, state assumptions under an Assumptions section.

## Output format (strict machine-readable)
Return ONLY skill files using this exact multi-file envelope (repeat for each file):

${FILE_MARKER_OPEN} <relative-path>${FILE_MARKER_CLOSE}
<file contents>
${FILE_END_MARKER}

Rules for paths:
- Use paths like: <skill-name>/SKILL.md
- Optional: <skill-name>/references/<topic>.md
- Optional: <skill-name>/scripts/<helper>.sh|ts|py
- Never wrap the whole response in a single markdown code fence outside the file markers.
- No preamble, no epilogue, no tool chatter.

## Quality bar
- Description must be specific enough for auto-invocation.
- Skills must be reusable on a real repo after install.
- Prefer principles and checklists extracted from the transcript over paraphrased motivation talk.
- If the transcript teaches Clean Code / architecture / testing, encode those as executable agent procedures, not essays.`;
};

export const composeSkillSystemPrompt = (localAgent: LocalAgent, userSystemPrompt: string): string => {
  // 1) Always include the agent-specific official skill authoring contract.
  const defaultSkillPrompt = buildDefaultSkillSystemPrompt(localAgent);
  const trimmedUserPrompt = userSystemPrompt.trim();

  // 2) If the user passed a custom system prompt, append it as additional guidance (not a replacement).
  if (!trimmedUserPrompt.length) {
    return defaultSkillPrompt;
  }

  // 3) Avoid double-including when CLI already uses the default skill prompt text.
  if (trimmedUserPrompt === defaultSkillPrompt) {
    return defaultSkillPrompt;
  }

  return `${defaultSkillPrompt}

## Additional user guidance
${trimmedUserPrompt}`;
};

export const skillFileOpenMarker = FILE_MARKER_OPEN;
export const skillFileCloseMarker = FILE_MARKER_CLOSE;
export const skillFileEndMarker = FILE_END_MARKER;
