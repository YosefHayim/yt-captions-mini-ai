import { Duration, Effect, Option, Schema } from 'effect';
import { getSessionCookieHeader, rememberSetCookieHeaders } from './cookies.js';
import type { OptionalFetchBody } from './types.js';

import { CONSTANTS } from './constants.js';

const {
  BROWSER_USER_AGENT,
  YOUTUBE_ORIGIN_SLASH: DEFAULT_REFERRER_URL,
} = CONSTANTS.shared;
const {
  USER_AGENT_HEADER,
  ACCEPT_LANGUAGE_HEADER,
  ACCEPT_HEADER,
  CONTENT_TYPE_HEADER,
  REFERER_HEADER,
  COOKIE_HEADER,
  SET_COOKIE_HEADER,
  RETRY_AFTER_HEADER,
  COOKIE_HEADER_LOWER,
  ACCEPT_LANGUAGE,
  ACCEPT_ALL,
  CONTENT_TYPE_JSON,
  HTTP_METHOD_POST,
  HTTP_STATUS_SUCCESS_START,
  HTTP_STATUS_REDIRECT_START,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_GATEWAY_TIMEOUT,
  MAX_RETRY_ATTEMPTS,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
} = CONSTANTS.http;

// Plain header bag used for merges before fetch.
type HeaderDictionary = Record<string, string>;

// Transient HTTP failure that Effect retry may repeat.
class RetryableHttpStatusError {
  readonly _tag = 'RetryableHttpStatusError';
  // Request URL used for the failed attempt.
  readonly requestUrl: string;
  // Status that should be retried.
  readonly statusCode: number;
  // Optional server-provided retry delay in milliseconds.
  readonly retryAfterMs: number | null;

  constructor(requestUrl: string, statusCode: number, retryAfterMs: number | null) {
    this.requestUrl = requestUrl;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

// Final non-success HTTP status after retries are exhausted.
class HttpStatusError {
  readonly _tag = 'HttpStatusError';
  // Request URL that failed.
  readonly requestUrl: string;
  // Final HTTP status.
  readonly statusCode: number;

  constructor(requestUrl: string, statusCode: number) {
    this.requestUrl = requestUrl;
    this.statusCode = statusCode;
  }
}

const decodeUnknownJson = Schema.decodeUnknown(Schema.Unknown);

const canonicalizeHeaders = (headersInput: HeadersInit = {}): HeaderDictionary => {
  // Flatten HeadersInit into a plain object for merges.
  const requestHeaders = new Headers(headersInput);
  const mergedHeaders: HeaderDictionary = {};
  requestHeaders.forEach((headerValue, headerName) => {
    mergedHeaders[headerName] = headerValue;
  });
  return mergedHeaders;
};

const mergeDefaultHeaders = (headersInput: HeadersInit = {}): HeaderDictionary => {
  // 1) Start from browser-like defaults.
  const mergedHeaders: HeaderDictionary = {
    [USER_AGENT_HEADER]: BROWSER_USER_AGENT,
    [ACCEPT_LANGUAGE_HEADER]: ACCEPT_LANGUAGE,
    [ACCEPT_HEADER]: ACCEPT_ALL,
    [REFERER_HEADER]: DEFAULT_REFERRER_URL,
    ...canonicalizeHeaders(headersInput),
  };

  // 2) Attach session cookies unless the caller already set Cookie.
  const hasCallerCookie = Object.keys(mergedHeaders).some(
    (headerName) => headerName.toLowerCase() === COOKIE_HEADER_LOWER,
  );
  if (!hasCallerCookie) {
    const sessionCookieHeader = getSessionCookieHeader();
    if (sessionCookieHeader) {
      mergedHeaders[COOKIE_HEADER] = sessionCookieHeader;
    }
  }

  // 3) Return the final header bag for fetch.
  return mergedHeaders;
};

const isRetryableStatus = (statusCode: number): boolean => {
  // Retry only throttling and transient gateway failures.
  return (
    statusCode === HTTP_STATUS_TOO_MANY_REQUESTS
    || statusCode === HTTP_STATUS_BAD_GATEWAY
    || statusCode === HTTP_STATUS_SERVICE_UNAVAILABLE
    || statusCode === HTTP_STATUS_GATEWAY_TIMEOUT
  );
};

const isSuccessStatus = (statusCode: number): boolean => {
  return statusCode >= HTTP_STATUS_SUCCESS_START && statusCode < HTTP_STATUS_REDIRECT_START;
};

const readRetryAfterMilliseconds = (replyHeaders: Headers): number | null => {
  // 1) Honor Retry-After seconds when YouTube sends it.
  const retryAfterHeader = replyHeaders.get(RETRY_AFTER_HEADER);
  if (!retryAfterHeader) {
    return null;
  }
  // 2) Support integer-second form only (common for 429).
  const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return null;
  }
  return Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
};

const captureReplyCookies = (fetchReply: Response): void => {
  // 1) Prefer getSetCookie when available (Node 20+).
  const replyHeaders = fetchReply.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof replyHeaders.getSetCookie === 'function') {
    const setCookieHeaders = replyHeaders.getSetCookie();
    if (setCookieHeaders.length > 0) {
      rememberSetCookieHeaders(setCookieHeaders);
      return;
    }
  }
  // 2) Fallback to single Set-Cookie header when the runtime collapses them.
  const singleSetCookie = fetchReply.headers.get(SET_COOKIE_HEADER);
  if (singleSetCookie) {
    rememberSetCookieHeaders([singleSetCookie]);
  }
};

const computeBackoffDelay = (attemptIndex: number, retryAfterMs: number | null): Duration.Duration => {
  // Prefer Retry-After; else exponential backoff capped at MAX_RETRY_DELAY_MS.
  if (retryAfterMs !== null) {
    return Duration.millis(retryAfterMs);
  }
  const exponentialMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** attemptIndex, MAX_RETRY_DELAY_MS);
  return Duration.millis(exponentialMs);
};

const fetchWithRetryEffect = (
  targetUrl: string,
  requestOptions: RequestInit = {},
): Effect.Effect<Response, HttpStatusError | Error> => {
  // 1) Attempt fetch up to MAX_RETRY_ATTEMPTS with Effect sleep between retries.
  // 2) Fail terminal non-retryable statuses after capture.
  // 3) Map exhausted retryable failures to HttpStatusError.
  return Effect.gen(function* () {
    let lastRetryable: RetryableHttpStatusError | null = null;

    for (let attemptIndex = 0; attemptIndex < MAX_RETRY_ATTEMPTS; attemptIndex += 1) {
      const fetchReply = yield* Effect.tryPromise({
        try: () =>
          fetch(targetUrl, {
            ...requestOptions,
            headers: mergeDefaultHeaders(requestOptions.headers),
          }),
        catch: (fetchError) => (fetchError instanceof Error ? fetchError : new Error(String(fetchError))),
      });
      captureReplyCookies(fetchReply);

      if (!isRetryableStatus(fetchReply.status)) {
        return fetchReply;
      }

      lastRetryable = new RetryableHttpStatusError(
        targetUrl,
        fetchReply.status,
        readRetryAfterMilliseconds(fetchReply.headers),
      );

      if (attemptIndex >= MAX_RETRY_ATTEMPTS - 1) {
        break;
      }

      yield* Effect.sleep(computeBackoffDelay(attemptIndex, lastRetryable.retryAfterMs));
    }

    if (lastRetryable) {
      return yield* Effect.fail(new HttpStatusError(lastRetryable.requestUrl, lastRetryable.statusCode));
    }
    return yield* Effect.fail(new HttpStatusError(targetUrl, 0));
  });
};

const ensureSuccessReply = (targetUrl: string, fetchReply: Response): Effect.Effect<Response, HttpStatusError> => {
  // Reject non-2xx replies after retries are finished.
  if (!isSuccessStatus(fetchReply.status)) {
    return Effect.fail(new HttpStatusError(targetUrl, fetchReply.status));
  }
  return Effect.succeed(fetchReply);
};

const readReplyText = (fetchReply: Response): Effect.Effect<string, Error> => {
  return Effect.tryPromise({
    try: () => fetchReply.text(),
    catch: (readError) => (readError instanceof Error ? readError : new Error(String(readError))),
  });
};

const formatHttpError = (errorValue: unknown): Error => {
  // Keep CLI logs on the previous `HTTP <status> while fetching <url>` shape.
  if (errorValue instanceof HttpStatusError) {
    return new Error(`HTTP ${errorValue.statusCode} while fetching ${errorValue.requestUrl}`);
  }
  if (errorValue instanceof Error) {
    return errorValue;
  }
  return new Error(String(errorValue));
};

export const fetchTextResource = async (targetUrl: string, requestOptions: RequestInit = {}): Promise<string> => {
  // Merge defaults, retry throttle errors via Effect, return body text.
  const textEffect = fetchWithRetryEffect(targetUrl, requestOptions).pipe(
    Effect.flatMap((fetchReply) => ensureSuccessReply(targetUrl, fetchReply)),
    Effect.flatMap((fetchReply) => readReplyText(fetchReply)),
    Effect.mapError(formatHttpError),
  );
  return Effect.runPromise(textEffect);
};

export const fetchTextResourceOptional = async (
  targetUrl: string,
  requestOptions: RequestInit = {},
): Promise<OptionalFetchBody | null> => {
  // Soft-fetch for paths that can fall back to other clients after HTML 429s.
  const optionalEffect = fetchWithRetryEffect(targetUrl, requestOptions).pipe(
    Effect.flatMap((fetchReply) => {
      if (!isSuccessStatus(fetchReply.status)) {
        return Effect.succeed(Option.none<OptionalFetchBody>());
      }
      return readReplyText(fetchReply).pipe(
        Effect.map((bodyText) =>
          Option.some({
            bodyText,
            statusCode: fetchReply.status,
          }),
        ),
      );
    }),
    Effect.catchAll(() => Effect.succeed(Option.none<OptionalFetchBody>())),
  );
  const optionalBody = await Effect.runPromise(optionalEffect);
  return Option.getOrNull(optionalBody);
};

export const fetchJsonResource = async <TDecoded>(
  targetUrl: string,
  requestBody: Record<string, unknown>,
  requestOptions: RequestInit = {},
): Promise<TDecoded> => {
  // 1) POST JSON body with merged headers.
  const requestBodyJson = JSON.stringify(requestBody);
  const callerHeaders = canonicalizeHeaders(requestOptions.headers);
  const requestMethod = requestOptions.method === undefined ? HTTP_METHOD_POST : requestOptions.method;

  // 2) Decode body with Effect Schema instead of bare JSON.parse casts.
  const jsonEffect = Effect.gen(function* () {
    const replyBody = yield* Effect.tryPromise({
      try: () =>
        fetchTextResource(targetUrl, {
          ...requestOptions,
          method: requestMethod,
          body: requestBodyJson,
          headers: {
            ...callerHeaders,
            [CONTENT_TYPE_HEADER]: CONTENT_TYPE_JSON,
          },
        }),
      catch: (fetchError) => (fetchError instanceof Error ? fetchError : new Error(String(fetchError))),
    });
    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(replyBody) as unknown,
      catch: (parseError) => (parseError instanceof Error ? parseError : new Error(String(parseError))),
    });
    const decodedJson = yield* decodeUnknownJson(parsedJson);
    return decodedJson as TDecoded;
  });

  return Effect.runPromise(jsonEffect);
};
