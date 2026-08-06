import { CONSTANTS } from './constants.js';

const {
  OPEN_BRACE: JSON_OPEN_DELIMITER,
  OPEN_BRACE_CODE: JSON_OPEN_CODE,
  CLOSE_BRACE_CODE: JSON_CLOSE_CODE,
  ESCAPE_CHARACTER_CODE: BACKSLASH_CODE,
  DOUBLE_QUOTE_CODE,
  JSON_PARSE_ERROR_PREFIX,
  JSON_INCOMPLETE_ERROR_PREFIX,
  BRACE_DEPTH_COMPLETE,
} = CONSTANTS.shared;

export const extractEmbeddedJson = (
  pageHtml: string,
  marker: string,
): Record<string, unknown> | null => {
  const markerOffset = pageHtml.indexOf(marker);
  if (markerOffset === -1) {
    return null;
  }

  const openingIndex = pageHtml.indexOf(JSON_OPEN_DELIMITER, markerOffset + marker.length);
  if (openingIndex === -1) {
    return null;
  }

  let braceDepth = 0;
  let insideString = false;
  let escapingCharacter = false;

  for (let cursor = openingIndex; cursor < pageHtml.length; cursor += 1) {
    const currentCharacter = pageHtml.charCodeAt(cursor);

    if (escapingCharacter) {
      escapingCharacter = false;
      continue;
    }

    if (insideString) {
      if (currentCharacter === BACKSLASH_CODE) {
        escapingCharacter = true;
      } else if (currentCharacter === DOUBLE_QUOTE_CODE) {
        insideString = false;
      }
      continue;
    }

    if (currentCharacter === DOUBLE_QUOTE_CODE) {
      insideString = true;
      continue;
    }

    if (currentCharacter === JSON_OPEN_CODE) {
      braceDepth += 1;
      continue;
    }

    if (currentCharacter === JSON_CLOSE_CODE) {
      braceDepth -= 1;
      if (braceDepth === BRACE_DEPTH_COMPLETE) {
        const embeddedJsonText = pageHtml.slice(openingIndex, cursor + 1);
        try {
          return JSON.parse(embeddedJsonText) as Record<string, unknown>;
        } catch (parseError) {
          throw new Error(
            `${JSON_PARSE_ERROR_PREFIX} ${marker} JSON: ${String(parseError)}`,
          );
        }
      }
    }
  }

  throw new Error(`${JSON_INCOMPLETE_ERROR_PREFIX} ${marker} payload`);
};
