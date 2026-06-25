import { APP_EVENTS } from "../app/appEvents";

export const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
export const AUTH_EMAIL_STORAGE_KEY = "denmark.authEmail";

const LOCAL_API_ORIGINS = new Set([
  "http://localhost:5000",
  "http://127.0.0.1:5000",
]);

export function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function isBackendUnavailableError(err: unknown) {
  if (err instanceof TypeError) return true;

  const message = err instanceof Error ? err.message : String(err || "");
  return (
    /failed to fetch/i.test(message) ||
    /networkerror/i.test(message) ||
    /request failed:\s*50[234]/i.test(message) ||
    /http\s*50[234]/i.test(message) ||
    /\b50[234]\b/.test(message)
  );
}

export function isBackendAvailabilityStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

export function getFetchUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function isApiFetch(input: RequestInfo | URL) {
  const url = getFetchUrl(input);
  return (
    (API_BASE ? url.startsWith(API_BASE) : false) ||
    url.startsWith("/api/") ||
    url === "/api" ||
    url.startsWith("/__whoami")
  );
}

export function buildLoginUrl() {
  if (typeof window === "undefined") return "/api/login";

  const email = window.localStorage.getItem(AUTH_EMAIL_STORAGE_KEY);
  if (!email) return "/api/login";

  const params = new URLSearchParams({ login_hint: email });
  return `/api/login?${params.toString()}`;
}

export function rewriteDevApiRequest(input: RequestInfo | URL) {
  if (typeof window === "undefined") return input;

  if (typeof input !== "string" && !(input instanceof URL)) {
    return input;
  }

  const rawUrl = typeof input === "string" ? input : input.toString();
  if (!rawUrl) return input;

  try {
    const parsed = new URL(rawUrl, window.location.origin);
    const isLegacyLocalApi = LOCAL_API_ORIGINS.has(parsed.origin);
    const sameOriginFrontend = parsed.origin === window.location.origin;

    if (!isLegacyLocalApi || sameOriginFrontend) {
      return input;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return input;
  }
}

export async function timedStartupFetch(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutMs = 20000;
  const timeout = window.setTimeout(() => {
    controller.abort(new Error(`${label} request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let response: Response;

  try {
    response = await fetch(input, {
      ...init,
      signal: init?.signal || controller.signal,
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    console.warn(`[startup] ${label} failed after ${durationMs}ms`, err);
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }

  const durationMs = Math.round(performance.now() - startedAt);
  let shouldLog = durationMs >= 1000;

  try {
    shouldLog =
      shouldLog ||
      window.localStorage?.getItem("denmark.debugStartupTiming") === "1";
  } catch {
    // Local storage can be unavailable in locked-down browser contexts.
  }

  if (shouldLog) {
    const serverTiming = response.headers.get("Server-Timing");
    console.info(
      `[startup] ${label} ${durationMs}ms${
        serverTiming ? ` | server: ${serverTiming}` : ""
      }`
    );
  }

  return response;
}

export function emitApiFetchEvents(response: Response) {
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.authRequired));
  }

  if (isBackendAvailabilityStatus(response.status)) {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.backendUnavailable));
  }
}
