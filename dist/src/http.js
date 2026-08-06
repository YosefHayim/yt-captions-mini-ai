const USER_AGENT_HEADER = 'User-Agent';
const ACCEPT_LANGUAGE_HEADER = 'Accept-Language';
const ACCEPT_HEADER = 'Accept';
const CONTENT_TYPE_HEADER = 'Content-Type';
const REFERER_HEADER = 'Referer';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.8';
const ACCEPT_ALL = '*/*';
const DEFAULT_REFERRER_URL = 'https://www.youtube.com/';
const CONTENT_TYPE_JSON = 'application/json';
const HTTP_STATUS_SUCCESS_START = 200;
const HTTP_STATUS_REDIRECT_START = 300;
const normalizeHeaders = (headersInput = {}) => {
    const requestHeaders = new Headers(headersInput);
    const mergedHeaders = {};
    requestHeaders.forEach((headerValue, headerName) => {
        mergedHeaders[headerName] = headerValue;
    });
    return mergedHeaders;
};
const buildHeaders = (headersInput = {}) => {
    // 1) Start from browser-like defaults.
    // 2) Merge user-provided headers so callers can override defaults.
    // 3) Keep plain-object headers for simple spread and reuse.
    return {
        [USER_AGENT_HEADER]: BROWSER_USER_AGENT,
        [ACCEPT_LANGUAGE_HEADER]: ACCEPT_LANGUAGE,
        [ACCEPT_HEADER]: ACCEPT_ALL,
        [REFERER_HEADER]: DEFAULT_REFERRER_URL,
        ...normalizeHeaders(headersInput),
    };
};
const ensureSuccessResponse = (responseUrl, responseStatus) => {
    // 1) Reject 1xx/3xx+ responses to keep callers safe.
    // 2) Preserve existing status-focused errors used by CLI logs.
    // 3) Keep one error format for all request types.
    if (responseStatus < HTTP_STATUS_SUCCESS_START || responseStatus >= HTTP_STATUS_REDIRECT_START) {
        throw new Error(`HTTP ${responseStatus} while fetching ${responseUrl}`);
    }
};
export const fetchTextResource = async (targetUrl, requestOptions = {}) => {
    // 1) Merge caller options with browser-like defaults.
    // 2) Throw on non-success responses.
    // 3) Return full text body to caller.
    const response = await fetch(targetUrl, {
        ...requestOptions,
        headers: buildHeaders(requestOptions.headers),
    });
    ensureSuccessResponse(targetUrl, response.status);
    return response.text();
};
export const fetchJsonResource = async (targetUrl, requestBody, requestOptions = {}) => {
    // 1) Convert request payload into compact JSON text.
    // 2) POST with merged headers and parse JSON response.
    // 3) Keep decoding as a typed unknown result for caller narrowing.
    const payloadText = JSON.stringify(requestBody);
    const responseText = await fetchTextResource(targetUrl, {
        method: requestOptions.method ?? 'POST',
        body: payloadText,
        ...requestOptions,
        headers: {
            ...normalizeHeaders(requestOptions.headers),
            [CONTENT_TYPE_HEADER]: CONTENT_TYPE_JSON,
        },
    });
    return JSON.parse(responseText);
};
