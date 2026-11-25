import { describe, expect, it } from 'vitest';
import { authLoginCommandArgsSchema, authStatusCommandArgsSchema, commandTokenSchema, executableSchema, optionalCommandArgsSchema, versionCommandArgsSchema } from './command-options.js';
import { copilotConfigSchema, copilotDefaults } from './copilot-adapter/config.js';
import { agencyConfigSchema, agencyDefaults } from './agency-adapter/config.js';
import { claudeConfigSchema, claudeDefaults } from './claude-adapter/config.js';
import { buildCopilotArgs, buildCopilotInteractiveArgs } from './copilot-adapter/copilot-cmd-builder.js';
import { buildAgencyCommand } from './agency-adapter/agency-cmd-builder.js';
import { buildClaudeArgs } from './claude-adapter/claude-commands.js';
import { buildClaudeInstallCommand } from './claude-adapter/claude-commands.js';
import { createCopilotMcpSupport } from './copilot-adapter/copilot-mcp-support.js';
import { buildPlanUsageProbeCommand } from '../plan-usage/plan-usage-command.js';
import { metaConfigSchema, metaDefaults } from '../meta/config.js';
import { planUsageConfigSchema, planUsageDefaults } from '../plan-usage/config.js';
import { agencyInstallCommand } from '../agency-bootstrap/agency-install-command.js';
import { copilotInstallCommand } from '../copilot-bootstrap/copilot-install-command.js';
import { buildGhInstallPlan } from '../self-heal/gh-install.js';
import { agencyBootstrapConfigSchema, agencyBootstrapDefaults } from '../agency-bootstrap/config.js';
import { copilotBootstrapConfigSchema, copilotBootstrapDefaults } from '../copilot-bootstrap/config.js';
import { selfHealConfigSchema, selfHealDefaults } from '../self-heal/config.js';
import type { SessionSpec } from './provider-contract.js';

const spec: SessionSpec = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000', featureId: 'f', prompt: 'hello',
  model: 'auto', kind: 'dev', otelFilePath: 'usage.jsonl', cwd: 'C:\\repo',
};

describe('bounded command configuration', () => {
  it.each(['--enable-mcp-server', '--enable-mcp-server=plugin:server', '--agent', '--add-dir'])(
    'does not let optional flags bypass the verified MCP inventory: %s', (flag) => {
      expect(optionalCommandArgsSchema.safeParse([flag]).success).toBe(false);
    },
  );
  it('accepts literal safe argv and executable paths with spaces, not shell fragments', () => {
    expect(optionalCommandArgsSchema.parse(['--effort=high', '--debug', 'C:\\a b\\file', 'value; literal'])).toHaveLength(4);
    expect(executableSchema.parse('C:\\Program Files\\cli.exe')).toBe('C:\\Program Files\\cli.exe');
    expect(optionalCommandArgsSchema.parse([])).toEqual([]);
    expect(optionalCommandArgsSchema.safeParse(Array(129).fill('value')).success).toBe(false);
    expect(commandTokenSchema.safeParse('x'.repeat(8193)).success).toBe(false);
  });

  it.each([
    '--', '-p', '-phello', '--prompt', '--model=x', '--session-id=x', '--resume=x',
    '--continue', '-c', '-s', '-v', '-h', '--output-format=json', '--input-format=json',
    '--json', '--acp=true', '--stdio', '--interactive', '--attachment=x',
    '--append-system-prompt=x', '--system-prompt=x', '--verbose', '--no-color',
    '--silent', '--screen-reader', '--allow-all-tools', '--allow-all', '--available-tools',
    '--tools', '--allowedTools=x', '--disallowedTools=x', '--deny-tool=x', '--allow-tool=x',
    '--disable-builtin-mcps', '--disable-mcp-server=x', '--mcp-config=x', '--strict-mcp-config',
    '--additional-mcp-config=x', '--no-tools', '--permission-mode=x', '--dangerously-skip-permissions',
    '--settings=x', '--setting-sources=x', '--config=x', '--config-dir=x', '--plugin-dir=x',
    '--resume-session-id=x', '-r', '-i', '-o', '--print', '--json-schema=x',
    '--mcp-server=x', '--auth-status', '--auth-login',
    '--auth', '--login', '--logout', '--token=x', '--api-key=x', '--version', '--help',
    'auth', 'login', 'logout', '', 'bad\0arg', 'bad\narg', 'bad\rarg', 'bad\targ', 'bad\x7farg',
  ])('rejects reserved aliases, equal forms and control characters: %j', (arg) => {
    expect(optionalCommandArgsSchema.safeParse([arg]).success).toBe(false);
  });

  it('retains the mandatory version/auth operation and validates optional suffixes', () => {
    for (const arg of ['--version', '-v', 'version']) {
      expect(versionCommandArgsSchema.parse([arg, '--debug'])).toEqual([arg, '--debug']);
    }
    for (const args of [[], ['--acp'], ['--version', '--acp']]) {
      expect(versionCommandArgsSchema.safeParse(args).success).toBe(false);
    }
    for (const [schema, operation] of [[authStatusCommandArgsSchema, 'status'], [authLoginCommandArgsSchema, 'login']] as const) {
      expect(schema.parse(['auth', operation, '--debug'])).toEqual(['auth', operation, '--debug']);
      for (const args of [[], ['auth'], ['other', operation], ['auth', 'other'], ['auth', operation, '--acp']]) {
        expect(schema.safeParse(args).success).toBe(false);
      }
    }
  });

  it('validates provider and probe configuration consistently', () => {
    for (const [schema, defaults] of [
      [copilotConfigSchema, copilotDefaults], [agencyConfigSchema, agencyDefaults], [claudeConfigSchema, claudeDefaults],
    ] as const) {
      expect(schema.safeParse(defaults).success).toBe(true);
      for (const key of ['extraArgs', 'headlessArgs', 'interactiveArgs']) {
        expect(schema.safeParse({ ...defaults, [key]: ['--session-id=evil'] }).success).toBe(false);
      }
      expect(schema.safeParse({ ...defaults, executable: 'bad\nexe' }).success).toBe(false);
    }
    expect(metaConfigSchema.safeParse(metaDefaults).success).toBe(true);
    for (const key of ['extraArgs', 'modelCatalogExtraArgs']) {
      expect(metaConfigSchema.safeParse({ ...metaDefaults, warmPool: { ...metaDefaults.warmPool, [key]: ['--acp'] } }).success).toBe(false);
    }
    expect(planUsageConfigSchema.safeParse(planUsageDefaults).success).toBe(true);
    expect(planUsageConfigSchema.safeParse({ ...planUsageDefaults, extraArgs: ['--model=x'] }).success).toBe(false);
    expect(agencyConfigSchema.safeParse({ ...agencyDefaults, subcommand: '--acp' }).success).toBe(false);
  });

  it('separates optional interactive/headless modes without changing required defaults', () => {
    const config = { ...copilotDefaults, extraArgs: ['--effort', 'high'], interactiveArgs: ['--banner'], headlessArgs: ['--debug'] };
    expect(buildCopilotArgs(spec, config).slice(-3)).toEqual(['--effort', 'high', '--debug']);
    expect(buildCopilotInteractiveArgs(spec, config).slice(-3)).toEqual(['--effort', 'high', '--banner']);
    const { interactiveArgs: _interactive, headlessArgs: _headless, ...legacy } = copilotDefaults;
    expect(buildCopilotArgs(spec, legacy)).toEqual(buildCopilotArgs(spec, copilotDefaults));
    expect(buildCopilotInteractiveArgs(spec, legacy)).toEqual(buildCopilotInteractiveArgs(spec, copilotDefaults));
    expect(buildAgencyCommand(spec, { ...agencyDefaults, headlessArgs: ['--debug'] }).args.at(-1)).toBe('--debug');
    expect(buildClaudeArgs(spec, { ...claudeDefaults, interactiveArgs: ['--debug'] }, true)[0]).toBe('--debug');
    expect(() => buildCopilotArgs(spec, { ...copilotDefaults, extraArgs: ['--available-tools=x'] })).toThrow();
    expect(() => buildCopilotInteractiveArgs(spec, { ...copilotDefaults, interactiveArgs: ['--session-id=x'] })).toThrow();
    expect(() => buildClaudeArgs(spec, { ...claudeDefaults, headlessArgs: ['--tools=x'] }, false)).toThrow();
  });

  it('configures quota argv and MCP reload without permitting a second protocol', () => {
    for (const providerId of ['copilot', 'agency']) {
      expect(buildPlanUsageProbeCommand({
        providerId, model: 'auto', sessionId: spec.sessionId, extraArgs: ['--debug'],
        copilot: { executable: 'copilot' }, agency: { executable: 'agency', subcommand: 'copilot' },
      }).args.at(-1)).toBe('--debug');
    }
    expect(createCopilotMcpSupport('/mcp reload').liveReloadCommand).toBe('/mcp reload');
    expect(() => createCopilotMcpSupport('/restart\n/login')).toThrow();
  });

  it('changes installer executable paths only, retaining the trusted payload and platform semantics', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const agency = { windowsExecutable: 'C:\\custom\\powershell.exe', posixExecutable: '/custom/sh' };
      const copilot = { windowsExecutable: 'C:\\custom\\cmd.exe', posixExecutable: '/custom/sh' };
      expect(agencyInstallCommand(platform, agency)).toEqual({ ...agencyInstallCommand(platform), command: platform === 'win32' ? agency.windowsExecutable : agency.posixExecutable });
      expect(copilotInstallCommand(platform, copilot)).toEqual({ ...copilotInstallCommand(platform), command: platform === 'win32' ? copilot.windowsExecutable : copilot.posixExecutable });
    }
    const gh = { wingetExecutable: 'C:\\custom\\winget.exe', brewExecutable: '/custom/brew' };
    expect(buildGhInstallPlan('win32', gh)).toEqual({ ...buildGhInstallPlan('win32'), command: gh.wingetExecutable });
    expect(buildGhInstallPlan('darwin', gh)).toEqual({ ...buildGhInstallPlan('darwin'), command: gh.brewExecutable });
    expect(buildGhInstallPlan('linux', gh)).toEqual(buildGhInstallPlan('linux'));
    const claude = { ...claudeDefaults, installWindowsExecutable: 'C:\\custom\\powershell.exe', installPosixExecutable: '/custom/bash' };
    expect(buildClaudeInstallCommand(claude, 'win32')).toEqual({ ...buildClaudeInstallCommand(claudeDefaults, 'win32'), command: claude.installWindowsExecutable });
    expect(buildClaudeInstallCommand(claude, 'linux')).toEqual({ ...buildClaudeInstallCommand(claudeDefaults, 'linux'), command: claude.installPosixExecutable });
    const { installWindowsExecutable: _windows, installPosixExecutable: _posix, ...legacy } = claudeDefaults;
    expect(buildClaudeInstallCommand(legacy, 'win32')).toEqual(buildClaudeInstallCommand(claudeDefaults, 'win32'));
    expect(buildClaudeInstallCommand(legacy, 'linux')).toEqual(buildClaudeInstallCommand(claudeDefaults, 'linux'));
    for (const [schema, defaults] of [
      [agencyBootstrapConfigSchema, agencyBootstrapDefaults], [copilotBootstrapConfigSchema, copilotBootstrapDefaults],
      [selfHealConfigSchema, selfHealDefaults],
    ] as const) {
      expect(schema.parse(defaults)).toEqual(defaults);
      expect(schema.safeParse(Object.fromEntries(Object.keys(defaults).map((key) => [key, 'bad\0exe']))).success).toBe(false);
    }
  });
});
