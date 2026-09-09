import { Card, Button } from '../../components/ui.js';
import { useTheme } from '../../hooks/use-theme.js';
import { useUiPreferences } from '../../hooks/use-ui-preferences.js';
import { themeModeLabel, type ThemeMode } from '../../lib/theme.js';
import {
  ACCENT_KEYS,
  DENSITIES,
  FONTS,
  MOTIONS,
  RADII,
  TEXT_SIZES,
  accentColor,
  accentSwatch,
  accentWasAdjusted,
  isAccentKey,
  optionLabel,
  parseAccentValue,
  type AccentKey,
} from '../../lib/ui-preferences.js';

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

function Segmented<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  render?: (value: T) => string;
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
export function AppearanceSection() {
  const { mode, theme, setMode } = useTheme();
  const { prefs, setPrefs, reset } = useUiPreferences();

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

        <Segmented<ThemeMode>
          label="Theme"
          hint="Follow the OS or pick light/dark"
          value={mode}
          options={THEME_MODES}
          onChange={setMode}
          render={themeModeLabel}
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

        <Segmented
          label="Text size"
          value={prefs.textSize}
          options={TEXT_SIZES}
          onChange={(textSize) => setPrefs({ textSize })}
        />

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

        <Segmented
          label="Font"
          value={prefs.font}
          options={FONTS}
          onChange={(font) => setPrefs({ font })}
        />
      </Card>
    </div>
  );
}
