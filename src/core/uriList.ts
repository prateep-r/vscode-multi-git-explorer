/** The URIs in a `text/uri-list` (RFC 2483): one per line, with `#` lines as comments. */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
}
