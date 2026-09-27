/** This read-only surface never includes prompts, tool arguments or auth payloads. */
export function redactDebugText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '$1 [redacted]')
    .replace(/((?:["']?)(?:[\w-]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)[\w-]*)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[redacted]');
}
