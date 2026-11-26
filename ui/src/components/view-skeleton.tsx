import { useStartupPending } from '../app/desktop-lifecycle.js';
import { BrandedLoader } from './loading.js';

/**
 * A lightweight placeholder shown while a lazily-loaded view chunk is fetched.
 * Shares the loading animation with data-loading panels.
 */
export function ViewSkeleton({ label }: { label?: string }) {
  useStartupPending(true);
  return <BrandedLoader title={label ? `Loading ${label}` : 'Loading'}
    detail="Preparing view components" />;
}
