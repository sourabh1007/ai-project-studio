'use strict';

const MAX_RECOVERIES = 2;
const RESET_AFTER_MS = 60000;
const RECOVERY_DELAY_MS = 300;

function recoveryPage(url) {
  const href = url.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Studio interface recovery</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e5e7eb;font:16px system-ui}
main{max-width:38rem;padding:2rem}h1{font-size:1.5rem}p{line-height:1.6;color:#cbd5e1}
a{display:inline-block;padding:.75rem 1rem;border-radius:.5rem;background:#2563eb;color:white;text-decoration:none}
a:focus-visible{outline:3px solid white;outline-offset:4px}
</style></head><body><main>
<h1>Studio's interface stopped unexpectedly</h1>
<p>Automatic recovery has paused to avoid a reload loop. This does not delete your saved workspace.</p>
<p>Reloading may discard unsent input. You do not need to restart the backend.</p>
<a href="${href}">Reload interface</a>
</main></body></html>`);
}

function attachRendererRecovery({
  window: win, url, record, showFailure, confirmReload,
  canRecover = () => true, isQuitting = () => false,
  schedule = setTimeout, cancel = clearTimeout,
}) {
  const contents = win.webContents;
  let attempts = 0;
  let recoveryTimer = null;
  let stableTimer = null;
  let fallbackShown = false;
  let fallbackFailed = false;
  let prompting = false;
  let rendererVersion = 0;
  let disposed = false;
  const inactive = () => disposed || win.isDestroyed() || isQuitting();
  const clearStable = () => {
    if (stableTimer !== null) cancel(stableTimer);
    stableTimer = null;
  };
  const failed = (error) => {
    if (inactive()) return;
    record({ kind: 'renderer-recovery-failed', message: String(error) });
    showFailure();
  };
  const onGone = (_event, details) => {
    if (inactive() || details.reason === 'clean-exit' || recoveryTimer !== null) return;
    rendererVersion++;
    clearStable();
    const ready = canRecover();
    const action = !ready ? 'startup-failure'
      : fallbackShown ? 'native-fallback'
        : attempts < MAX_RECOVERIES ? 'reload' : 'recovery-page';
    record({ kind: 'renderer-exit', reason: details.reason, exitCode: details.exitCode, action });
    if (!ready) return;
    if (fallbackShown) {
      if (!fallbackFailed) {
        fallbackFailed = true;
        showFailure();
      }
      return;
    }
    const target = attempts < MAX_RECOVERIES ? url : recoveryPage(url);
    attempts++;
    fallbackShown = target !== url;
    recoveryTimer = schedule(() => {
      recoveryTimer = null;
      if (inactive()) return;
      try {
        void win.loadURL(target).catch(failed);
      } catch (error) {
        failed(error);
      }
    }, RECOVERY_DELAY_MS);
  };
  const onLoaded = () => {
    if (inactive() || contents.getURL() !== url) return;
    fallbackShown = false;
    fallbackFailed = false;
    clearStable();
    // Reset only after a healthy app document, not after loading the fallback.
    stableTimer = schedule(() => { attempts = 0; stableTimer = null; }, RESET_AFTER_MS);
    stableTimer.unref?.();
  };
  const onUnresponsive = async () => {
    if (inactive() || !canRecover() || prompting) return;
    record({ kind: 'renderer-unresponsive' });
    prompting = true;
    const observedVersion = rendererVersion;
    try {
      if (await confirmReload() && !inactive() && canRecover() && rendererVersion === observedVersion) {
        // A hung renderer may not process ordinary reloads or beforeunload.
        contents.forcefullyCrashRenderer();
      }
    } catch (error) {
      failed(error);
    } finally {
      prompting = false;
    }
  };
  const onResponsive = () => { rendererVersion++; };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearStable();
    if (recoveryTimer !== null) cancel(recoveryTimer);
    recoveryTimer = null;
    contents.removeListener('render-process-gone', onGone);
    contents.removeListener('did-finish-load', onLoaded);
    win.removeListener('unresponsive', onUnresponsive);
    win.removeListener('responsive', onResponsive);
    win.removeListener('closed', dispose);
  };
  contents.on('render-process-gone', onGone);
  contents.on('did-finish-load', onLoaded);
  win.on('unresponsive', onUnresponsive);
  win.on('responsive', onResponsive);
  win.once('closed', dispose);
  return dispose;
}

module.exports = { attachRendererRecovery, MAX_RECOVERIES, RESET_AFTER_MS, RECOVERY_DELAY_MS };
