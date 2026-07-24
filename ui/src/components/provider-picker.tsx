import type { ProviderInfo } from '../lib/types.js';

export function ProviderPicker({
  providers,
  value,
  onChange,
}: {
  providers: ProviderInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="field picker-field">
      <label htmlFor="provider-picker">Provider</label>
      <select
        id="provider-picker"
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.id}
          </option>
        ))}
      </select>
    </div>
  );
}
