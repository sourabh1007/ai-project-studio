process.stderr.write('Authorization: Bearer ');

let remaining = 20_000;
function pumpNoise() {
  while (remaining > 0) {
    remaining -= 1;
    if (!process.stderr.write(`split-secret-${remaining}`)) {
      process.stderr.once('drain', pumpNoise);
      return;
    }
  }
  process.stderr.write('\n');
  process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
}

pumpNoise();
