import { describe, expect, it } from 'vitest';
import {
  capPerspectiveFindings,
  parseAiFindings,
  parsePerspectiveAnalysis,
} from './review-board-parser.js';
import type { ReviewFinding } from './review-board-contract.js';

const IDS = ['security', 'testing'];

describe('parseAiFindings', () => {
  it('parses a fenced JSON array of findings', () => {
    const text = `sure:\n\`\`\`json
[
  {"perspectiveId":"security","title":"XSS","detail":"unescaped output","severity":"high","evidence":[{"source":"a.ts","reason":"renders raw html","confidence":0.9}]}
]
\`\`\``;
    const findings = parseAiFindings(text, IDS);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'security/ai-0',
      perspectiveId: 'security',
      title: 'XSS',
      severity: 'high',
      status: 'blocked',
    });
    expect(findings[0].evidence[0].direct).toBe(false);
  });

  it('parses an un-fenced array embedded in prose', () => {
    const text =
      'Findings: [{"perspectiveId":"testing","title":"No tests","detail":"add tests","severity":"medium","evidence":[{"source":"x","reason":"y"}]}] done';
    const findings = parseAiFindings(text, IDS);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('warning');
    expect(findings[0].evidence[0].confidence).toBe(0.6);
  });

  it('drops findings for unknown perspectives', () => {
    const text =
      '```json\n[{"perspectiveId":"ghost","title":"t","detail":"d","severity":"low","evidence":[{"source":"s","reason":"r"}]}]\n```';
    expect(parseAiFindings(text, IDS)).toHaveLength(0);
  });

  it('drops findings missing title/detail or evidence', () => {
    const text = `\`\`\`json
[
  {"perspectiveId":"security","title":"","detail":"d","severity":"low","evidence":[{"source":"s","reason":"r"}]},
  {"perspectiveId":"security","title":"t","detail":"d","severity":"low","evidence":[]},
  {"perspectiveId":"security","title":"t","detail":"d","severity":"low"},
  {"perspectiveId":"security","title":"t","detail":"d","severity":"low","evidence":[{"source":"","reason":"r"}]}
]
\`\`\``;
    expect(parseAiFindings(text, IDS)).toHaveLength(0);
  });

  it('defaults an unknown severity to medium', () => {
    const text =
      '```json\n[{"perspectiveId":"security","title":"t","detail":"d","severity":"weird","evidence":[{"source":"s","reason":"r"}]}]\n```';
    expect(parseAiFindings(text, IDS)[0].severity).toBe('medium');
  });

  it('clamps out-of-range and non-numeric confidences', () => {
    const text = `\`\`\`json
[
  {"perspectiveId":"security","title":"a","detail":"d","severity":"low","evidence":[{"source":"s","reason":"r","confidence":5}]},
  {"perspectiveId":"security","title":"b","detail":"d","severity":"low","evidence":[{"source":"s","reason":"r","confidence":-2}]},
  {"perspectiveId":"testing","title":"c","detail":"d","severity":"low","evidence":[{"source":"s","reason":"r","confidence":"x"}]}
]
\`\`\``;
    const findings = parseAiFindings(text, IDS);
    expect(findings[0].evidence[0].confidence).toBe(1);
    expect(findings[1].evidence[0].confidence).toBe(0);
    expect(findings[2].evidence[0].confidence).toBe(0.6);
  });

  it('skips non-object entries and non-object evidence', () => {
    const text = `\`\`\`json
[
  42,
  {"perspectiveId":"security","title":"t","detail":"d","severity":"low","evidence":[7,{"source":"s","reason":"r"}]}
]
\`\`\``;
    const findings = parseAiFindings(text, IDS);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toHaveLength(1);
  });

  it('returns [] when no array is present', () => {
    expect(parseAiFindings('no json here', IDS)).toEqual([]);
    expect(parseAiFindings('```json\n{"not":"array"}\n```', IDS)).toEqual([]);
  });

  it('returns [] on invalid JSON', () => {
    expect(parseAiFindings('```json\n[not valid]\n```', IDS)).toEqual([]);
  });

  it('handles a reversed bracket order', () => {
    expect(parseAiFindings('] weird [', IDS)).toEqual([]);
  });
});

describe('parsePerspectiveAnalysis', () => {
  it('parses a fenced object of findings', () => {
    const text = `\`\`\`json
{"skipped": false, "summary": "Checked auth.ts renderProfile for escaping.",
 "rationale": [{"label":"Problem","detail":"XSS risk in auth.ts"},{"label":"Verdict","detail":"escaped, so safe"}],
 "checks": [{"item":"auth.ts — renderProfile","finding":"escapes output","status":"pass"}],
 "findings": [
  {"title":"XSS","detail":"unescaped","severity":"high","evidence":[{"source":"a.ts","reason":"raw html","confidence":0.9}]}
]}
\`\`\``;
    const result = parsePerspectiveAnalysis(text, 'security');
    expect(result.skipped).toBe(false);
    expect(result.skipReason).toBeNull();
    expect(result.summary).toBe('Checked auth.ts renderProfile for escaping.');
    expect(result.rationale).toEqual([
      { label: 'Problem', detail: 'XSS risk in auth.ts' },
      { label: 'Verdict', detail: 'escaped, so safe' },
    ]);
    expect(result.checks).toEqual([
      { item: 'auth.ts — renderProfile', finding: 'escapes output', status: 'pass' },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: 'security/ai-0',
      perspectiveId: 'security',
      status: 'blocked',
    });
  });

  it('validates rationale: drops malformed points and a non-array field', () => {
    const text = `\`\`\`json
{"skipped": false, "rationale": [
  99,
  {"label":"","detail":"blank label"},
  {"label":"Problem","detail":""},
  {"label":"Solution implemented","detail":"moved cfg to svc.cs"}
], "findings": []}
\`\`\``;
    expect(parsePerspectiveAnalysis(text, 'security').rationale).toEqual([
      { label: 'Solution implemented', detail: 'moved cfg to svc.cs' },
    ]);
    const notArray =
      '```json\n{"skipped": false, "rationale": "nope", "findings": []}\n```';
    expect(parsePerspectiveAnalysis(notArray, 'security').rationale).toEqual([]);
  });

  it('validates checks: drops malformed entries and defaults an unknown status', () => {
    const text = `\`\`\`json
{"skipped": false, "checks": [
  42,
  {"item":"","finding":"blank item","status":"pass"},
  {"item":"a.ts","finding":"","status":"pass"},
  {"item":"svc.cs — Handle","finding":"validates input","status":"weird"},
  {"item":"cfg.cs","finding":"no bounds check","status":"concern"}
], "findings": []}
\`\`\``;
    const result = parsePerspectiveAnalysis(text, 'security');
    expect(result.checks).toEqual([
      { item: 'svc.cs — Handle', finding: 'validates input', status: 'pass' },
      { item: 'cfg.cs', finding: 'no bounds check', status: 'concern' },
    ]);
  });

  it('captures a summary on a skipped result and ignores a blank summary', () => {
    const skipped = parsePerspectiveAnalysis(
      '```json\n{"skipped": true, "reason": "n/a", "summary": "Reviewed schema.ts; no contract changed.", "checks": [{"item":"schema.ts","finding":"unchanged","status":"na"}]}\n```',
      'api',
    );
    expect(skipped.summary).toBe('Reviewed schema.ts; no contract changed.');
    expect(skipped.checks).toEqual([
      { item: 'schema.ts', finding: 'unchanged', status: 'na' },
    ]);
    const blank = parsePerspectiveAnalysis(
      '```json\n{"skipped": false, "summary": "   ", "findings": []}\n```',
      'api',
    );
    expect(blank.summary).toBeNull();
    expect(blank.checks).toEqual([]);
  });

  it('honours an explicit skip with a reason', () => {
    const text =
      '```json\n{"skipped": true, "reason": "No public contracts changed."}\n```';
    const result = parsePerspectiveAnalysis(text, 'api');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('No public contracts changed.');
    expect(result.summary).toBeNull();
    expect(result.checks).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('supplies a default reason when skipped without one', () => {
    const text = '```json\n{"skipped": true}\n```';
    const result = parsePerspectiveAnalysis(text, 'api');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('not applicable');
  });

  it('treats a missing/invalid object as a clean, non-skipped result', () => {
    expect(parsePerspectiveAnalysis('no json', 'security')).toEqual({
      findings: [],
      skipped: false,
      skipReason: null,
      summary: null,
      rationale: [],
      checks: [],
    });
    expect(parsePerspectiveAnalysis('```json\n[1,2]\n```', 'security')).toEqual({
      findings: [],
      skipped: false,
      skipReason: null,
      summary: null,
      rationale: [],
      checks: [],
    });
  });

  it('ignores unusable findings and a non-array findings field', () => {
    const bad =
      '```json\n{"skipped": false, "findings": [42, null, {"title":"","detail":"d","evidence":[]}]}\n```';
    expect(parsePerspectiveAnalysis(bad, 'security').findings).toEqual([]);
    const notArray = '```json\n{"skipped": false, "findings": "nope"}\n```';
    expect(parsePerspectiveAnalysis(notArray, 'security').findings).toEqual([]);
  });

  it('returns a clean result on malformed object JSON', () => {
    expect(parsePerspectiveAnalysis('```json\n{not valid}\n```', 'security')).toEqual({
      findings: [],
      skipped: false,
      skipReason: null,
      summary: null,
      rationale: [],
      checks: [],
    });
  });
});

describe('capPerspectiveFindings', () => {
  function finding(perspectiveId: string, n: number): ReviewFinding {
    return {
      id: `${perspectiveId}/ai-${n}`,
      perspectiveId,
      title: `t${n}`,
      detail: 'd',
      severity: 'low',
      status: 'needs-review',
      evidence: [],
    };
  }

  it('keeps at most max findings per perspective', () => {
    const findings = [
      finding('security', 0),
      finding('security', 1),
      finding('security', 2),
      finding('testing', 0),
    ];
    const capped = capPerspectiveFindings(findings, 2);
    expect(capped.filter((f) => f.perspectiveId === 'security')).toHaveLength(2);
    expect(capped.filter((f) => f.perspectiveId === 'testing')).toHaveLength(1);
  });
});
