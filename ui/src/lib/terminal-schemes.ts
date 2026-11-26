/**
 * Terminal color schemes — pure palette data for the embedded xterm sessions.
 * `studio-dark`/`studio-light` are the original app palettes; the rest are
 * well-known community schemes plus a few retro/neon looks. `auto` follows the
 * IDE color scheme and light/dark theme so the console matches its chrome.
 */

import type { ITheme } from '@xterm/xterm';
import type { ResolvedTheme } from './theme.js';

export type IdePalette =
  | 'default'
  | 'nord'
  | 'dracula'
  | 'solarized'
  | 'gruvbox'
  | 'tokyo-night'
  | 'matrix'
  | 'cyberpunk';

export const IDE_PALETTES: readonly IdePalette[] = [
  'default',
  'nord',
  'dracula',
  'solarized',
  'gruvbox',
  'tokyo-night',
  'matrix',
  'cyberpunk',
];

export type TerminalSchemeId =
  | 'studio-dark'
  | 'studio-light'
  | 'dracula'
  | 'monokai'
  | 'nord'
  | 'one-dark'
  | 'tokyo-night'
  | 'catppuccin'
  | 'solarized-dark'
  | 'solarized-light'
  | 'gruvbox-dark'
  | 'gruvbox-light'
  | 'github-light'
  | 'matrix'
  | 'amber-crt'
  | 'cyberpunk';

export type TerminalScheme = 'auto' | TerminalSchemeId;

interface SchemeDefinition {
  label: string;
  mode: ResolvedTheme;
  theme: ITheme;
}

type Ansi = [string, string, string, string, string, string, string, string];

function scheme(
  label: string,
  mode: ResolvedTheme,
  base: { background: string; foreground: string; cursor: string; selection: string },
  normal: Ansi,
  bright: Ansi,
): SchemeDefinition {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal;
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = bright;
  return {
    label,
    mode,
    theme: {
      background: base.background,
      foreground: base.foreground,
      cursor: base.cursor,
      cursorAccent: base.background,
      selectionBackground: base.selection,
      black, red, green, yellow, blue, magenta, cyan, white,
      brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
    },
  };
}

const SCHEMES: Record<TerminalSchemeId, SchemeDefinition> = {
  'studio-dark': scheme('Studio dark', 'dark',
    { background: '#0a0f1e', foreground: '#d7e2f7', cursor: '#818cf8', selection: 'rgba(129, 140, 248, 0.3)' },
    ['#0a0f1e', '#ff6b6b', '#5ff2a0', '#ffd479', '#7aa2ff', '#d78bff', '#5fd7e0', '#c9d6ef'],
    ['#8b98c2', '#ff8787', '#7ff5b4', '#ffe0a3', '#9db8ff', '#e3a7ff', '#8ce7ee', '#f4f7ff']),
  'studio-light': scheme('Studio light', 'light',
    { background: '#ffffff', foreground: '#0f172a', cursor: '#4f46e5', selection: 'rgba(79, 70, 229, 0.20)' },
    ['#000000', '#cd3131', '#00a33f', '#946b00', '#0451a5', '#a5289c', '#0598a6', '#4b5563'],
    ['#64748b', '#cd3131', '#14953b', '#8a7100', '#0451a5', '#a5289c', '#0598a6', '#1f2937']),
  dracula: scheme('Dracula', 'dark',
    { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selection: 'rgba(68, 71, 90, 0.9)' },
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  monokai: scheme('Monokai', 'dark',
    { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selection: 'rgba(73, 72, 62, 0.9)' },
    ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2'],
    ['#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  nord: scheme('Nord', 'dark',
    { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selection: 'rgba(67, 76, 94, 0.9)' },
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  'one-dark': scheme('One Dark', 'dark',
    { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selection: 'rgba(62, 68, 81, 0.9)' },
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  'tokyo-night': scheme('Tokyo Night', 'dark',
    { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selection: 'rgba(51, 70, 124, 0.8)' },
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
    ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  catppuccin: scheme('Catppuccin Mocha', 'dark',
    { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: 'rgba(88, 91, 112, 0.8)' },
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
    ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  'solarized-dark': scheme('Solarized dark', 'dark',
    { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selection: 'rgba(7, 54, 66, 0.9)' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#586e75', '#cb4b16', '#93a1a1', '#b58900', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  'solarized-light': scheme('Solarized light', 'light',
    { background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', selection: 'rgba(147, 161, 161, 0.35)' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#586e75'],
    ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#2aa198', '#073642']),
  'gruvbox-dark': scheme('Gruvbox dark', 'dark',
    { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selection: 'rgba(80, 73, 69, 0.9)' },
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
    ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  'gruvbox-light': scheme('Gruvbox light', 'light',
    { background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', selection: 'rgba(213, 196, 161, 0.8)' },
    ['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64'],
    ['#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836']),
  'github-light': scheme('GitHub light', 'light',
    { background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selection: 'rgba(9, 105, 218, 0.2)' },
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
  matrix: scheme('Matrix', 'dark',
    { background: '#020a04', foreground: '#39ff6a', cursor: '#39ff6a', selection: 'rgba(57, 255, 106, 0.25)' },
    ['#020a04', '#ff5f56', '#39ff6a', '#c8ff5a', '#34c38f', '#7dffb0', '#5fffd7', '#a8ffbf'],
    ['#3f8a52', '#ff8a80', '#7dff9b', '#e4ff8c', '#6be3b0', '#b0ffd0', '#9effe6', '#e6ffec']),
  'amber-crt': scheme('Amber CRT', 'dark',
    { background: '#120b02', foreground: '#ffb000', cursor: '#ffcc33', selection: 'rgba(255, 176, 0, 0.25)' },
    ['#120b02', '#ff6a3d', '#ffc94d', '#ffd75e', '#e6a23c', '#ff9c5a', '#ffd38a', '#ffcf7a'],
    ['#9a6c18', '#ff8f66', '#ffe08a', '#ffeb99', '#ffc266', '#ffb685', '#ffe5b3', '#fff1d6']),
  cyberpunk: scheme('Cyberpunk neon', 'dark',
    { background: '#0d0221', foreground: '#e0e0ff', cursor: '#ff2a6d', selection: 'rgba(255, 42, 109, 0.3)' },
    ['#0d0221', '#ff2a6d', '#05ffa1', '#f9f871', '#01cdfe', '#b967ff', '#00fff9', '#d1d7ff'],
    ['#7b6ba5', '#ff6b9a', '#4dffbe', '#fbfca0', '#5ce1ff', '#d29bff', '#7afffb', '#ffffff']),
};

export const TERMINAL_SCHEMES: readonly TerminalScheme[] = [
  'auto',
  ...(Object.keys(SCHEMES) as TerminalSchemeId[]),
];

/** The scheme each IDE palette pairs with when the terminal follows the IDE. */
const PALETTE_SCHEMES: Record<IdePalette, Partial<Record<ResolvedTheme, TerminalSchemeId>>> = {
  default: {},
  nord: { dark: 'nord' },
  dracula: { dark: 'dracula' },
  solarized: { dark: 'solarized-dark', light: 'solarized-light' },
  gruvbox: { dark: 'gruvbox-dark', light: 'gruvbox-light' },
  'tokyo-night': { dark: 'tokyo-night' },
  matrix: { dark: 'matrix' },
  cyberpunk: { dark: 'cyberpunk' },
};

/** Resolve `auto` against the IDE palette and theme; explicit picks pass through. */
export function resolveTerminalScheme(
  scheme: TerminalScheme,
  palette: IdePalette,
  theme: ResolvedTheme,
): TerminalSchemeId {
  if (scheme !== 'auto') return scheme;
  return PALETTE_SCHEMES[palette][theme] ?? (theme === 'light' ? 'studio-light' : 'studio-dark');
}

/** The xterm theme for a scheme, optionally recolouring default foreground text. */
export function terminalTheme(id: TerminalSchemeId, foreground?: string | null): ITheme {
  const theme = SCHEMES[id].theme;
  return foreground ? { ...theme, foreground } : { ...theme };
}

export function terminalSchemeLabel(scheme: TerminalScheme): string {
  return scheme === 'auto' ? 'Match IDE' : SCHEMES[scheme].label;
}

export function terminalSchemeMode(id: TerminalSchemeId): ResolvedTheme {
  return SCHEMES[id].mode;
}
