import { createRegexLanguageAnalyzer } from './regex-analyzer.js';
import type { LanguageAnalyzer } from './language-analyzer.js';

const NAME = '[A-Za-z_$][\\w$]*';

/**
 * Java analyzer. The module is the `package` declaration; declared types are the
 * file's classes, interfaces, enums and records. `import` and `package` lines
 * are blanked before reference matching so a type whose simple name coincides
 * with a package segment is not miscounted — the genuine usage in the class body
 * still registers.
 */
export function createJavaAnalyzer(): LanguageAnalyzer {
  return createRegexLanguageAnalyzer({
    id: 'java',
    extensions: /\.java$/i,
    projectManifest: /^(?:pom\.xml|build\.gradle(?:\.kts)?)$/i,
    modulePattern: /\bpackage\s+([\w.]+)/,
    typePatterns: [
      new RegExp(`\\b(?:class|interface|enum|record)\\s+(${NAME})`),
    ],
    memberPatterns: [
      new RegExp(
        `\\b(?:public|private|protected|static|final|synchronized|abstract|` +
          `native|default)\\s+[\\w<>\\[\\],.?\\s]+?\\s+(${NAME})\\s*\\([^;{]*\\)\\s*` +
          `(?:throws[\\w,.\\s]+)?\\{`,
      ),
    ],
    ignoreBeforeReferences: [
      /^[ \t]*import\b[^\n]*/gm,
      /\bpackage\s+[\w.]+/g,
    ],
  });
}
