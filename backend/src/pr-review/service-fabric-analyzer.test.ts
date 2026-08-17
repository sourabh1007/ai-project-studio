import { describe, expect, it } from 'vitest';
import { createServiceFabricAnalyzer } from './service-fabric-analyzer.js';

const analyzer = createServiceFabricAnalyzer();

const serviceManifest = `<?xml version="1.0" encoding="utf-8"?>
<ServiceManifest Name="GatewayPkg" Version="1.0.0"
  xmlns="http://schemas.microsoft.com/2011/01/fabric">
  <ServiceTypes>
    <StatelessServiceType ServiceTypeName="GatewayType" />
  </ServiceTypes>
  <CodePackage Name="Code" Version="1.0.0" />
  <ConfigPackage Name="Config" Version="1.0.0" />
</ServiceManifest>`;

const settings = `<?xml version="1.0" encoding="utf-8"?>
<Settings xmlns="http://schemas.microsoft.com/2011/01/fabric">
  <Section Name="Logging">
    <Parameter Name="Level" Value="Info" />
  </Section>
  <Section Name="Throttling">
    <Parameter Name="Max" Value="100" />
  </Section>
</Settings>`;

const applicationManifest = `<?xml version="1.0" encoding="utf-8"?>
<ApplicationManifest ApplicationTypeName="ShopType" ApplicationTypeVersion="1.0.0"
  xmlns="http://schemas.microsoft.com/2011/01/fabric">
  <ServiceManifestImport>
    <ServiceManifestRef ServiceManifestName="GatewayPkg" ServiceManifestVersion="1.0.0" />
    <ConfigOverride Name="Config">
      <Settings>
        <Section Name="Logging">
          <Parameter Name="Level" Value="Debug" />
        </Section>
      </Settings>
    </ConfigOverride>
  </ServiceManifestImport>
  <DefaultServices>
    <Service Name="Gateway">
      <StatelessService ServiceTypeName="GatewayType" InstanceCount="1" />
    </Service>
  </DefaultServices>
</ApplicationManifest>`;

describe('service-fabric-analyzer', () => {
  it('handles only the canonical Service Fabric manifest files', () => {
    expect(analyzer.handles('src/ServiceManifest.xml')).toBe(true);
    expect(analyzer.handles('pkg/ApplicationManifest.xml')).toBe(true);
    expect(analyzer.handles('cfg/Config/Settings.xml')).toBe(true);
    expect(analyzer.handles('src/App.cs')).toBe(false);
    expect(analyzer.handles('src/random.xml')).toBe(false);
  });

  it('groups files under the application manifest', () => {
    expect(analyzer.projectManifest.test('pkg/ApplicationManifest.xml')).toBe(true);
    expect(analyzer.projectManifest.test('pkg/ServiceManifest.xml')).toBe(false);
  });

  it('declares the service manifest name and its service types', () => {
    expect(analyzer.declarations(serviceManifest)).toEqual({
      module: 'GatewayPkg',
      types: ['GatewayPkg', 'GatewayType'],
    });
  });

  it('declares configuration sections from a settings file', () => {
    expect(analyzer.declarations(settings)).toEqual({
      module: null,
      types: ['Logging', 'Throttling'],
    });
  });

  it('declares the application type but no referenceable types', () => {
    expect(analyzer.declarations(applicationManifest)).toEqual({
      module: 'ShopType',
      types: [],
    });
  });

  it('declares service types even when the manifest has no Name', () => {
    const noName = `<ServiceManifest Version="1.0.0" xmlns="x">
      <ServiceTypes><StatelessServiceType ServiceTypeName="OnlyType" /></ServiceTypes>
    </ServiceManifest>`;
    expect(analyzer.declarations(noName)).toEqual({
      module: null,
      types: ['OnlyType'],
    });
  });

  it('returns empty declarations for unrelated content', () => {
    expect(analyzer.declarations('<Nope/>')).toEqual({ module: null, types: [] });
  });

  it('references the imported service manifest, service type and overridden section', () => {
    const hits = analyzer.references(applicationManifest, [
      'GatewayPkg',
      'GatewayType',
      'Logging',
      'Throttling',
    ]);
    expect(hits).toContainEqual({ type: 'GatewayPkg', caller: 'import' });
    expect(hits).toContainEqual({ type: 'GatewayType', caller: 'service' });
    expect(hits).toContainEqual({ type: 'Logging', caller: 'config' });
    // Throttling is declared but not overridden, so it is not referenced.
    expect(hits.some((h) => h.type === 'Throttling')).toBe(false);
  });

  it('skips referenced names that are not candidate types', () => {
    // Only GatewayType is a candidate; the imported GatewayPkg must be ignored.
    expect(analyzer.references(applicationManifest, ['GatewayType'])).toEqual([
      { type: 'GatewayType', caller: 'service' },
    ]);
  });

  it('does not originate references from service or settings manifests', () => {
    expect(analyzer.references(serviceManifest, ['Logging'])).toEqual([]);
    expect(analyzer.references(settings, ['GatewayType'])).toEqual([]);
  });

  it('returns nothing when there are no candidate types', () => {
    expect(analyzer.references(applicationManifest, [])).toEqual([]);
  });

  it('ignores references that are commented out', () => {
    const commented = `<ApplicationManifest xmlns="x">
      <!-- <ServiceManifestRef ServiceManifestName="GatewayPkg" /> -->
    </ApplicationManifest>`;
    expect(analyzer.references(commented, ['GatewayPkg'])).toEqual([]);
  });

  it('de-duplicates repeated references to the same target', () => {
    const twice = `<ApplicationManifest xmlns="x">
      <ServiceManifestRef ServiceManifestName="GatewayPkg" />
      <ServiceManifestRef ServiceManifestName="GatewayPkg" />
    </ApplicationManifest>`;
    expect(analyzer.references(twice, ['GatewayPkg'])).toEqual([
      { type: 'GatewayPkg', caller: 'import' },
    ]);
  });
});
