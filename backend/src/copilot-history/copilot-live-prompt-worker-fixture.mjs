// Test-only worker standing in for the real scan entry point; `input.path`
// selects the behaviour so the adapter's native-worker plumbing is exercised.
import { parentPort, workerData } from 'node:worker_threads';

const mode = workerData.input.path;
if (mode === 'ok') {
  parentPort.postMessage({ type: 'result', turn: { text: 'hi', at: '', response: null } });
} else if (mode === 'null') {
  parentPort.postMessage({ type: 'result', turn: null });
} else if (mode === 'fail') {
  parentPort.postMessage({ type: 'error', code: 'EBUSY', message: 'resource busy' });
} else if (mode === 'throw') {
  throw new Error('boom');
} else if (mode === 'exit') {
  process.exit(3);
} else {
  parentPort.postMessage({ type: 'started' });
  setInterval(() => undefined, 1000);
}
