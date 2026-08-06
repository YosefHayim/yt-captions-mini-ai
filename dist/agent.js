import { spawn } from 'node:child_process';
const AGENT_INPUT_HEADER = 'System Prompt:';
const AGENT_VIDEO_LABEL = 'Video:';
const AGENT_LANGUAGE_LABEL = 'Language:';
const AGENT_TRANSCRIPT_HEADER = 'Transcript:';
const AGENT_PROMPT_BREAK = '\n\n';
const AGENT_OUTPUT_ENCODING = 'utf8';
const AGENT_COMMAND_NOT_FOUND = 'ENOENT';
const AGENT_COMMAND_ATTEMPTS = 3;
const AGENT_COMMAND_TIMEOUT_MS = 120000;
const AGENT_OUTPUT_TAG = 'Agent';
const AGENT_PROFILES = {
    claude: {
        commandName: 'claude',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    kimi: {
        commandName: 'kimi',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    codex: {
        commandName: 'codex',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    grok: {
        commandName: 'grok',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    devin: {
        commandName: 'devin',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    gemini: {
        commandName: 'gemini',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    kiro: {
        commandName: 'kiro',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    cursor: {
        commandName: 'cursor',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
    agent: {
        commandName: 'agent',
        argumentPlans: [['-p'], ['--prompt'], []],
    },
};
const buildAgentPrompt = (systemPrompt, transcriptText, videoId, languageTag) => {
    // 1) Build a single prompt block with explicit section labels.
    // 2) Put transcript content below instruction and metadata.
    // 3) Keep one deterministic text block for CLI args and stdin.
    const messageBody = `${AGENT_INPUT_HEADER}
${systemPrompt}${AGENT_PROMPT_BREAK}${AGENT_VIDEO_LABEL} ${videoId}${AGENT_PROMPT_BREAK}${AGENT_LANGUAGE_LABEL} ${languageTag}${AGENT_PROMPT_BREAK}${AGENT_TRANSCRIPT_HEADER}
${transcriptText}`;
    return messageBody;
};
const runAgentCommand = (commandName, argumentPlan, promptText, shouldSendPromptToStdin) => {
    // 1) Spawn the selected command with explicit args and stream capture.
    // 2) Feed prompt through stdin only when the command profile expects it.
    // 3) Resolve when process exits, including exit code and output streams.
    return new Promise((resolve, reject) => {
        const command = spawn(commandName, argumentPlan, { stdio: ['pipe', 'pipe', 'pipe'] });
        let capturedOutput = '';
        let capturedError = '';
        command.stdout.setEncoding(AGENT_OUTPUT_ENCODING);
        command.stderr.setEncoding(AGENT_OUTPUT_ENCODING);
        command.stdout.on('data', (chunk) => {
            capturedOutput = `${capturedOutput}${chunk}`;
        });
        command.stderr.on('data', (chunk) => {
            capturedError = `${capturedError}${chunk}`;
        });
        const timerHandle = setTimeout(() => {
            command.kill();
            resolve({
                commandOutput: capturedOutput,
                commandError: `${capturedError} timed out after ${AGENT_COMMAND_TIMEOUT_MS}ms`,
                statusCode: null,
            });
        }, AGENT_COMMAND_TIMEOUT_MS);
        command.on('error', (error) => {
            clearTimeout(timerHandle);
            reject(error);
        });
        command.on('close', (statusCode) => {
            clearTimeout(timerHandle);
            resolve({
                commandOutput: capturedOutput,
                commandError: capturedError,
                statusCode,
            });
        });
        if (shouldSendPromptToStdin) {
            command.stdin?.write(promptText);
            command.stdin?.end();
        }
    });
};
const isAgentMissingError = (error) => {
    // 1) Identify command-not-found failures from spawn.
    // 2) Keep the check local so parser can provide a clearer user message.
    if (!(error instanceof Error)) {
        return false;
    }
    const errno = error.code;
    const isNotFoundError = errno === AGENT_COMMAND_NOT_FOUND;
    const messageLower = error.message.toLowerCase();
    if (isNotFoundError) {
        return true;
    }
    return messageLower.includes('not found in path') || messageLower.includes('not found') || messageLower.includes('command not found');
};
export const runLocalAgent = async ({ localAgent, systemPrompt, languageTag, transcriptText, videoId, }) => {
    // 1) Resolve command profile and build a single prompt payload.
    // 2) Try argument variants progressively and stop on first successful response.
    // 3) Require non-empty stdout unless this is the final fallback path.
    const agentProfile = AGENT_PROFILES[localAgent];
    const promptText = buildAgentPrompt(systemPrompt, transcriptText, videoId, languageTag);
    for (let index = 0; index < Math.min(agentProfile.argumentPlans.length, AGENT_COMMAND_ATTEMPTS); index += 1) {
        const argumentPlan = agentProfile.argumentPlans[index];
        const argumentWithPrompt = argumentPlan.length ? [...argumentPlan, promptText] : [];
        const shouldSendPromptToStdin = argumentPlan.length === 0;
        try {
            const runResult = await runAgentCommand(agentProfile.commandName, argumentWithPrompt, promptText, shouldSendPromptToStdin);
            if (runResult.statusCode === 0 && runResult.commandOutput.trim().length > 0) {
                return {
                    localAgent,
                    agentResponseText: runResult.commandOutput.trim(),
                };
            }
            const commandError = runResult.commandError.trim();
            if (commandError.length > 0 && index === AGENT_COMMAND_ATTEMPTS - 1) {
                throw new Error(`${AGENT_OUTPUT_TAG} output: ${commandError}`);
            }
        }
        catch (commandError) {
            if (!isAgentMissingError(commandError)) {
                if (index === AGENT_COMMAND_ATTEMPTS - 1) {
                    throw commandError;
                }
                continue;
            }
            throw new Error(`Install the "${localAgent}" CLI or set PATH so "${agentProfile.commandName}" is discoverable.`);
        }
    }
    throw new Error(`Could not get response from ${localAgent}`);
};
