// Map a caught error into a human-readable, localized message. Backend service
// errors marshal to { code, detail }; we localize the code when we have a
// translation for it, else fall back to the detail or the raw message.
//
// Wails wrapping: a service that returns an *AppError ends up in the frontend
// as a `RuntimeError` whose `cause` is the marshalled `{ code, detail }`. So
// we look for a code on `e` itself OR on `e.cause` before giving up.

import i18n from "../i18n";

interface CodedError {
  code: string;
  detail?: string;
}

function pickCoded(e: unknown): CodedError | null {
  if (typeof e !== "object" || e === null) return null;
  const top = e as { code?: unknown; detail?: unknown; cause?: unknown };
  if (typeof top.code === "string") {
    return { code: top.code, detail: typeof top.detail === "string" ? top.detail : undefined };
  }
  if (top.cause && typeof top.cause === "object") {
    const c = top.cause as { code?: unknown; detail?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, detail: typeof c.detail === "string" ? c.detail : undefined };
    }
  }
  return null;
}

// Detail strings produced by the backend (`internal/ingestion/fetch.go`) for
// network errors look like "HTTP 403 at example.com". Pull host out so we can
// drop it into i18n templates as `{host}` without forcing the user to read a
// status code.
function parseNetworkDetail(detail: string | undefined): { host?: string; status?: string } {
  if (!detail) return {};
  const m = /^HTTP\s+(\d+)\s+at\s+(.+)$/.exec(detail.trim());
  if (m) return { status: m[1], host: m[2] };
  return {};
}

/** A localized message for a caught error. */
export function errorText(e: unknown): string {
  const coded = pickCoded(e);
  if (coded) {
    const key = `error.${coded.code}`;
    // Provide both `{detail}` and the parsed `{host}` / `{status}` fields so
    // any template can pick what it needs without breaking older keys.
    const params: Record<string, string> = {
      detail: coded.detail ?? "",
      ...parseNetworkDetail(coded.detail),
    };
    const translated = i18n.global.t(key, params);
    if (translated !== key) return translated;
    return coded.detail && coded.detail.trim() !== "" ? coded.detail : coded.code;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return i18n.global.t("error.unknown");
}
