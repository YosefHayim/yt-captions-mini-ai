import { Effect, Console } from 'effect';

import { CONSTANTS } from './constants.js';

const {
  LOG_TAG_INFO,
  LOG_TAG_WARN,
  LOG_TAG_ERR,
  LOG_TAG_PREFIX,
  LOG_TAG_SUFFIX,
} = CONSTANTS.log;

// One-line CLI log tags matching CODE-STYLE.md.
type LogTag = typeof LOG_TAG_INFO | typeof LOG_TAG_WARN | typeof LOG_TAG_ERR;

const writeLogLine = (logTag: LogTag, message: string): void => {
  // Emit a single tagged line to stdout via Effect Console.
  const taggedLine = `${LOG_TAG_PREFIX}${logTag}${LOG_TAG_SUFFIX}${message}`;
  Effect.runSync(Console.log(taggedLine));
};

export const logInfo = (message: string): void => {
  // Informational progress for normal CLI flow.
  writeLogLine(LOG_TAG_INFO, message);
};

export const logWarn = (message: string): void => {
  // Non-fatal issues where the run can continue.
  writeLogLine(LOG_TAG_WARN, message);
};

export const logError = (message: string): void => {
  // Fatal or terminal failures surfaced to the operator.
  writeLogLine(LOG_TAG_ERR, message);
};
