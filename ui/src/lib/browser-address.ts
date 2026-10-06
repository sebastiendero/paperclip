export function resolveBrowserAddress(input: string): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;

  if (!/\s/.test(value)) {
    try {
      const candidate = new URL(`https://${value}`);
      if (candidate.hostname === "localhost" || candidate.hostname.includes(".")) {
        return `https://${value}`;
      }
    } catch { /* Search for text that is not a valid address. */ }
  }

  return `https://duckduckgo.com/?${new URLSearchParams({ q: value })}`;
}
