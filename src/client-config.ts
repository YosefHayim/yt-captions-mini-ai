import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONSTANTS } from './constants.js';

const { FILE_ENCODING, EMPTY_VALUE } = CONSTANTS.shared;

// Optional override for one Innertube client profile.
export type ClientVersionOverride = {
  // client.clientVersion when set.
  clientVersion?: string;
  // User-Agent override when set.
  userAgent?: string;
};

// File shape for config/player-clients.json (and YT_CAP_CLIENT_CONFIG).
export type PlayerClientConfigFile = {
  // Schema version.
  version: number;
  // Preferred client attempt order.
  preferredOrder?: string[];
  // How many clients to race on cold miss.
  raceClientCount?: number;
  // Per-label version/UA overrides.
  clients?: Record<string, ClientVersionOverride>;
};

const bundledConfigPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'player-clients.json',
);

let cachedConfig: PlayerClientConfigFile | null = null;

export const loadPlayerClientConfig = async (): Promise<PlayerClientConfigFile> => {
  if (cachedConfig) {
    return cachedConfig;
  }
  const overridePath = process.env.YT_CAP_CLIENT_CONFIG?.trim() ?? EMPTY_VALUE;
  const configPath = overridePath.length > 0 ? overridePath : bundledConfigPath;
  try {
    const configBody = await readFile(configPath, FILE_ENCODING);
    cachedConfig = JSON.parse(configBody) as PlayerClientConfigFile;
  } catch {
    cachedConfig = {
      version: 1,
      preferredOrder: [...CONSTANTS.playerApi.PREFERRED_CLIENT_ORDER],
      raceClientCount: 2,
      clients: {},
    };
  }
  return cachedConfig;
};

export const getRaceClientCount = async (): Promise<number> => {
  const clientConfig = await loadPlayerClientConfig();
  const raceCount = clientConfig.raceClientCount ?? 2;
  return Math.max(1, Math.min(4, raceCount));
};

export const getPreferredClientOrder = async (): Promise<string[]> => {
  const clientConfig = await loadPlayerClientConfig();
  if (clientConfig.preferredOrder && clientConfig.preferredOrder.length > 0) {
    return clientConfig.preferredOrder;
  }
  return [...CONSTANTS.playerApi.PREFERRED_CLIENT_ORDER];
};

export const applyClientOverrides = <
  TProfile extends { profileLabel: string; clientVersion: string; userAgent: string },
>(
  clientProfiles: TProfile[],
  clientConfig: PlayerClientConfigFile,
): TProfile[] => {
  // Return shallow copies with version/UA overrides when configured.
  return clientProfiles.map((clientProfile) => {
    const versionOverride = clientConfig.clients?.[clientProfile.profileLabel];
    if (!versionOverride) {
      return clientProfile;
    }
    return {
      ...clientProfile,
      clientVersion: versionOverride.clientVersion ?? clientProfile.clientVersion,
      userAgent: versionOverride.userAgent ?? clientProfile.userAgent,
    };
  });
};
