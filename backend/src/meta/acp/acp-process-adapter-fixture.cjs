process.stderr.write('token=secret123\n');
process.stderr.write('Author');
process.stderr.write('ization: Bearer super-secret-token\n');
process.stderr.write('github_pat_1234567890_secret_secret\n');
process.stderr.write('plain stderr line\n');

let remaining = 50_000;
function pumpNoise() {
  while (remaining > 0) {
    remaining -= 1;
    if (!process.stderr.write(`noise-${remaining}\n`)) {
      process.stderr.once('drain', pumpNoise);
      return;
    }
  }
  process.stderr.write('tail-without-newline');
  process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
}

pumpNoise();
