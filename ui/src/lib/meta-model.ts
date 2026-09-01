import type { MetaSettings } from './types.js';

const PROVIDER_LABELS: Record<string, string> = {
  agency: 'Agency',
  copilot: 'Copilot',
};

/** Human label for a provider id (known ids get a nicer name). */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? (id.length > 0 ? id[0].toUpperCase() + id.slice(1) : id);
}

/** Human label for a model id; `auto` renders as `Auto`. */
export function modelLabel(model: string): string {
  return model === 'auto' ? 'Auto' : model;
}

/** Compact "Provider · Model" label for the status bar. */
export function metaModelLabel(
  settings: Pick<MetaSettings, 'providerId' | 'model'>,
): string {
  return `${providerLabel(settings.providerId)} · ${modelLabel(settings.model)}`;
}
