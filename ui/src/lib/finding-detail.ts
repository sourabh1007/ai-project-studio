/** The labelled sections a review finding's free-text detail may contain. */
export const DETAIL_LABELS = [
  'Problem',
  'Where',
  'Impact',
  'Risk',
  'Why',
  'Fix/verify',
  'Fix',
  'Verify',
  'Recommendation',
  'Evidence',
];

/** One block of a finding detail: a labelled (or lead-in unlabelled) body. */
export interface DetailSection {
  label: string | null;
  body: string;
}

/**
 * Split a finding's free-text detail into its labelled sections ("Problem:",
 * "Where:", "Fix/verify:", …) so we can render each as its own block instead of
 * one dense wall of text. Text before the first label becomes an unlabelled lead.
 *
 * `text` is trimmed and non-empty by the time we build the trailing section, and
 * a label only matches when followed by `:\s+` and real content, so the tail
 * after the last label is always non-empty — it also absorbs the no-label case
 * (the whole text becomes one unlabelled section).
 */
export function parseFindingDetail(detail: string): DetailSection[] {
  const text = detail.trim();
  if (!text) return [];
  const alt = DETAIL_LABELS.map((l) => l.replace('/', '\\/')).join('|');
  const re = new RegExp(`(?:^|[\\s.;])(${alt}):\\s+`, 'g');
  const sections: DetailSection[] = [];
  let lastIndex = 0;
  let lastLabel: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(lastIndex, m.index).trim();
    if (chunk) sections.push({ label: lastLabel, body: chunk });
    lastLabel = m[1];
    lastIndex = re.lastIndex;
  }
  sections.push({ label: lastLabel, body: text.slice(lastIndex).trim() });
  return sections;
}
