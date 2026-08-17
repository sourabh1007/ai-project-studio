import { createRegexLanguageAnalyzer } from './regex-analyzer.js';
import type { LanguageAnalyzer } from './language-analyzer.js';

const NAME = '[A-Za-z_]\\w*';

/**
 * C / C++ analyzer, covering the usual header and source extensions. Declared
 * types are classes, structs, unions and enums (including `enum class`). Members
 * are function definitions — detected by a return type followed by a name, an
 * argument list and an opening brace, which excludes control-flow keywords like
 * `if`/`while`. `#include` directives are blanked before reference matching.
 */
export function createCppAnalyzer(): LanguageAnalyzer {
  return createRegexLanguageAnalyzer({
    id: 'cpp',
    extensions: /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+)$/i,
    projectManifest: /^(?:CMakeLists\.txt|Makefile|GNUmakefile|.*\.vcxproj)$/i,
    typePatterns: [
      new RegExp(`\\b(?:class|struct|union|enum(?:\\s+class)?)\\s+(${NAME})`),
    ],
    memberPatterns: [
      new RegExp(
        `\\b[A-Za-z_][\\w:<>*&,\\s]*?\\s+(${NAME})\\s*\\([^;{)]*\\)\\s*` +
          `(?:const\\s*)?\\{`,
      ),
    ],
    ignoreBeforeReferences: [/^[ \t]*#\s*include\b[^\n]*/gm],
  });
}
