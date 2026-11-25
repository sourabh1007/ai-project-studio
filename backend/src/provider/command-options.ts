import { z } from 'zod';

export const commandTokenSchema = z.string().min(1).max(8192).regex(/^[^\x00-\x1f\x7f]+$/);
export const executableSchema = commandTokenSchema;
export const interactiveCommandSchema = commandTokenSchema.max(1024);

const RESERVED = new Set([
  '--', '-p', '--prompt', '--model', '--session-id', '--resume', '--continue', '-c',
  '--output-format', '--input-format', '--json', '--acp', '--stdio', '--interactive',
  '--attachment', '--append-system-prompt', '--system-prompt', '--verbose',
  '--no-color', '-s', '--silent', '--screen-reader',
  '--allow-all-tools', '--allow-all', '--available-tools', '--tools',
  '--allowedtools', '--disallowedtools', '--deny-tool', '--allow-tool',
  '--disable-builtin-mcps', '--disable-mcp-server', '--mcp-config', '--strict-mcp-config',
  '--additional-mcp-config', '--no-tools', '--permission-mode', '--dangerously-skip-permissions',
  '--enable-mcp-server', '--agent', '--add-dir',
  '--settings', '--setting-sources', '--config', '--config-dir', '--plugin-dir',
  '--resume-session-id', '-r', '-i', '-o', '--print', '--json-schema',
  '--mcp-server', '--auth-status', '--auth-login',
  '--auth', '--login', '--logout', '--token', '--api-key', '--version', '-v', '--help', '-h',
  'auth', 'login', 'logout',
]);

/** Optional arguments cannot change the app-owned session or wire protocol. */
export const optionalCommandArgsSchema = z.array(commandTokenSchema.refine(
  (arg) => {
    const flag = arg.split('=', 1)[0].toLowerCase();
    return !RESERVED.has(flag) && !/^-[pcsvhrio].+/i.test(flag);
  },
  'Argument is reserved for the application command protocol',
)).max(128);

export const versionCommandArgsSchema = z.array(commandTokenSchema).refine(
  (args) => ['--version', '-v', 'version'].includes(args[0]) &&
    optionalCommandArgsSchema.safeParse(args.slice(1)).success,
  'Version command must retain its version operation and safe optional arguments',
);

export const authStatusCommandArgsSchema = z.array(commandTokenSchema).refine(
  (args) => args[0] === 'auth' && args[1] === 'status' &&
    optionalCommandArgsSchema.safeParse(args.slice(2)).success,
  'Authentication status command must retain auth status',
);

export const authLoginCommandArgsSchema = z.array(commandTokenSchema).refine(
  (args) => args[0] === 'auth' && args[1] === 'login' &&
    optionalCommandArgsSchema.safeParse(args.slice(2)).success,
  'Authentication login command must retain auth login',
);
