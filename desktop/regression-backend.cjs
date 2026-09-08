'use strict';

// Deliberately imports no application/provider code and serves no production UI.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PROTOCOL } = require('./regression-isolation.cjs');

function start(env = process.env) {
  const root = env.CW_DESKTOP_SMOKE_ROOT;
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
  if (marker.protocol !== PROTOCOL || marker.token !== env.CW_DESKTOP_SMOKE_TOKEN) {
    throw new Error('Missing synthetic fixture identity');
  }
  const delay = Number(marker.readyDelayMs);
  if (!Number.isInteger(delay) || delay < 0 || delay > 5000) throw new Error('Invalid delay');
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/api/providers') {
      res.setHeader('Content-Type', 'application/json');
      res.end('[]');
    } else if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><title>Isolated desktop smoke</title></head>
        <body data-fixture="${marker.token}">Synthetic backend; no AI providers.</body></html>`);
    } else if (req.method === 'POST' && req.url === '/api/shutdown') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(202).end(JSON.stringify({ status: 'shutting-down' }));
      setImmediate(shutdown);
    } else {
      res.writeHead(404).end();
    }
  });
  let listenRequested = false;
  const ready = setTimeout(() => {
    listenRequested = true;
    server.listen(Number(env.CW__api__port), '127.0.0.1', () => {
    fs.writeFileSync(path.join(root, 'backend.json'), JSON.stringify({
      token: marker.token, pid: process.pid, port: server.address().port,
    }));
    });
  }, delay);
  const watchdog = setTimeout(() => process.exit(1), 90_000);
  let closing;
  const close = () => {
    if (closing) return closing;
    clearTimeout(ready);
    clearTimeout(watchdog);
    closing = new Promise((resolve, reject) => {
      if (!listenRequested) {
        resolve();
        return;
      }
      const finish = () => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      };
      if (server.listening) finish();
      else server.once('listening', finish);
    });
    return closing;
  };
  let shuttingDown;
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    shuttingDown = close().then(async () => {
      const nonce = env.CW_DESKTOP_SHUTDOWN_NONCE;
      if (nonce !== undefined) {
        if (!nonce.trim() || !process.send) throw new Error('Missing shutdown IPC identity');
        await new Promise((resolve, reject) => {
          process.send({ type: 'shutdown-complete', nonce }, (error) =>
            error ? reject(error) : resolve());
        });
      }
      process.exit(0);
    }).catch(() => {
      process.stderr.write('Synthetic backend shutdown was not confirmed.\n');
      process.exit(1);
    });
    return shuttingDown;
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.on('message', (message) => {
    const nonce = env.CW_DESKTOP_SHUTDOWN_NONCE;
    if (nonce && message?.type === 'shutdown-request' && message.nonce === nonce) {
      void shutdown();
    }
  });
  return { server, close };
}

if (require.main === module) start();
module.exports = { start };
