import { Effect, Console } from 'effect';
const LOG_SEVERITY_INFO = 'info';
const LOG_SEVERITY_WARN = 'warn';
const LOG_SEVERITY_ERROR = 'error';
const LOG_SEVERITY_PREFIX = '[';
const LOG_SEVERITY_SUFFIX = '] ';
const logMessage = (severity, message) => {
    const withSeverity = `${LOG_SEVERITY_PREFIX}${severity.toUpperCase()}${LOG_SEVERITY_SUFFIX}${message}`;
    Effect.runSync(Console.log(withSeverity));
};
export const logInfo = (message) => logMessage(LOG_SEVERITY_INFO, message);
export const logWarn = (message) => logMessage(LOG_SEVERITY_WARN, message);
export const logError = (message) => logMessage(LOG_SEVERITY_ERROR, message);
