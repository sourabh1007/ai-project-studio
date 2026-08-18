import { describe, expect, it } from 'vitest';
import {
  baseName,
  classifyProjectType,
  configSystemForFile,
  contractForFile,
  deploymentSignalForFile,
  discoverProjectModel,
  extOf,
  languageForFile,
  selectPerspectives,
  testSignalForFile,
  topDir,
} from './project-discovery.js';
import type { DiscoveryInput, DiscoveryNode } from './review-board-contract.js';

function node(over: Partial<DiscoveryNode> & { path: string }): DiscoveryNode {
  return {
    category: 'code',
    kind: 'changed',
    module: null,
    ...over,
  };
}

describe('path helpers', () => {
  it('extOf returns lowercase extension or empty', () => {
    expect(extOf('src/a/File.TS')).toBe('ts');
    expect(extOf('src/a/Makefile')).toBe('');
    expect(extOf('.env')).toBe('');
    expect(extOf('a/b')).toBe('');
  });

  it('baseName returns the lowercased final segment', () => {
    expect(baseName('src/API/Thing.cs')).toBe('thing.cs');
    expect(baseName('Dockerfile')).toBe('dockerfile');
  });

  it('topDir returns the first segment or empty', () => {
    expect(topDir('src/api/x.ts')).toBe('src');
    expect(topDir('/leading/api/x.ts')).toBe('leading');
    expect(topDir('root.ts')).toBe('');
  });
});

describe('language detection', () => {
  it('labels known extensions and rejects unknown ones', () => {
    expect(languageForFile('a/b.ts')).toBe('TypeScript');
    expect(languageForFile('a/b.go')).toBe('Go');
    expect(languageForFile('a/b.unknownext')).toBeNull();
  });
});

describe('config detection', () => {
  it('detects config by name and by extension', () => {
    expect(configSystemForFile('service/.env')).toBe('Environment file');
    expect(configSystemForFile('Dockerfile')).toBe('Container image definition');
    expect(configSystemForFile('config/app.json')).toBe('JSON configuration');
    expect(configSystemForFile('src/readme.md')).toBeNull();
  });
});

describe('contract detection', () => {
  it('detects proto, declarations, openapi and rejects others', () => {
    expect(contractForFile('api/svc.proto')).toBe('Protocol Buffers contract');
    expect(contractForFile('types/api.d.ts')).toBe('TypeScript declaration');
    expect(contractForFile('spec/openapi.yaml')).toBe('OpenAPI/Swagger contract');
    expect(contractForFile('spec/swagger.json')).toBe('OpenAPI/Swagger contract');
    expect(contractForFile('src/app.ts')).toBeNull();
    expect(contractForFile('src/app.py')).toBeNull();
  });
});

describe('deployment detection', () => {
  it('detects the full range of deployment signals', () => {
    expect(deploymentSignalForFile('Dockerfile')).toBe('Containerized deployment');
    expect(deploymentSignalForFile('Dockerfile.prod')).toBe(
      'Containerized deployment',
    );
    expect(deploymentSignalForFile('infra/main.tf')).toBe('Terraform infrastructure');
    expect(deploymentSignalForFile('infra/vars.tfvars')).toBe(
      'Terraform infrastructure',
    );
    expect(deploymentSignalForFile('infra/main.bicep')).toBe('Bicep infrastructure');
    expect(deploymentSignalForFile('deploy/Chart.yaml')).toBe('Helm chart');
    expect(deploymentSignalForFile('deploy/Chart.yml')).toBe('Helm chart');
    expect(deploymentSignalForFile('svc/ServiceManifest.xml')).toBe(
      'Service manifest deployment',
    );
    expect(deploymentSignalForFile('k8s/deploy.yaml')).toBe(
      'Pipeline/orchestration manifest',
    );
    expect(deploymentSignalForFile('.github/workflows/ci.yml')).toBe(
      'Pipeline/orchestration manifest',
    );
    expect(deploymentSignalForFile('src/app.ts')).toBeNull();
    expect(deploymentSignalForFile('random/plain.yaml')).toBeNull();
  });
});

describe('test detection', () => {
  it('detects test files by name and directory, else null', () => {
    expect(testSignalForFile('src/a.test.ts')).toBe('Unit/spec test file');
    expect(testSignalForFile('src/a.spec.ts')).toBe('Unit/spec test file');
    expect(testSignalForFile('src/a_test.go')).toBe('Unit/spec test file');
    expect(testSignalForFile('test_thing.py')).toBe('Unit/spec test file');
    expect(testSignalForFile('module/tests/helper.ts')).toBe('Test directory file');
    expect(testSignalForFile('module/__tests__/helper.ts')).toBe(
      'Test directory file',
    );
    expect(testSignalForFile('src/app.ts')).toBeNull();
  });
});

describe('classifyProjectType', () => {
  it('classifies infrastructure when deployment files dominate', () => {
    const c = classifyProjectType(
      [node({ path: 'infra/main.tf' }), node({ path: 'infra/main.bicep' })],
      'Terraform infrastructure',
      0,
    );
    expect(c.projectType).toBe('Infrastructure-as-code project');
  });

  it('classifies data pipelines when data files dominate', () => {
    const c = classifyProjectType(
      [node({ path: 'etl/a.sql' }), node({ path: 'etl/b.sql' })],
      '',
      0,
    );
    expect(c.projectType).toBe('Data pipeline or analytics project');
  });

  it('classifies frontend when frontend files dominate', () => {
    const c = classifyProjectType(
      [node({ path: 'ui/App.tsx' }), node({ path: 'ui/App.css' })],
      '',
      0,
    );
    expect(c.projectType).toBe('Frontend web app');
  });

  it('classifies distributed service when backend has a deployment signal', () => {
    const c = classifyProjectType(
      [
        node({ path: 'svc/a.go' }),
        node({ path: 'svc/b.go' }),
        node({ path: 'svc/c.go' }),
      ],
      'Containerized deployment',
      0,
    );
    expect(c.projectType).toBe('Distributed cloud service');
  });

  it('classifies a plain backend service', () => {
    const c = classifyProjectType([node({ path: 'svc/a.go' })], '', 0);
    expect(c.projectType).toBe('Backend service');
  });

  it('classifies a library when only contracts changed', () => {
    const c = classifyProjectType([node({ path: 'api/svc.proto' })], '', 1);
    expect(c.projectType).toBe('Library or SDK');
  });

  it('falls back to a general project with no signals', () => {
    const c = classifyProjectType([node({ path: 'docs/readme.md' })], '', 0);
    expect(c.projectType).toBe('General software project');
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.evidence.length).toBeGreaterThan(0);
  });

  it('handles an empty change set', () => {
    const c = classifyProjectType([], '', 0);
    expect(c.projectType).toBe('General software project');
  });
});

describe('selectPerspectives', () => {
  it('adds service, config and contract lenses for a service change', () => {
    const specs = selectPerspectives({
      projectType: 'Backend service',
      configurationSystems: [{ name: 'JSON configuration', evidence: [] }],
      contracts: [],
      deploymentModel: 'Containerized deployment',
    });
    const ids = specs.map((s) => s.id);
    expect(ids).toContain('reliability');
    expect(ids).toContain('performance');
    expect(ids).toContain('observability');
    expect(ids).toContain('configuration');
    expect(ids).toContain('api-contract');
    expect(ids).toContain('deployment');
    // api-contract "why" for a service without explicit contracts:
    const api = specs.find((s) => s.id === 'api-contract');
    expect(api?.why).toContain('Service changes');
  });

  it('adds frontend and contract lenses for a frontend change', () => {
    const specs = selectPerspectives({
      projectType: 'Frontend web app',
      configurationSystems: [],
      contracts: [{ name: 'TypeScript declaration', evidence: [] }],
      deploymentModel: '',
    });
    const ids = specs.map((s) => s.id);
    expect(ids).toContain('accessibility');
    expect(ids).toContain('api-contract');
    expect(ids).not.toContain('reliability');
    const api = specs.find((s) => s.id === 'api-contract');
    expect(api?.why).toContain('Contract');
  });

  it('adds backward-compat, data-contract and rollback lenses by type', () => {
    expect(
      selectPerspectives({
        projectType: 'Library or SDK',
        configurationSystems: [],
        contracts: [],
        deploymentModel: '',
      }).map((s) => s.id),
    ).toContain('backward-compatibility');
    expect(
      selectPerspectives({
        projectType: 'Data pipeline or analytics project',
        configurationSystems: [],
        contracts: [],
        deploymentModel: '',
      }).map((s) => s.id),
    ).toContain('data-contract');
    expect(
      selectPerspectives({
        projectType: 'Infrastructure-as-code project',
        configurationSystems: [],
        contracts: [],
        deploymentModel: '',
      }).map((s) => s.id),
    ).toContain('rollback-safety');
  });
});

describe('discoverProjectModel', () => {
  it('derives a full model for a backend service change', () => {
    const input: DiscoveryInput = {
      description: 'Add retry logic to the client',
      changedFiles: 3,
      projects: [
        { id: 'p1', name: 'Client', path: 'svc/client.csproj' },
        { id: 'p1', name: 'Client', path: 'svc/client.csproj' },
      ],
      nodes: [
        node({ path: 'svc/client.cs', module: 'Client' }),
        node({ path: 'svc/retry.cs', module: 'Client' }),
        node({ path: 'svc/config.json', module: null }),
        node({ path: 'svc/extra.json', module: null }),
        node({ path: 'svc/api.proto', module: null }),
        node({ path: 'svc/client.test.cs', category: 'test', module: 'Client' }),
        // boundary nodes are ignored by discovery:
        node({ path: 'svc/other.cs', kind: 'boundary', module: 'Other' }),
      ],
    };
    const model = discoverProjectModel(input);
    expect(model.projectType).toBe('Backend service');
    expect(model.primaryLanguages).toEqual(['C#']);
    expect(model.changedComponents).toEqual(['Client']);
    expect(model.changedModules).toEqual(['Client']);
    expect(model.changedRuntimePaths).toEqual(['svc']);
    expect(model.configurationSystems.map((c) => c.name)).toContain(
      'JSON configuration',
    );
    expect(model.contracts.map((c) => c.name)).toContain(
      'Protocol Buffers contract',
    );
    expect(model.testSignals.length).toBeGreaterThan(0);
    expect(model.blastRadiusDimensions).toEqual(
      expect.arrayContaining([
        'Components',
        'Configuration',
        'Tests',
        'Contracts',
        'Consumers',
      ]),
    );
    expect(model.confidence).toBeGreaterThan(0);
    expect(model.evidence.length).toBeGreaterThan(0);
  });

  it('sets a deployment model and secondary languages, and handles no languages', () => {
    const withDeploy = discoverProjectModel({
      description: null,
      changedFiles: 2,
      projects: [],
      nodes: [
        node({ path: 'svc/a.go' }),
        node({ path: 'svc/helper.py' }),
        node({ path: 'Dockerfile' }),
      ],
    });
    expect(withDeploy.deploymentModel).toBe('Containerized deployment');
    expect(withDeploy.blastRadiusDimensions).toContain('Deployment');
    expect(withDeploy.primaryLanguages).toEqual(['Go']);
    expect(withDeploy.secondaryLanguages).toContain('Python');

    const noLang = discoverProjectModel({
      description: 'x',
      changedFiles: 1,
      projects: [],
      nodes: [node({ path: 'docs/readme.md' })],
    });
    expect(noLang.primaryLanguages).toEqual([]);
    expect(noLang.blastRadiusDimensions).toEqual(['Consumers']);
    expect(noLang.deploymentModel).toBe('');
  });
});
