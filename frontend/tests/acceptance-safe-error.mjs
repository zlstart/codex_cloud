// Evidence must never retain Playwright's authenticated request headers.
export function safeError(error) {
  return String(error?.message ?? error)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\b(cookie|authorization|x-api-key|api-key):[^\r\n]*/gi,
      "$1: [redacted]",
    )
    .replace(/famsun_session=[A-Za-z0-9_-]+/g, "famsun_session=[redacted]");
}
