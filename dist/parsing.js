const JSON_OPEN_DELIMITER = '{';
const JSON_CLOSE_DELIMITER = '}';
const JSON_OPEN_CODE = JSON_OPEN_DELIMITER.charCodeAt(0);
const JSON_CLOSE_CODE = JSON_CLOSE_DELIMITER.charCodeAt(0);
const BACKSLASH_CODE = '\\'.charCodeAt(0);
const DOUBLE_QUOTE_CODE = '"'.charCodeAt(0);
const JSON_PARSE_ERROR_TEXT = 'Could not parse';
const JSON_PARSE_COMPLETE_ERROR_TEXT = 'Could not parse complete';
const EMPTY_EMBEDDED_JSON = null;
const CHAR_ARRAY_NOT_EMPTY = 0;
export const extractEmbeddedJson = (htmlSource, marker) => {
    // Find marker and opening brace positions. Walk through characters with brace depth, string, and escape handling. Parse and return the first complete top-level JSON object.
    const markerOffset = htmlSource.indexOf(marker);
    if (markerOffset === -1)
        return EMPTY_EMBEDDED_JSON;
    let openingIndex = htmlSource.indexOf(JSON_OPEN_DELIMITER, markerOffset + marker.length);
    if (openingIndex === -1)
        return EMPTY_EMBEDDED_JSON;
    let braceDepth = 0;
    let insideString = false;
    let escapingCharacter = false;
    for (let cursor = openingIndex; cursor < htmlSource.length; cursor++) {
        const currentCharacter = htmlSource.charCodeAt(cursor);
        if (escapingCharacter) {
            escapingCharacter = false;
            continue;
        }
        if (insideString) {
            if (currentCharacter === BACKSLASH_CODE) {
                escapingCharacter = true;
            }
            else if (currentCharacter === DOUBLE_QUOTE_CODE) {
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
            if (braceDepth === CHAR_ARRAY_NOT_EMPTY) {
                const serializedMarker = htmlSource.slice(openingIndex, cursor + 1);
                try {
                    return JSON.parse(serializedMarker);
                }
                catch (decodeError) {
                    throw new Error(`${JSON_PARSE_ERROR_TEXT} ${marker} JSON payload: ${String(decodeError)}`);
                }
            }
        }
    }
    throw new Error(`${JSON_PARSE_COMPLETE_ERROR_TEXT} ${marker} payload`);
};
