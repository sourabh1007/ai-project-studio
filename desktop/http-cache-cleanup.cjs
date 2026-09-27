'use strict';

/** Electron owns live HTTP cache handles; never delete profile directories directly. */
function createHttpCacheCleanupHandler({ isTrustedSender, getSession, now, reportError }) {
  let pending = null;
  const result = (status, error = null) => ({
    status, scope: 'electron-http-cache', completedAt: now(), error,
  });
  return function clearHttpCache(event, ...args) {
    if (!isTrustedSender(event) || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame) {
      return Promise.resolve(result('failed', 'Only the trusted top-level application frame may clear HTTP cache.'));
    }
    if (args.length !== 0) {
      return Promise.resolve(result('failed', 'HTTP cache cleanup accepts no paths or options.'));
    }
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      try {
        const target = getSession();
        if (!target || typeof target.clearCache !== 'function') {
          return result('unavailable', 'Electron HTTP cache cleanup is unavailable in this shell.');
        }
        await target.clearCache();
        return result('completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message);
        return result('failed', `Electron HTTP cache cleanup failed: ${message}`);
      }
    }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createHttpCacheCleanupHandler };
