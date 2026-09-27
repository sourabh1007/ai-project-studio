import { rightSideLines } from './diff-lines.js';
import type { ReviewFinding } from './types.js';

export interface FindingCommentAnchor {
  path: string;
  line: number;
  text: string;
  legacy: boolean;
}

/** Only reported coordinates qualify; never substitute the first changed line. */
export function findingCommentAnchors(
  finding: ReviewFinding,
  files: readonly { path: string; diff: string | null }[],
): FindingCommentAnchor[] {
  const anchors = new Map<string, FindingCommentAnchor>();
  const locations = finding.evidence.flatMap((e) => e.location ? [e.location] : []);
  const add = (path: string, line: number, legacy: boolean) => {
    if (!Number.isSafeInteger(line) || line < 1) return;
    const normalized = path.replace(/\\/g, '/');
    const paths = [...new Set(files.map((f) => f.path))];
    // Older agents sometimes used a basename. Accept it only if unique across
    // the captured graph, not merely unique among files with an available diff.
    const matches = paths.filter((p) => p === normalized ||
      (legacy && !normalized.includes('/') && p.split('/').pop() === normalized));
    if (matches.length !== 1) return;
    const exactPath = matches[0];
    for (const file of files) {
      if (file.path !== exactPath || !file.diff) continue;
      const sourceLine = rightSideLines(file.diff).find((l) => l.line === line);
      if (sourceLine) {
        anchors.set(`${exactPath}:${line}`, { path: exactPath, line, text: sourceLine.text, legacy });
        return;
      }
    }
  };
  if (locations.length) {
    for (const location of locations) {
      if (location.side === 'RIGHT') add(location.path, location.line, false);
    }
  } else {
    const prose = [finding.title, finding.detail,
      ...finding.evidence.flatMap((e) => [e.source, e.reason])].join('\n');
    for (const match of prose.matchAll(/(?:^|[\s`('"[])((?:[\w.-]+[\\/])*[\w.-]+\.[\w]+):(\d+)(?![\d:])/g)) {
      add(match[1], Number(match[2]), true);
    }
  }
  return [...anchors.values()];
}
