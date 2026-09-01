import { describe, it, expect, vi } from 'vitest';
import {
  createMetaSettingsRoutes,
  type MetaSettingsView,
} from './meta-settings-controller.js';
import { ValidationError } from '../kernel/error-types.js';
import type { HttpRequest } from './http-contract.js';

const view: MetaSettingsView = {
  providerId: 'agency',
  model: 'auto',
  warmPoolEnabled: true,
};

function req(body: unknown): HttpRequest {
  return { params: {}, query: {}, body };
}

function routesFor(update = vi.fn(() => view)) {
  const routes = createMetaSettingsRoutes({ get: () => view, update });
  const get = routes.find((r) => r.method === 'get')!;
  const put = routes.find((r) => r.method === 'put')!;
  return { get, put, update };
}

describe('createMetaSettingsRoutes', () => {
  it('exposes the current settings on GET /meta/settings', () => {
    const { get } = routesFor();
    expect(get.path).toBe('/meta/settings');
    expect(get.handler(req(undefined))).toEqual({ status: 200, body: view });
  });

  it('applies a provider + model patch on PUT', () => {
    const updated: MetaSettingsView = {
      providerId: 'copilot',
      model: 'gpt-5',
      warmPoolEnabled: true,
    };
    const update = vi.fn(() => updated);
    const { put } = routesFor(update);
    expect(put.method).toBe('put');
    expect(put.path).toBe('/meta/settings');
    expect(put.handler(req({ providerId: 'copilot', model: 'gpt-5' }))).toEqual({
      status: 200,
      body: updated,
    });
    expect(update).toHaveBeenCalledWith({
      providerId: 'copilot',
      model: 'gpt-5',
    });
  });

  it('applies a model-only patch', () => {
    const { put, update } = routesFor();
    put.handler(req({ model: 'gpt-5' }));
    expect(update).toHaveBeenCalledWith({ model: 'gpt-5' });
  });

  it('rejects a non-object body', () => {
    const { put } = routesFor();
    expect(() => put.handler(req('nope'))).toThrow(ValidationError);
    expect(() => put.handler(req(['a']))).toThrow(ValidationError);
  });

  it('rejects blank provider or model values', () => {
    const { put } = routesFor();
    expect(() => put.handler(req({ providerId: '   ' }))).toThrow(
      ValidationError,
    );
    expect(() => put.handler(req({ model: 42 }))).toThrow(ValidationError);
  });

  it('rejects an empty patch with no fields', () => {
    const { put, update } = routesFor();
    expect(() => put.handler(req({}))).toThrow(ValidationError);
    expect(update).not.toHaveBeenCalled();
  });
});
