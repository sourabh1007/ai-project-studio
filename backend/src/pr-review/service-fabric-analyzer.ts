import type {
  LanguageAnalyzer,
  LanguageDeclarations,
  ReferenceHit,
} from './language-analyzer.js';

/**
 * A deterministic `LanguageAnalyzer` for **Azure Service Fabric** application
 * packaging. It reads the canonical manifest files — `ApplicationManifest.xml`,
 * `ServiceManifest.xml` and `Settings.xml` — and draws reference edges that
 * reflect exactly how the package wires itself together, based purely on the
 * XML content (no heuristics or guessed relationships):
 *
 * - `ApplicationManifest.xml` → `ServiceManifest.xml` where it imports a service
 *   manifest (`ServiceManifestName`) or declares a service of one of its service
 *   types (`ServiceTypeName`).
 * - `ApplicationManifest.xml` → `Settings.xml` where a `<ConfigOverride>` targets
 *   a configuration `<Section>` the settings file declares.
 *
 * Only the application manifest originates edges — it is the composition root of
 * a Service Fabric package — so the resulting graph stays clean and uncluttered
 * instead of cross-linking every file. Scoping to the well-defined manifest
 * schema keeps every edge grounded in a real, parseable relationship rather than
 * an assumption about arbitrary config files.
 */

const SF_FILE = /(?:ServiceManifest|ApplicationManifest|Settings)\.xml$/i;

/** Replaces XML comments with blanks (length-preserving) so commented-out
 * references never register as real ones. */
function blankXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
}

type ManifestKind = 'application' | 'service' | 'settings' | null;

/** Which Service Fabric manifest a file is, from its root element. */
function manifestKind(content: string): ManifestKind {
  if (/<ApplicationManifest\b/i.test(content)) {
    return 'application';
  }
  if (/<ServiceManifest\b/i.test(content)) {
    return 'service';
  }
  if (/<Settings\b/i.test(content)) {
    return 'settings';
  }
  return null;
}

/** The value of `attr` on the first `<element ...>` open tag, or null. */
function firstAttr(
  content: string,
  element: string,
  attr: string,
): string | null {
  const re = new RegExp(`<${element}\\b[^>]*\\b${attr}="([^"]+)"`, 'i');
  const match = re.exec(content);
  return match ? match[1] : null;
}

/** Every value of a named attribute across the document, in order. */
function attrValues(content: string, attr: string): string[] {
  const re = new RegExp(`\\b${attr}="([^"]+)"`, 'gi');
  return [...content.matchAll(re)].map((match) => match[1]);
}

/** The `Name` of every `<Section>` element (config section declarations). */
function sectionNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/<Section\b[^>]*\bName="([^"]+)"/gi)) {
    names.add(match[1]);
  }
  return [...names];
}

/** Config sections referenced inside `<ConfigOverride>` blocks only. */
function configOverrideSections(content: string): string[] {
  const names: string[] = [];
  for (const block of content.matchAll(
    /<ConfigOverride\b[\s\S]*?<\/ConfigOverride>/gi,
  )) {
    for (const match of block[0].matchAll(
      /<Section\b[^>]*\bName="([^"]+)"/gi,
    )) {
      names.push(match[1]);
    }
  }
  return names;
}

export function createServiceFabricAnalyzer(): LanguageAnalyzer {
  return {
    id: 'service-fabric',
    handles(path) {
      return SF_FILE.test(path);
    },
    projectManifest: /ApplicationManifest\.xml$/i,
    declarations(content): LanguageDeclarations {
      const code = blankXmlComments(content);
      const kind = manifestKind(code);
      if (kind === 'service') {
        const name = firstAttr(code, 'ServiceManifest', 'Name');
        const types = new Set<string>();
        if (name) {
          types.add(name);
        }
        for (const type of attrValues(code, 'ServiceTypeName')) {
          types.add(type);
        }
        return { module: name, types: [...types] };
      }
      if (kind === 'settings') {
        return { module: null, types: sectionNames(code) };
      }
      if (kind === 'application') {
        return {
          module: firstAttr(code, 'ApplicationManifest', 'ApplicationTypeName'),
          types: [],
        };
      }
      return { module: null, types: [] };
    },
    references(content, candidateTypes): ReferenceHit[] {
      if (candidateTypes.length === 0) {
        return [];
      }
      const code = blankXmlComments(content);
      // Only the application manifest wires services and config together; other
      // manifests declare but never reference, keeping the graph uncluttered.
      if (manifestKind(code) !== 'application') {
        return [];
      }
      const candidates = new Set(candidateTypes);
      const hits: ReferenceHit[] = [];
      const seen = new Set<string>();
      const add = (name: string, caller: string): void => {
        if (!candidates.has(name)) {
          return;
        }
        const key = `${name}\u0000${caller}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({ type: name, caller });
        }
      };
      for (const name of attrValues(code, 'ServiceManifestName')) {
        add(name, 'import');
      }
      for (const name of attrValues(code, 'ServiceTypeName')) {
        add(name, 'service');
      }
      for (const name of configOverrideSections(code)) {
        add(name, 'config');
      }
      return hits;
    },
  };
}
