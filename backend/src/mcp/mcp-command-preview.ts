/** A redacted argument display, not a shell command to evaluate. */
export function mcpCommandPreview(spec: Record<string, unknown>): string | undefined {
  if (typeof spec.command !== 'string' || !Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string')) return undefined;
  const display = (arg: string): string => {
    const clean = arg.replace(/[\u0000-\u001f\u007f]/g, '?');
    return /^[A-Za-z0-9_.:/\\-]+$/.test(clean) ? clean : `"${clean.replace(/"/g, '\\"')}"`;
  };
  let secret = false;
  const args = (spec.args as string[]).map((arg) => {
    if (secret) { secret = false; return '<redacted>'; }
    if (/^--[^=]*(?:token|secret|password|credential|connection-string|api-key|header)/i.test(arg)) {
      const equal = arg.indexOf('=');
      if (equal >= 0) return `${arg.slice(0, equal)}=<redacted>`;
      secret = true;
      return arg;
    }
    return arg.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
      .replace(/([?&](?:[^=&]*(?:token|secret|password|signature|credential)|sig|code)=)[^&#\s"'<>]*/gi, '$1<redacted>');
  });
  return [display(spec.command), ...args.map(display)].join(' ');
}
