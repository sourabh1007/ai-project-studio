export interface McpBuiltinRuntime {
  resolve(name: string, spec: Record<string, unknown>):
    | { supported: true; canonicalName?: string; launch: Record<string, unknown> }
    | { supported: false; reason: string };
}
