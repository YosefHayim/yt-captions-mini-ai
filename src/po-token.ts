/**
 * Optional Proof-of-Origin (PO) token provider for future YouTube timedtext/player gates.
 * Set YT_CAP_PO_TOKEN to a static token, or YT_CAP_PO_TOKEN_COMMAND to a shell that prints one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CONSTANTS } from './constants.js';

const { EMPTY_VALUE } = CONSTANTS.shared;
const execFileAsync = promisify(execFile);

// Provider that can supply a PO token for a given video / client context.
export type PoTokenProvider = {
  // Human label for logs.
  providerLabel: string;
  // Resolve a token or null when unavailable.
  resolvePoToken: (videoId: string) => Promise<string | null>;
};

const staticEnvProvider: PoTokenProvider = {
  providerLabel: 'env:YT_CAP_PO_TOKEN',
  resolvePoToken: async () => {
    const tokenValue = process.env.YT_CAP_PO_TOKEN?.trim() ?? EMPTY_VALUE;
    return tokenValue.length > 0 ? tokenValue : null;
  },
};

const commandEnvProvider: PoTokenProvider = {
  providerLabel: 'env:YT_CAP_PO_TOKEN_COMMAND',
  resolvePoToken: async () => {
    const commandLine = process.env.YT_CAP_PO_TOKEN_COMMAND?.trim() ?? EMPTY_VALUE;
    if (commandLine.length === 0) {
      return null;
    }
    try {
      const commandRun = await execFileAsync('sh', ['-c', commandLine], {
        timeout: 15_000,
        encoding: 'utf8',
        env: process.env,
      });
      const tokenValue = (commandRun.stdout ?? EMPTY_VALUE).trim();
      return tokenValue.length > 0 ? tokenValue : null;
    } catch {
      return null;
    }
  },
};

const defaultProviders: PoTokenProvider[] = [staticEnvProvider, commandEnvProvider];

export const resolveOptionalPoToken = async (videoId: string): Promise<string | null> => {
  // Walk registered providers; first non-null token wins.
  for (const tokenProvider of defaultProviders) {
    const tokenValue = await tokenProvider.resolvePoToken(videoId);
    if (tokenValue) {
      return tokenValue;
    }
  }
  return null;
};

// Attach poToken to an Innertube request body when present (no-op when null).
export const attachPoTokenToPlayerBody = (
  playerRequestBody: Record<string, unknown>,
  poToken: string | null,
): Record<string, unknown> => {
  if (!poToken) {
    return playerRequestBody;
  }
  return {
    ...playerRequestBody,
    serviceIntegrityDimensions: {
      poToken,
    },
  };
};
