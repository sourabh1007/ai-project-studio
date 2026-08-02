import type { ModelInfo } from '../lib/types.js';
import { Spinner } from './loading.js';

export function ModelPicker({
  models,
  value,
  onChange,
  loading,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
}) {
  return (
    <div className="field picker-field">
      <label htmlFor="model-picker">
        Model {loading && <Spinner size={12} label="Loading models" />}
      </label>
      <select
        id="model-picker"
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={loading || models.length === 0}
      >
        {loading && <option value="" />}
        {!loading &&
          models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
      </select>
    </div>
  );
}
