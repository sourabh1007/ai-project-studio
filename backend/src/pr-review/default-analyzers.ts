import { createLanguageAnalyzerRegistry } from './language-analyzer.js';
import { createCSharpAnalyzer } from './csharp-analyzer.js';
import { createJavaScriptAnalyzer } from './javascript-analyzer.js';
import { createJavaAnalyzer } from './java-analyzer.js';
import { createRustAnalyzer } from './rust-analyzer.js';
import { createCppAnalyzer } from './cpp-analyzer.js';
import { createServiceFabricAnalyzer } from './service-fabric-analyzer.js';

export function createDefaultAnalyzers() {
  return createLanguageAnalyzerRegistry([
    createCSharpAnalyzer(),
    createJavaScriptAnalyzer(),
    createJavaAnalyzer(),
    createRustAnalyzer(),
    createCppAnalyzer(),
    createServiceFabricAnalyzer(),
  ]);
}
