const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://127.0.0.1:4319/api';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      BASE + path,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const feat = await post('/features', {
    name: 'Terminal smoke ' + Date.now(),
    description: 'headless ws terminal test',
  });
  console.log('feature:', feat.status, feat.body.id);

  const sess = await post(`/features/${feat.body.id}/terminal-sessions`, {
    providerId: 'copilot',
    model: 'auto',
    kind: 'dev',
  });
  console.log('session:', sess.status, sess.body.id, sess.body.status);

  const ws = new WebSocket(
    `ws://127.0.0.1:4319/api/terminal?sessionId=${sess.body.id}`,
  );
  let outputBytes = 0;
  let gotReady = false;

  ws.on('open', () => {
    console.log('ws open');
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'ready') {
      gotReady = true;
      console.log('READY sessionId=', msg.sessionId);
    } else if (msg.type === 'output') {
      outputBytes += msg.data.length;
    } else if (msg.type === 'exit') {
      console.log('EXIT code=', msg.code);
    }
  });
  ws.on('error', (e) => console.log('ws error', e.message));

  setTimeout(() => {
    console.log('gotReady=', gotReady, 'outputBytes=', outputBytes);
    // send a quit to the interactive CLI, then close
    ws.send(JSON.stringify({ type: 'input', data: '\u0003' }));
    setTimeout(() => {
      ws.close();
      setTimeout(() => process.exit(0), 500);
    }, 1500);
  }, 9000);
})();
