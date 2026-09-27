import { useId, useState } from 'react';
import { Button } from '../../components/ui.js';

interface CommandOption {
  flag: string;
  description: string;
  valueHint?: string;
  choices?: string[];
}

export interface McpCommandOptionsProps {
  options: CommandOption[];
  examples: string[];
  onChoose: (argument: string) => void;
  disabled?: boolean;
}

const flagPattern = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/;
const controlPattern = /[\u0000-\u001f\u007f\u2028\u2029]/;
const maxArgumentLength = 4096;

function quoteValue(value: string) {
  // This is a native argument fragment, never a shell command.
  return /^[a-zA-Z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value);
}

function OptionRow({ option, disabled, onChoose }: {
  option: CommandOption;
  disabled: boolean;
  onChoose: (argument: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const requiresValue = option.valueHint !== undefined || option.choices !== undefined;
  const choices = option.choices?.filter((choice) => choice.trim() && !controlPattern.test(choice));
  const hasChoices = Boolean(option.choices?.length);
  const fragment = requiresValue ? `${option.flag} ${quoteValue(value)}` : option.flag;
  const invalidValue = controlPattern.test(value) || fragment.length > maxArgumentLength;
  const canAdd = !disabled && !invalidValue && (!requiresValue
    || (value.trim().length > 0 && (!hasChoices || choices?.includes(value))));

  return <li className="mcp-tool-row">
    <div className="mcp-tool-text">
      <code className="mcp-tool-name">{option.flag}</code>
      {option.description && <p className="field-hint" id={`${id}-description`}>{option.description}</p>}
      {requiresValue && <div className="field">
        <label htmlFor={id}>Value for {option.flag}</label>
        {hasChoices ? <select id={id} className="input" value={value} disabled={disabled}
          aria-describedby={option.description ? `${id}-description` : undefined}
          onChange={(event) => setValue(event.target.value)}>
          <option value="">Choose a value</option>
          {Array.from(new Set(choices)).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select> : <input id={id} className="input" value={value} disabled={disabled}
          aria-describedby={option.description ? `${id}-description` : undefined}
          placeholder={option.valueHint || 'Value'} maxLength={maxArgumentLength}
          onChange={(event) => setValue(event.target.value)} />}
        {invalidValue && <p className="field-hint">Use a single-line value; the argument must fit within 4096 characters.</p>}
      </div>}
      <Button variant="ghost" disabled={!canAdd} onClick={() => { if (canAdd) onChoose(fragment); }}>
        Add {option.flag}
      </Button>
    </div>
  </li>;
}

export function McpCommandOptions({ options, examples, onChoose, disabled = false }: McpCommandOptionsProps) {
  const searchId = useId();
  const [search, setSearch] = useState('');
  const uniqueOptions = options.filter((option, index) => flagPattern.test(option.flag)
    && options.findIndex((candidate) => candidate.flag === option.flag) === index);
  const query = search.trim().toLowerCase();
  const matchingOptions = uniqueOptions.filter((option) =>
    `${option.flag} ${option.description} ${option.valueHint ?? ''} ${(option.choices ?? []).join(' ')}`
      .toLowerCase().includes(query));
  const safeExamples = Array.from(new Set(examples.filter((example) => !controlPattern.test(example))
    .map((example) => example.trim())
    .filter((example) => /^--[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|=|$)/.test(example)
      && example.length <= maxArgumentLength)));

  return <details>
    <summary>Options</summary>
    {safeExamples.length > 0 && <div className="field">
      <span className="field-hint">Examples</span>
      <div className="row">
        {safeExamples.map((example) => <Button key={example} variant="ghost" disabled={disabled}
          ariaLabel={`Use example ${example}`} onClick={() => { if (!disabled) onChoose(example); }}>
          <code>{example}</code>
        </Button>)}
      </div>
    </div>}
    {uniqueOptions.length > 0 ? <>
      <div className="field">
        <label htmlFor={searchId}>Search options</label>
        <input id={searchId} className="input" type="search" value={search} disabled={disabled}
          placeholder="Flag or description" onChange={(event) => setSearch(event.target.value)} />
      </div>
      {matchingOptions.length > 0 ? <ul className="mcp-tool-list" aria-label="Command options">
        {matchingOptions.map((option) => <OptionRow key={option.flag} option={option}
          disabled={disabled} onChoose={onChoose} />)}
      </ul> : <p className="field-hint" role="status">No matching options.</p>}
    </> : <p className="field-hint">No option suggestions available. Enter arguments above.</p>}
  </details>;
}
