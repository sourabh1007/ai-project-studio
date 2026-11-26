import { useEffect, useRef, type ReactNode } from 'react';
import { Card, Button, ErrorText } from '../../components/ui.js';
import { FontIcon, PaletteIcon, PlannerIcon, SessionIcon, ConfigIcon } from '../../components/icons.js';
import { useAppearanceSaveError } from '../../hooks/appearance-storage.js';
import { useTheme } from '../../hooks/use-theme.js';
import { useUiPreferences } from '../../hooks/use-ui-preferences.js';
import { themeModeLabel, type ResolvedTheme, type ThemeMode } from '../../lib/theme.js';
import {
  resolveTerminalScheme,
  terminalSchemeLabel,
  terminalTheme,
} from '../../lib/terminal-schemes.js';
import {
  ACCENT_KEYS,
  APPEARANCES,
  DENSITIES,
  FONTS,
  IDE_PALETTES,
  MOTIONS,
  RADII,
  TEXT_SIZES,
  TERMINAL_FONTS,
  TERMINAL_LINE_HEIGHTS,
  TERMINAL_SCHEMES,
  TERMINAL_TEXT_SIZES,
  accentColor,
  accentSwatch,
  accentWasAdjusted,
  fontStack,
  isAccentKey,
  isHexColor,
  monoFontStack,
  optionLabel,
  parseAccentValue,
  type AccentKey,
  type IdePalette,
  type TerminalScheme,
} from '../../lib/ui-preferences.js';

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

/** A titled group of related appearance rows, introduced by an icon. */
function AppearanceGroup({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="appearance-group" aria-label={title}>
    <div className="appearance-group-heading">{icon}<span>{title}</span></div>
    {children}
  </section>;
}

/** Radio grid of visual preview cards; each card previews its own option. */
function PreviewGrid<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  itemLabel,
  preview,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  itemLabel: (value: T) => string;
  preview: (value: T) => ReactNode;
}) {
  return (
    <div className="appearance-row appearance-row-stacked">
      <div className="appearance-row-head">
        <span className="appearance-row-label">{label}</span>
        {hint && <span className="appearance-row-hint">{hint}</span>}
      </div>
      <div className="preview-grid" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            aria-label={`${label} ${itemLabel(option)}`}
            title={itemLabel(option)}
            className={`preview-card${value === option ? ' is-active' : ''}`}
            onClick={() => onChange(option)}
          >
            {preview(option)}
            <span className="preview-card-label">{itemLabel(option)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A miniature IDE rendered with the palette's own tokens via data attributes. */
function PalettePreview({ palette, theme }: { palette: IdePalette; theme: ResolvedTheme }) {
  return <span className="palette-preview" data-palette={palette} data-theme={theme} aria-hidden="true">
    <span className="palette-preview-dock" />
    <span className="palette-preview-side"><i /><i /><i /></span>
    <span className="palette-preview-main"><i /><i className="is-accent" /><i /></span>
    <span className="palette-preview-status" />
  </span>;
}

function FontPreview({ stack, sample }: { stack: string; sample: string }) {
  return <span className="font-preview" style={{ fontFamily: stack }} aria-hidden="true">{sample}</span>;
}

/** A tiny console showing the scheme's background, text and ANSI colours. */
function SchemePreview({ scheme, palette, theme }: { scheme: TerminalScheme; palette: IdePalette; theme: ResolvedTheme }) {
  const colors = terminalTheme(resolveTerminalScheme(scheme, palette, theme));
  return <span className="scheme-preview" style={{ background: colors.background, color: colors.foreground }} aria-hidden="true">
    <span><b style={{ color: colors.green }}>$</b> npm test</span>
    <span className="scheme-preview-dots">
      {[colors.red, colors.green, colors.yellow, colors.blue, colors.magenta, colors.cyan].map((color, index) =>
        <i key={index} style={{ background: color }} />)}
    </span>
  </span>;
}

/** A labelled on/off switch row for a boolean appearance preference. */
function PlannerToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="appearance-row appearance-toggle">
      <div className="appearance-row-head">
        <span className="appearance-row-label">{label}</span>
        <span className="appearance-row-hint">{hint}</span>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </label>
  );
}


/** Fallback swatch shown in the terminal colour picker while on the theme default. */
const TERMINAL_DEFAULT_SWATCH = '#d7e2f7';

function Segmented<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  render,
  itemAriaLabel,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  render?: (value: T) => string;
  itemAriaLabel?: (value: T) => string;
}) {
  return (
    <div className="appearance-row">
      <div className="appearance-row-head">
        <span className="appearance-row-label">{label}</span>
        {hint && <span className="appearance-row-hint">{hint}</span>}
      </div>
      <div
        className="segmented"
        role="radiogroup"
        aria-label={label}
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            aria-label={itemAriaLabel ? itemAriaLabel(option) : undefined}
            className={`segmented-item${value === option ? ' is-active' : ''}`}
            onClick={() => onChange(option)}
          >
            {render ? render(option) : optionLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * "Appearance" settings — a fully customizable UI: theme, accent colour, text
 * size, density, corner radius, motion and font. Every change is applied live
 * (via CSS custom properties on `<html>`) and persisted, so the user can shape
 * the IDE to their needs and it survives restarts.
 */
export function AppearanceSection({ embedded }: { embedded?: boolean } = {}) {
  const { mode, theme, setMode } = useTheme();
  const { prefs, setPrefs, reset } = useUiPreferences();
  const saveError = useAppearanceSaveError();
  const embeddedHeadingRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!embedded) return;
    const host = embeddedHeadingRef.current?.closest('.settings-collapsible-body');
    if (!host || host.querySelector('[data-embedded-heading="appearance"]')) return;
    const heading = document.createElement('h2');
    heading.className = 'sr-only';
    heading.dataset.embeddedHeading = 'appearance';
    heading.textContent = 'Appearance';
    host.prepend(heading);
    return () => heading.remove();
  }, [embedded]);

  const body = (
    <>
      <ErrorText error={saveError ? `Appearance changes could not be saved: ${saveError}` : null} />
      {embedded && <span ref={embeddedHeadingRef} hidden />}
      {embedded && (
        <div className="appearance-embedded-actions">
          <p className="settings-section-sub">
            Personalize the look and feel. Changes apply instantly and are
            remembered across restarts.
          </p>
          <Button variant="ghost" onClick={reset}>
            Reset to defaults
          </Button>
        </div>
      )}

      <AppearanceGroup icon={<PaletteIcon size={15} />} title="Look & colors">
      <Segmented<(typeof APPEARANCES)[number]>
        label="Appearance"
        hint="Clarity adds stronger contrast and panel hierarchy without changing typography"
        value={prefs.appearance}
        options={APPEARANCES}
        onChange={(appearance) => setPrefs({ appearance })}
      />

      <Segmented<ThemeMode>
        label="Theme"
        hint="Follow the OS or pick light/dark"
        value={mode}
        options={THEME_MODES}
        onChange={setMode}
        render={themeModeLabel}
      />

      <PreviewGrid<IdePalette>
        label="IDE color scheme"
        hint="Recolors panels, sidebars and the status bar in both light and dark themes"
        value={prefs.palette}
        options={IDE_PALETTES}
        onChange={(palette) => setPrefs({ palette })}
        itemLabel={(palette) => palette === 'default' ? 'Studio default' : optionLabel(palette)}
        preview={(palette) => <PalettePreview palette={palette} theme={theme} />}
      />

      <div className="appearance-row">
        <div className="appearance-row-head">
          <span className="appearance-row-label">Accent color</span>
          <span className="appearance-row-hint">
            Used for highlights, primary actions and running states
          </span>
        </div>
        <div className="accent-picker">
          <div className="accent-swatches" role="radiogroup" aria-label="Accent color">
            {ACCENT_KEYS.map((accent: AccentKey) => (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={prefs.accent === accent}
                aria-label={optionLabel(accent)}
                title={optionLabel(accent)}
                className={`accent-swatch${
                  prefs.accent === accent ? ' is-active' : ''
                }`}
                style={{ background: accentColor(accent, theme) }}
                onClick={() => setPrefs({ accent })}
              />
            ))}
            <label
              className={`accent-swatch accent-swatch-custom${
                isAccentKey(prefs.accent) ? '' : ' is-active'
              }`}
              title="Custom color"
              style={
                isAccentKey(prefs.accent)
                  ? undefined
                  : { background: accentSwatch(prefs.accent, theme) }
              }
            >
              <span className="sr-only">Custom accent color</span>
              <input
                type="color"
                className="accent-color-input"
                aria-label="Custom accent color"
                value={accentSwatch(prefs.accent, theme)}
                onChange={(event) => setPrefs({ accent: event.target.value })}
              />
            </label>
          </div>
          <div className="accent-hex">
            <span className="accent-hex-prefix" aria-hidden="true">
              #
            </span>
            <input
              type="text"
              className="accent-hex-input"
              aria-label="Accent color hex value"
              spellCheck={false}
              maxLength={6}
              value={accentSwatch(prefs.accent, theme).slice(1)}
              onChange={(event) => {
                const parsed = parseAccentValue(`#${event.target.value}`);
                if (parsed) {
                  setPrefs({ accent: parsed });
                }
              }}
            />
          </div>
        </div>
      </div>
      {accentWasAdjusted(prefs.accent, theme) && (
        <p className="accent-adjusted-note" role="status">
          Lightened for contrast in the {theme} theme so text stays readable —
          your hue is preserved.
        </p>
      )}
      </AppearanceGroup>

      <AppearanceGroup icon={<FontIcon size={15} />} title="Typography">
      <PreviewGrid
        label="Interface font"
        hint="Bundled with the app, so every choice renders the same offline"
        value={prefs.font}
        options={FONTS}
        onChange={(font) => setPrefs({ font })}
        itemLabel={(font) => font === 'system' ? 'Segoe UI (system)' : optionLabel(font)}
        preview={(font) => <FontPreview stack={fontStack(font)} sample="Aa Build 42" />}
      />

      <PreviewGrid
        label="Code font"
        hint="Code blocks, diffs, paths and inline code across the IDE"
        value={prefs.codeFont}
        options={TERMINAL_FONTS}
        onChange={(codeFont) => setPrefs({ codeFont })}
        itemLabel={optionLabel}
        preview={(font) => <FontPreview stack={monoFontStack(font)} sample="{ 0O1lI } =>" />}
      />

      <Segmented
        label="Text size"
        value={prefs.textSize}
        options={TEXT_SIZES}
        onChange={(textSize) => setPrefs({ textSize })}
      />
      </AppearanceGroup>

      <AppearanceGroup icon={<ConfigIcon size={15} />} title="Layout & motion">

      <Segmented
        label="Density"
        hint="Spacing and control sizes"
        value={prefs.density}
        options={DENSITIES}
        onChange={(density) => setPrefs({ density })}
      />

      <Segmented
        label="Corner radius"
        value={prefs.radius}
        options={RADII}
        onChange={(radius) => setPrefs({ radius })}
      />

      <Segmented
        label="Motion"
        hint="Transition and animation intensity"
        value={prefs.motion}
        options={MOTIONS}
        onChange={(motion) => setPrefs({ motion })}
      />
      </AppearanceGroup>

      <AppearanceGroup icon={<SessionIcon size={15} />} title="Console">
      <PreviewGrid<TerminalScheme>
        label="Console color scheme"
        hint="Match IDE follows the IDE color scheme and light/dark theme"
        value={prefs.terminalScheme}
        options={TERMINAL_SCHEMES}
        onChange={(terminalScheme) => setPrefs({ terminalScheme })}
        itemLabel={terminalSchemeLabel}
        preview={(scheme) => <SchemePreview scheme={scheme} palette={prefs.palette} theme={theme} />}
      />

      <PreviewGrid
        label="Terminal font"
        hint="Monospace family for session output; retro and pixel faces included"
        value={prefs.terminalFont}
        options={TERMINAL_FONTS}
        onChange={(terminalFont) => setPrefs({ terminalFont })}
        itemLabel={optionLabel}
        preview={(font) => <FontPreview stack={monoFontStack(font)} sample="$ git push" />}
      />

      <Segmented
        label="Terminal text size"
        value={prefs.terminalTextSize}
        options={TERMINAL_TEXT_SIZES}
        onChange={(terminalTextSize) => setPrefs({ terminalTextSize })}
        itemAriaLabel={(size) => `Terminal text size ${optionLabel(size)}`}
      />

      <Segmented
        label="Terminal line spacing"
        value={prefs.terminalLineHeight}
        options={TERMINAL_LINE_HEIGHTS}
        onChange={(terminalLineHeight) => setPrefs({ terminalLineHeight })}
        itemAriaLabel={(spacing) => `Terminal line spacing ${optionLabel(spacing)}`}
      />

      <div className="appearance-row">
        <div className="appearance-row-head">
          <span className="appearance-row-label">Terminal text color</span>
          <span className="appearance-row-hint">
            Recolors default (uncolored) terminal text; ANSI colors are
            preserved
          </span>
        </div>
        <div className="accent-picker">
          <div
            className="accent-swatches"
            role="radiogroup"
            aria-label="Terminal text color"
          >
            <button
              type="button"
              role="radio"
              aria-checked={prefs.terminalTextColor === 'theme'}
              className={`segmented-item${
                prefs.terminalTextColor === 'theme' ? ' is-active' : ''
              }`}
              onClick={() => setPrefs({ terminalTextColor: 'theme' })}
            >
              Scheme default
            </button>
            <label
              className={`accent-swatch accent-swatch-custom${
                isHexColor(prefs.terminalTextColor) ? ' is-active' : ''
              }`}
              title="Custom terminal text color"
              style={
                isHexColor(prefs.terminalTextColor)
                  ? { background: prefs.terminalTextColor }
                  : undefined
              }
            >
              <span className="sr-only">Custom terminal text color</span>
              <input
                type="color"
                className="accent-color-input"
                aria-label="Custom terminal text color"
                value={
                  isHexColor(prefs.terminalTextColor)
                    ? prefs.terminalTextColor
                    : TERMINAL_DEFAULT_SWATCH
                }
                onChange={(event) =>
                  setPrefs({ terminalTextColor: event.target.value })
                }
              />
            </label>
          </div>
        </div>
      </div>
      </AppearanceGroup>

      <AppearanceGroup icon={<PlannerIcon size={15} />} title="Planner quick-add">

      <PlannerToggle
        label="Autocorrect"
        hint="Fix common typos and normalize acronyms as you type"
        checked={prefs.plannerAutocorrect}
        onChange={(plannerAutocorrect) => setPrefs({ plannerAutocorrect })}
      />
      <PlannerToggle
        label="Suggestions"
        hint="Suggest previously used task titles while typing"
        checked={prefs.plannerAutosuggest}
        onChange={(plannerAutosuggest) => setPrefs({ plannerAutosuggest })}
      />
      <PlannerToggle
        label="Auto-format on add"
        hint="Tidy the title (trim, collapse spaces, capitalize) when adding"
        checked={prefs.plannerAutoformat}
        onChange={(plannerAutoformat) => setPrefs({ plannerAutoformat })}
      />
      </AppearanceGroup>
    </>
  );

  if (embedded) {
    return body;
  }

  return (
    <div className="settings-panel">
      <Card>
        <div className="page-header">
          <div className="page-header-main">
            <h2 className="settings-section-title">Appearance</h2>
            <p className="settings-section-sub">
              Personalize the look and feel. Changes apply instantly and are
              remembered across restarts.
            </p>
          </div>
          <Button variant="ghost" onClick={reset}>
            Reset to defaults
          </Button>
        </div>
        {body}
      </Card>
    </div>
  );
}
