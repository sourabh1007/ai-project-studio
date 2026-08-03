/**
 * Minimal, dependency-free parser for the leading YAML-style frontmatter block
 * used by markdown skill/agent definitions. Only flat `key: value` scalars are
 * supported (enough for name/description/author); nested structures are ignored.
 */

/** Parsed frontmatter fields plus the body that follows the closing fence. */
export interface ParsedDefinition {
  frontmatter: Record<string, string>;
  body: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed.endsWith(trimmed[0])
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Splits a definition into its frontmatter map and trailing body. */
export function parseDefinition(content: string): ParsedDefinition {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: normalized };
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (closingIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key.length === 0) {
      continue;
    }
    frontmatter[key] = stripQuotes(line.slice(separator + 1));
  }
  return { frontmatter, body: lines.slice(closingIndex + 1).join('\n') };
}

/** Non-empty frontmatter value for `key`, or null. */
export function frontmatterValue(
  frontmatter: Record<string, string>,
  key: string,
): string | null {
  const value = frontmatter[key];
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

/** First non-empty body line, with a leading markdown heading marker stripped. */
export function firstMeaningfulLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/^#+\s*/, '').trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

/** Strips the configured extension from a file's base name for a display name. */
export function deriveName(filePath: string, extension: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  return base.toLowerCase().endsWith(extension.toLowerCase())
    ? base.slice(0, base.length - extension.length)
    : base;
}

/** Truncates to `maxChars`, appending an ellipsis when shortened. */
export function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}
