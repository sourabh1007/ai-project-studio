import { createRegexLanguageAnalyzer } from './regex-analyzer.js';
import type { LanguageAnalyzer } from './language-analyzer.js';

const NAME = '[A-Za-z_]\\w*';

/**
 * C / C++ analyzer, covering the usual header and source extensions. Declared
 * types are classes, structs, unions and enums (including `enum class`). Members
 * are function definitions, excluding control-flow keywords. Start at the name,
 * not a permissive return-type prefix: overlapping whitespace quantifiers in
 * that prefix caused catastrophic backtracking on large comment-heavy headers.
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
        `\\b(?!(?:if|for|while|switch|catch|sizeof|alignof|decltype|noexcept|static_assert)\\b)` +
          `(${NAME})\\s*\\([^;{)]*\\)\\s*` +
          `(?:const\\s*)?\\{`,
      ),
    ],
    ignoreBeforeReferences: [/^[ \t]*#\s*include\b[^\n]*/gm],
  });
}
