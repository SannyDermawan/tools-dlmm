/**
 * Strip secrets from URLs before they reach logs: query values (api-key=...) and long
 * path tokens (e.g. https://host/<key>) are replaced.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
    u.pathname = u.pathname
      .split("/")
      .map((seg) => (seg.length >= 16 ? "***" : seg))
      .join("/");
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

/** Remove any occurrence of the given secret strings from a message. */
export function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("***");
  return out;
}
