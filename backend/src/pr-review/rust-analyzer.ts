import { createRegexLanguageAnalyzer } from './regex-analyzer.js';
import type { LanguageAnalyzer } from './language-analyzer.js';

const NAME = '[A-Za-z_]\\w*';

/**
 * Rust analyzer. Declared types are the file's structs, enums, traits, unions,
 * type aliases and free functions. `use` declarations are blanked before
 * reference matching so a path segment that matches a type name is not counted;
 * the genuine usage in a function body still registers.
 */
export function createRustAnalyzer(): LanguageAnalyzer {
  return createRegexLanguageAnalyzer({
    id: 'rust',
    extensions: /\.rs$/i,
    projectManifest: /^Cargo\.toml$/i,
    typePatterns: [
      new RegExp(`\\b(?:pub\\s+)?(?:struct|enum|trait|union)\\s+(${NAME})`),
      new RegExp(`\\b(?:pub\\s+)?type\\s+(${NAME})`),
      new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+(${NAME})`),
    ],
    memberPatterns: [
      new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+(${NAME})`),
    ],
    ignoreBeforeReferences: [/^[ \t]*use\b[^\n]*/gm],
  });
}
