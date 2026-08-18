/**
 * Pure, evidence-based project discovery for the Project Review Board.
 *
 * Given the change's existing PR review (change graph + diff), derive a generic
 * `ProjectModel`: languages, config systems, test signals, deployment model,
 * contracts, blast-radius dimensions and — crucially — the *dynamic* set of
 * review perspectives relevant to this particular change.
 *
 * Everything is derived from the change itself. No product, repository, module,
 * service, language, framework or deployment name is hardcoded as an assumption;
 * generic detection tables (extension → language, extension → config system,
 * etc.) only *label* what the evidence already shows, and every label carries
 * the evidence it was drawn from so the reviewer can challenge it.
 */

import type {
  DetectedItem,
  DiscoveryInput,
  DiscoveryNode,
  PerspectiveSpec,
  ProjectModel,
  ReviewEvidence,
} from './review-board-contract.js';

/** Final path segment (handles both separators); '' only for an empty string. */
function lastSegment(path: string): string {
  const segs = path.split(/[\\/]/);
  return segs[segs.length - 1];
}

/** Lowercase file extension without the dot, or '' when none. */
export function extOf(path: string): string {
  const base = lastSegment(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Lowercase file name (no directory), for whole-name signals like Dockerfile. */
export function baseName(path: string): string {
  return lastSegment(path).toLowerCase();
}

/** First path segment, e.g. `src/api/x.ts` → `src`; '' when none. */
export function topDir(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length > 1 ? parts[0] : '';
}

/** Generic extension → language label. Only labels; adds no product knowledge. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  cs: 'C#',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  c: 'C',
  h: 'C/C++ header',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  scala: 'Scala',
  m: 'Objective-C',
  sql: 'SQL',
  sh: 'Shell',
  ps1: 'PowerShell',
  vue: 'Vue',
  svelte: 'Svelte',
  css: 'CSS',
  scss: 'CSS',
  less: 'CSS',
  html: 'HTML',
};

/** Generic extension → configuration-system label. */
const CONFIG_BY_EXT: Record<string, string> = {
  json: 'JSON configuration',
  yaml: 'YAML configuration',
  yml: 'YAML configuration',
  toml: 'TOML configuration',
  ini: 'INI configuration',
  env: 'Environment file',
  properties: 'Java properties',
  xml: 'XML configuration',
  config: 'XML/app configuration',
  plist: 'Property list',
};

/** Whole file names that indicate configuration regardless of extension. */
const CONFIG_BY_NAME: Record<string, string> = {
  '.env': 'Environment file',
  dockerfile: 'Container image definition',
};

/** Generic extension → contract/interface artifact label. */
const CONTRACT_BY_EXT: Record<string, string> = {
  proto: 'Protocol Buffers contract',
  thrift: 'Thrift IDL',
  avdl: 'Avro IDL',
  avsc: 'Avro schema',
  graphql: 'GraphQL schema',
  gql: 'GraphQL schema',
  wsdl: 'WSDL contract',
};

/** Frontend-flavoured extensions used only for project-type classification. */
const FRONTEND_EXTS = new Set([
  'tsx',
  'jsx',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
  'html',
]);

/** Server-side language extensions used only for project-type classification. */
const BACKEND_EXTS = new Set([
  'cs',
  'java',
  'go',
  'rs',
  'py',
  'rb',
  'php',
  'cpp',
  'cc',
  'cxx',
  'c',
  'kt',
  'scala',
  'ts',
  'js',
  'mjs',
  'cjs',
]);

/** Data-flavoured extensions used only for project-type classification. */
const DATA_EXTS = new Set(['sql', 'ipynb']);

/** Generic language label for a path, or null when the extension is unknown. */
export function languageForFile(path: string): string | null {
  return LANGUAGE_BY_EXT[extOf(path)] ?? null;
}

/** Generic config-system label for a path, or null. */
export function configSystemForFile(path: string): string | null {
  const name = baseName(path);
  if (CONFIG_BY_NAME[name]) return CONFIG_BY_NAME[name];
  return CONFIG_BY_EXT[extOf(path)] ?? null;
}

/** Generic contract label for a path, or null. */
export function contractForFile(path: string): string | null {
  const ext = extOf(path);
  if (CONTRACT_BY_EXT[ext]) return CONTRACT_BY_EXT[ext];
  if (ext === 'ts' && baseName(path).endsWith('.d.ts')) {
    return 'TypeScript declaration';
  }
  const name = baseName(path);
  if (name.includes('openapi') || name.includes('swagger')) {
    return 'OpenAPI/Swagger contract';
  }
  return null;
}

/** Generic deployment-signal label for a path, or null. */
export function deploymentSignalForFile(path: string): string | null {
  const name = baseName(path);
  const ext = extOf(path);
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) {
    return 'Containerized deployment';
  }
  if (ext === 'tf' || ext === 'tfvars') return 'Terraform infrastructure';
  if (ext === 'bicep') return 'Bicep infrastructure';
  if (name === 'chart.yaml' || name === 'chart.yml') return 'Helm chart';
  if (name.includes('servicemanifest') || name.includes('applicationmanifest')) {
    return 'Service manifest deployment';
  }
  const dir = `/${path.toLowerCase()}`;
  if (
    (ext === 'yaml' || ext === 'yml') &&
    (dir.includes('/k8s/') ||
      dir.includes('/kubernetes/') ||
      dir.includes('/pipelines/') ||
      dir.includes('/.github/workflows/'))
  ) {
    return 'Pipeline/orchestration manifest';
  }
  return null;
}

/** True when a path looks like a test by conventional naming. */
export function testSignalForFile(path: string): string | null {
  const name = baseName(path);
  const dir = `/${path.toLowerCase()}`;
  if (
    name.includes('.test.') ||
    name.includes('.spec.') ||
    name.includes('_test.') ||
    name.startsWith('test_')
  ) {
    return 'Unit/spec test file';
  }
  if (
    dir.includes('/tests/') ||
    dir.includes('/test/') ||
    dir.includes('/__tests__/')
  ) {
    return 'Test directory file';
  }
  return null;
}

/** Merge a detection into a name→evidence map, de-duplicating by name. */
function addDetection(
  map: Map<string, ReviewEvidence[]>,
  name: string,
  evidence: ReviewEvidence,
): void {
  const existing = map.get(name);
  if (existing) {
    existing.push(evidence);
  } else {
    map.set(name, [evidence]);
  }
}

/** Turn a detection map into sorted `DetectedItem[]`. */
function toItems(map: Map<string, ReviewEvidence[]>): DetectedItem[] {
  return [...map.entries()]
    .map(([name, evidence]) => ({ name, evidence }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Only the nodes that actually changed (boundary nodes are impact, not change). */
function changedNodes(nodes: DiscoveryNode[]): DiscoveryNode[] {
  return nodes.filter((n) => n.kind === 'changed');
}

interface Classification {
  projectType: string;
  confidence: number;
  evidence: ReviewEvidence[];
}

/**
 * Classify the project type from the mix of changed evidence. Ordered rules;
 * the first that matches wins. Always evidence-backed and challengeable.
 */
export function classifyProjectType(
  changed: DiscoveryNode[],
  deploymentModel: string,
  contractCount: number,
): Classification {
  let frontend = 0;
  let backend = 0;
  let data = 0;
  let iac = 0;
  for (const node of changed) {
    const ext = extOf(node.path);
    if (FRONTEND_EXTS.has(ext)) frontend += 1;
    if (BACKEND_EXTS.has(ext)) backend += 1;
    if (DATA_EXTS.has(ext)) data += 1;
    if (deploymentSignalForFile(node.path)) iac += 1;
  }
  const total = changed.length || 1;
  const ev = (reason: string): ReviewEvidence => ({
    source: 'change graph',
    reason,
    confidence: 0.6,
    direct: false,
  });

  if (iac > 0 && iac >= frontend && iac >= backend) {
    return {
      projectType: 'Infrastructure-as-code project',
      confidence: Math.min(0.9, 0.5 + iac / total),
      evidence: [ev(`${iac} infrastructure/deployment file(s) changed`)],
    };
  }
  if (data > 0 && data >= backend && data >= frontend) {
    return {
      projectType: 'Data pipeline or analytics project',
      confidence: Math.min(0.85, 0.5 + data / total),
      evidence: [ev(`${data} data/query file(s) changed`)],
    };
  }
  if (frontend > 0 && frontend > backend) {
    return {
      projectType: 'Frontend web app',
      confidence: Math.min(0.85, 0.5 + frontend / total),
      evidence: [ev(`${frontend} frontend file(s) dominate the change`)],
    };
  }
  if (backend > 0 && deploymentModel !== '') {
    return {
      projectType: 'Distributed cloud service',
      confidence: 0.7,
      evidence: [
        ev(`server-side code plus a "${deploymentModel}" deployment signal`),
      ],
    };
  }
  if (backend > 0) {
    return {
      projectType: 'Backend service',
      confidence: Math.min(0.8, 0.5 + backend / total),
      evidence: [ev(`${backend} server-side source file(s) changed`)],
    };
  }
  if (contractCount > 0) {
    return {
      projectType: 'Library or SDK',
      confidence: 0.55,
      evidence: [ev('contract/interface artifacts changed with no app code')],
    };
  }
  return {
    projectType: 'General software project',
    confidence: 0.4,
    evidence: [ev('no dominant language or deployment signal detected')],
  };
}

/** True for project types with meaningful runtime/reliability concerns. */
function isServiceLike(projectType: string): boolean {
  return (
    projectType === 'Backend service' ||
    projectType === 'Distributed cloud service' ||
    projectType === 'Data pipeline or analytics project'
  );
}

/**
 * Select the dynamic review board: always-present core perspectives plus any
 * the evidence makes relevant. Each carries an evidence-grounded `why`.
 */
export function selectPerspectives(
  model: Pick<
    ProjectModel,
    | 'projectType'
    | 'configurationSystems'
    | 'contracts'
    | 'deploymentModel'
  >,
): PerspectiveSpec[] {
  const specs: PerspectiveSpec[] = [
    {
      id: 'problem-solution',
      name: 'Problem ↔ Solution',
      why: 'Every change must be checked against the problem it claims to solve.',
      source: 'core',
    },
    {
      id: 'architecture',
      name: 'Architecture & Design',
      why: 'Confirm the change fits the existing structure and boundaries.',
      source: 'core',
    },
    {
      id: 'impact-blast-radius',
      name: 'Impact & Blast Radius',
      why: 'Understand everything the change can reach before approving.',
      source: 'core',
    },
    {
      id: 'code-flow',
      name: 'Code Flow',
      why: 'Trace how control and data move through the changed code.',
      source: 'core',
    },
    {
      id: 'code-quality',
      name: 'Code Quality',
      why: 'Assess readability, maintainability and cleanliness of the change.',
      source: 'core',
    },
  ];

  const type = model.projectType;
  if (isServiceLike(type)) {
    specs.push({
      id: 'reliability',
      name: 'Reliability',
      why: `Runtime failure modes matter for a ${type.toLowerCase()}.`,
      source: 'detected',
    });
    specs.push({
      id: 'performance',
      name: 'Performance',
      why: `Latency and throughput matter for a ${type.toLowerCase()}.`,
      source: 'detected',
    });
    specs.push({
      id: 'observability',
      name: 'Observability',
      why: `Changes to a ${type.toLowerCase()} need diagnosability.`,
      source: 'detected',
    });
  }

  if (model.configurationSystems.length > 0) {
    specs.push({
      id: 'configuration',
      name: 'Configuration',
      why: `Change touches ${model.configurationSystems.length} configuration system(s).`,
      source: 'detected',
    });
  }

  if (model.contracts.length > 0 || isServiceLike(type)) {
    specs.push({
      id: 'api-contract',
      name: 'API / Contract Impact',
      why:
        model.contracts.length > 0
          ? 'Contract/interface artifacts changed.'
          : 'Service changes can alter public or internal contracts.',
      source: 'detected',
    });
  }

  if (type === 'Frontend web app') {
    specs.push({
      id: 'accessibility',
      name: 'Accessibility',
      why: 'Frontend changes must remain accessible.',
      source: 'detected',
    });
  }

  if (type === 'Library or SDK') {
    specs.push({
      id: 'backward-compatibility',
      name: 'Backward Compatibility',
      why: 'Library changes can break existing consumers.',
      source: 'detected',
    });
  }

  if (type === 'Data pipeline or analytics project') {
    specs.push({
      id: 'data-contract',
      name: 'Data Contract & Schema',
      why: 'Pipeline changes can break schema/data-contract compatibility.',
      source: 'detected',
    });
  }

  if (type === 'Infrastructure-as-code project') {
    specs.push({
      id: 'rollback-safety',
      name: 'Rollback Safety',
      why: 'Infrastructure changes need a safe rollback path.',
      source: 'detected',
    });
  }

  if (model.deploymentModel !== '') {
    specs.push({
      id: 'deployment',
      name: 'Deployment & Rollout',
      why: `A "${model.deploymentModel}" deployment signal was detected.`,
      source: 'detected',
    });
  }

  specs.push({
    id: 'testing',
    name: 'Testing',
    why: 'Every change must be adequately tested.',
    source: 'core',
  });
  specs.push({
    id: 'security',
    name: 'Security',
    why: 'Every change must be reviewed for security impact.',
    source: 'core',
  });
  specs.push({
    id: 'final-decision',
    name: 'Final Decision',
    why: 'The reviewer records the merge decision here.',
    source: 'core',
  });

  return specs;
}

/** Derive the generic `ProjectModel` from change evidence. */
export function discoverProjectModel(input: DiscoveryInput): ProjectModel {
  const changed = changedNodes(input.nodes);
  const evidence: ReviewEvidence[] = [];

  // Languages, most-frequent first.
  const langCounts = new Map<string, number>();
  for (const node of changed) {
    const lang = languageForFile(node.path);
    if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
  }
  const rankedLangs = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);
  const primaryLanguages = rankedLangs.slice(0, 1);
  const secondaryLanguages = rankedLangs.slice(1);
  if (rankedLangs.length > 0) {
    evidence.push({
      source: 'changed files',
      reason: `Detected languages: ${rankedLangs.join(', ')}.`,
      confidence: 0.9,
      direct: true,
    });
  }

  // Configuration systems.
  const configMap = new Map<string, ReviewEvidence[]>();
  for (const node of changed) {
    const cfg = configSystemForFile(node.path);
    if (cfg) {
      addDetection(configMap, cfg, {
        source: node.path,
        reason: `Recognised as ${cfg}.`,
        confidence: 0.8,
        direct: true,
      });
    }
  }
  const configurationSystems = toItems(configMap);

  // Contracts.
  const contractMap = new Map<string, ReviewEvidence[]>();
  for (const node of changed) {
    const contract = contractForFile(node.path);
    if (contract) {
      addDetection(contractMap, contract, {
        source: node.path,
        reason: `Recognised as ${contract}.`,
        confidence: 0.8,
        direct: true,
      });
    }
  }
  const contracts = toItems(contractMap);

  // Test signals.
  const testMap = new Map<string, ReviewEvidence[]>();
  for (const node of changed) {
    const signal = testSignalForFile(node.path);
    if (signal) {
      addDetection(testMap, signal, {
        source: node.path,
        reason: `Recognised as ${signal}.`,
        confidence: 0.75,
        direct: true,
      });
    }
  }
  const testSignals = toItems(testMap);

  // Deployment model — first detected wins as the headline label.
  let deploymentModel = '';
  for (const node of changed) {
    const signal = deploymentSignalForFile(node.path);
    if (signal) {
      deploymentModel = signal;
      evidence.push({
        source: node.path,
        reason: `Deployment signal: ${signal}.`,
        confidence: 0.7,
        direct: true,
      });
      break;
    }
  }

  // Components / modules / runtime areas.
  const changedComponents = [...new Set(input.projects.map((p) => p.name))].sort(
    (a, b) => a.localeCompare(b),
  );
  const changedModules = [
    ...new Set(
      changed
        .map((n) => n.module)
        .filter((m): m is string => m !== null && m.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const changedRuntimePaths = [
    ...new Set(changed.map((n) => topDir(n.path)).filter((d) => d.length > 0)),
  ].sort((a, b) => a.localeCompare(b));

  const classification = classifyProjectType(
    changed,
    deploymentModel,
    contracts.length,
  );
  evidence.push(...classification.evidence);

  // Blast-radius dimensions the change plausibly reaches.
  const blastRadiusDimensions: string[] = [];
  if (changedComponents.length > 0) blastRadiusDimensions.push('Components');
  if (configurationSystems.length > 0) {
    blastRadiusDimensions.push('Configuration');
  }
  if (testSignals.length > 0) blastRadiusDimensions.push('Tests');
  if (deploymentModel !== '') blastRadiusDimensions.push('Deployment');
  if (contracts.length > 0) blastRadiusDimensions.push('Contracts');
  blastRadiusDimensions.push('Consumers');

  const perspectives = selectPerspectives({
    projectType: classification.projectType,
    configurationSystems,
    contracts,
    deploymentModel,
  });

  // Overall confidence: blend of classification confidence and evidence breadth.
  const breadth = Math.min(1, evidence.length / 6);
  const confidence = Number(
    ((classification.confidence + breadth) / 2).toFixed(2),
  );

  return {
    projectType: classification.projectType,
    projectTypeConfidence: classification.confidence,
    primaryLanguages,
    secondaryLanguages,
    changedComponents,
    changedModules,
    changedRuntimePaths,
    configurationSystems,
    testSignals,
    deploymentModel,
    contracts,
    blastRadiusDimensions,
    perspectives,
    confidence,
    evidence,
  };
}
