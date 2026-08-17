import { createRegexLanguageAnalyzer } from './regex-analyzer.js';
import type { LanguageAnalyzer } from './language-analyzer.js';

const NAME = '[A-Za-z_$][\\w$]*';

/**
 * JavaScript / TypeScript analyzer. Declared "types" are the file's exported
 * classes, interfaces, type aliases, enums, functions and top-level bindings —
 * the symbols other changed files reference by import. Template literals are
 * blanked so a name mentioned only in a string never draws an edge. Import
 * bindings are intentionally *not* blanked: in JS/TS importing a name is a real
 * cross-file reference to it.
 */
export function createJavaScriptAnalyzer(): LanguageAnalyzer {
  return createRegexLanguageAnalyzer({
    id: 'javascript',
    extensions: /\.(?:[mc]?jsx?|[mc]?tsx?)$/i,
    projectManifest: /^package\.json$/i,
    stringOptions: { templateLiterals: true },
    typePatterns: [
      new RegExp(`\\bclass\\s+(${NAME})`),
      new RegExp(`\\binterface\\s+(${NAME})`),
      new RegExp(`\\btype\\s+(${NAME})`),
      new RegExp(`\\benum\\s+(${NAME})`),
      new RegExp(`\\bfunction\\s*\\*?\\s*(${NAME})`),
      new RegExp(`\\bexport\\s+(?:const|let|var)\\s+(${NAME})`),
    ],
    memberPatterns: [
      new RegExp(`\\bfunction\\s*\\*?\\s*(${NAME})`),
      new RegExp(`\\b(?:const|let|var)\\s+(${NAME})\\s*=\\s*(?:async\\s*)?\\(`),
    ],
  });
}
