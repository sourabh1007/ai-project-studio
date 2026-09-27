const lines = require('node:readline').createInterface({ input: process.stdin });
if (process.argv[2] === 'fail') {
  process.stderr.write("fixture executable cannot start: path with spaces");
  process.exit(1);
}
lines.on('line', (line) => {
  if (process.argv[2] === 'hang') return;
  const message = JSON.parse(line);
  if (process.argv[2] === 'challenge' && message.method === 'initialize') {
    process.stderr.write('To sign in, open https://microsoft.com/devicelogin and enter the code ABCD12345\n');
    return;
  }
  if (process.argv[2] === 'auth-error') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Authentication required' } }) + '\n');
    return;
  }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
    }) + '\n');
  } else if (message.method === 'tools/list') {
    if (process.argv[2] === 'pages') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: message.params.cursor === 'page2'
          ? { tools: [{ name: 'second_page_tool' }] }
          : { tools: [{ name: 'first_page_tool' }], nextCursor: 'page2' },
      }) + '\n');
      return;
    }
    if (process.argv[2] === 'cursor-loop') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [], nextCursor: 'same' } }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { tools: [{ name: 'fixture_tool', description: 'Harmless local protocol fixture' }] },
    }) + '\n');
  }
});
