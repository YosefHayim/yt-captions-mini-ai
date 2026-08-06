import { readFile } from 'node:fs/promises';
import { Effect, Either, Schema } from 'effect';

import { CONSTANTS } from './constants.js';

const {
  EMPTY_VALUE,
  FILE_ENCODING: COOKIE_FILE_ENCODING,
  NEWLINE: COOKIE_LINE_SEPARATOR,
  KEY_VALUE_SEPARATOR: COOKIE_NAME_VALUE_SEPARATOR,
  YOUTUBE_HOST_MARK,
  GOOGLE_HOST_MARK,
  YOUTUBE_COOKIE_DOMAIN: DEFAULT_YOUTUBE_COOKIE_DOMAIN,
} = CONSTANTS.shared;
const {
  COOKIE_FIELD_SEPARATOR,
  COOKIE_PAIR_SEPARATOR,
  COOKIE_COMMENT_PREFIX,
  COOKIE_HTTPONLY_PREFIX,
  DOMAIN_ATTRIBUTE_NAME,
  MIN_NETSCAPE_FIELD_COUNT,
  NETSCAPE_DOMAIN_INDEX,
  NETSCAPE_NAME_INDEX,
  NETSCAPE_VALUE_INDEX,
  SET_COOKIE_NAME_VALUE_INDEX,
} = CONSTANTS.cookies;

// One cookie accepted for YouTube/Google requests.
type SessionCookie = {
  // Cookie domain from Netscape file or Set-Cookie.
  cookieDomain: string;
  // Cookie name.
  cookieName: string;
  // Cookie value.
  cookieValue: string;
};

const sessionCookies = new Map<string, SessionCookie>();

// Netscape row fields we care about after tab-splitting.
const netscapeCookieRowSchema = Schema.Struct({
  // Cookie domain column.
  cookieDomain: Schema.String.pipe(Schema.minLength(1)),
  // Cookie name column.
  cookieName: Schema.String.pipe(Schema.minLength(1)),
  // Cookie value column.
  cookieValue: Schema.String,
});

const decodeNetscapeCookieRow = Schema.decodeUnknown(netscapeCookieRowSchema);

const cookieIdentity = (cookieDomain: string, cookieName: string): string => {
  // Keep map keys stable across domain casing differences.
  return `${cookieDomain.toLowerCase()}${COOKIE_NAME_VALUE_SEPARATOR}${cookieName}`;
};

const isYoutubeRelatedDomain = (cookieDomain: string): boolean => {
  // Accept youtube and google cookie domains used by Innertube.
  const loweredDomain = cookieDomain.toLowerCase().replace(/^\./, EMPTY_VALUE);
  return loweredDomain.endsWith(YOUTUBE_HOST_MARK) || loweredDomain.endsWith(GOOGLE_HOST_MARK);
};

const upsertSessionCookie = (cookieDomain: string, cookieName: string, cookieValue: string): void => {
  // 1) Ignore empty names.
  if (!cookieName.trim().length) {
    return;
  }
  // 2) Keep only YouTube-related cookies for this mini tool.
  if (!isYoutubeRelatedDomain(cookieDomain)) {
    return;
  }
  // 3) Overwrite older values for the same domain+name pair.
  sessionCookies.set(cookieIdentity(cookieDomain, cookieName), {
    cookieDomain,
    cookieName,
    cookieValue,
  });
};

const parseNetscapeCookieLine = (rawLine: string): void => {
  // 1) Skip blanks and plain comments (but keep #HttpOnly_ rows).
  const trimmedLine = rawLine.trim();
  if (!trimmedLine.length) {
    return;
  }
  let cookieLine = trimmedLine;
  if (cookieLine.startsWith(COOKIE_HTTPONLY_PREFIX)) {
    cookieLine = cookieLine.slice(COOKIE_HTTPONLY_PREFIX.length);
  } else if (cookieLine.startsWith(COOKIE_COMMENT_PREFIX)) {
    return;
  }

  // 2) Netscape format: domain, flag, path, secure, expiry, name, value.
  const cookieFields = cookieLine.split(COOKIE_FIELD_SEPARATOR);
  if (cookieFields.length < MIN_NETSCAPE_FIELD_COUNT) {
    return;
  }

  // 3) Validate domain/name/value with Effect Schema before storing.
  const domainField = cookieFields[NETSCAPE_DOMAIN_INDEX];
  const nameField = cookieFields[NETSCAPE_NAME_INDEX];
  if (domainField === undefined || nameField === undefined) {
    return;
  }
  const candidateRow = {
    cookieDomain: domainField.trim(),
    cookieName: nameField.trim(),
    cookieValue: cookieFields.slice(NETSCAPE_VALUE_INDEX).join(COOKIE_FIELD_SEPARATOR).trim(),
  };
  const decodedEither = Effect.runSync(Effect.either(decodeNetscapeCookieRow(candidateRow)));
  if (Either.isLeft(decodedEither)) {
    return;
  }
  const cookieRow = decodedEither.right;
  upsertSessionCookie(cookieRow.cookieDomain, cookieRow.cookieName, cookieRow.cookieValue);
};

export const loadNetscapeCookieFile = async (cookieFilePath: string): Promise<number> => {
  // 1) Read the Netscape cookie file body with Effect.tryPromise.
  const cookieFileBody = await Effect.runPromise(
    Effect.tryPromise({
      try: () => readFile(cookieFilePath, COOKIE_FILE_ENCODING),
      catch: (readError) => (readError instanceof Error ? readError : new Error(String(readError))),
    }),
  );
  // 2) Parse each line into the process cookie jar.
  const cookieLines = cookieFileBody.replace(/\r\n/g, COOKIE_LINE_SEPARATOR).split(COOKIE_LINE_SEPARATOR);
  let loadedCookieCount = 0;
  for (const cookieLine of cookieLines) {
    const beforeCount = sessionCookies.size;
    parseNetscapeCookieLine(cookieLine);
    if (sessionCookies.size > beforeCount) {
      loadedCookieCount += 1;
    }
  }
  // 3) Return how many YouTube-related cookies were accepted.
  return loadedCookieCount;
};

export const rememberSetCookieHeaders = (setCookieHeaders: string[]): void => {
  // 1) Walk each Set-Cookie header returned by YouTube.
  for (const setCookieHeader of setCookieHeaders) {
    // 2) Keep only the first name=value segment.
    const headerSegments = setCookieHeader.split(';');
    const nameValueSegment = headerSegments[SET_COOKIE_NAME_VALUE_INDEX];
    if (nameValueSegment === undefined) {
      continue;
    }
    const firstPair = nameValueSegment.trim();
    const separatorOffset = firstPair.indexOf(COOKIE_NAME_VALUE_SEPARATOR);
    if (separatorOffset <= 0) {
      continue;
    }
    const cookieName = firstPair.slice(0, separatorOffset).trim();
    const cookieValue = firstPair.slice(separatorOffset + 1).trim();

    // 3) Prefer Domain= attribute when present; default to .youtube.com.
    let cookieDomain: string = DEFAULT_YOUTUBE_COOKIE_DOMAIN;
    const attributeParts = headerSegments.slice(1);
    for (const attributePart of attributeParts) {
      const attributeBody = attributePart.trim();
      const attributeSeparator = attributeBody.indexOf(COOKIE_NAME_VALUE_SEPARATOR);
      if (attributeSeparator <= 0) {
        continue;
      }
      const attributeName = attributeBody.slice(0, attributeSeparator).trim().toLowerCase();
      const attributeValue = attributeBody.slice(attributeSeparator + 1).trim();
      if (attributeName === DOMAIN_ATTRIBUTE_NAME && attributeValue.length > 0) {
        cookieDomain = attributeValue;
      }
    }
    upsertSessionCookie(cookieDomain, cookieName, cookieValue);
  }
};

export const getSessionCookieHeader = (): string | null => {
  // 1) Build a Cookie request header from the jar.
  // 2) Return null when nothing is loaded so callers omit the header.
  if (sessionCookies.size === 0) {
    return null;
  }
  const cookiePairs: string[] = [];
  for (const sessionCookie of sessionCookies.values()) {
    cookiePairs.push(`${sessionCookie.cookieName}${COOKIE_NAME_VALUE_SEPARATOR}${sessionCookie.cookieValue}`);
  }
  return cookiePairs.join(COOKIE_PAIR_SEPARATOR);
};

export const clearSessionCookies = (): void => {
  // Reset jar between isolated runs or tests.
  sessionCookies.clear();
};
