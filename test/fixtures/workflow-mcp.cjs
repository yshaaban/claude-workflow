// Minimal stdio MCP server for the installed-CLI contract. The marker records
// actual executions so a replayed tool call is visible to the test.
const { appendFileSync } = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  if (method === 'initialize') {
    result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'workflow-fixture', version: '1' } };
  } else if (method === 'tools/list') {
    result = { tools: [{ name: 'record', description: 'Record a verification marker.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
  } else if (method === 'tools/call' && params.name === 'record') {
    appendFileSync(process.argv[2], params.arguments.value + '\n');
    result = { content: [{ type: 'text', text: 'MCP_EXECUTED' }] };
  } else if (method === 'ping') {
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
});
