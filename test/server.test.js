'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FunctionCallParser,
  ToolCallStripper,
  extractFunctionCalls,
  messagesToPrompt,
  runCodebuddy,
  setQueryImplementation,
  usageToOpenAI,
} = require('../server');

test('serializes OpenAI history and tool results into a stateless prompt', () => {
  const prompt = messagesToPrompt([
    { role: 'system', content: 'Reply in Chinese.' },
    { role: 'user', content: 'Find the weather.' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] },
    { role: 'tool', tool_call_id: 'call_weather', content: 'Sunny, 31C' },
    { role: 'user', content: 'Summarize it.' },
  ]);
  assert.match(prompt, /Reply in Chinese/);
  assert.match(prompt, /调用函数 weather/);
  assert.match(prompt, /Tool result for call_weather: Sunny, 31C/);
  assert.match(prompt, /Summarize it/);
});

test('parses a function call split across SDK assistant messages', () => {
  const content = [];
  const calls = [];
  const parser = new FunctionCallParser(new Set(['weather']), (text) => content.push(text), (call) => calls.push(call));
  parser.push('Before <function_call name="weather">{"city":"Sh');
  parser.push('anghai"}</function_call> after');
  parser.flush();
  assert.deepEqual(calls, [{ name: 'weather', arguments: '{"city":"Shanghai"}' }]);
  assert.equal(content.join(''), 'Before  after');
});

test('strips local tool wrappers without losing trailing stream content', () => {
  const parser = new ToolCallStripper();
  const first = parser.push('<tool_call name="Write">{"content":"hello"}</tool_call> world');
  const last = parser.flush();
  assert.equal(first + last, 'hello world');
});

test('extracts only declared function names and maps usage fields', () => {
  const parsed = extractFunctionCalls('<function_call name="ok">{}</function_call><function_call name="unknown">{}</function_call>', new Set(['ok']));
  assert.deepEqual(parsed.toolCalls, [{ name: 'ok', arguments: '{}' }]);
  assert.match(parsed.content, /unknown/);
  assert.deepEqual(usageToOpenAI({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 }), {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10,
  });
});

test('normalizes CodeBuddy parameter tool markup into OpenAI JSON arguments', () => {
  const parsed = extractFunctionCalls(
    '<tool_calls:6124c78e><tool_call:6124c78e>execute_sql"><parameter name="sql">SELECT COUNT(*) AS cnt FROM t_standard</parameter></invoke></tool_calls>',
    new Set(['execute_sql'])
  );
  assert.equal(parsed.content, '');
  assert.deepEqual(parsed.toolCalls, [{
    name: 'execute_sql',
    arguments: '{"sql":"SELECT COUNT(*) AS cnt FROM t_standard"}',
  }]);
});

test('SDK backend always disables server-side tools, MCP, settings, and persistence', async () => {
  let input;
  setQueryImplementation((params) => {
    input = params;
    const messages = (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } };
      yield { type: 'result', is_error: false, result: 'ok', usage: {} };
    })();
    messages.interrupt = async () => {};
    return messages;
  });
  const chunks = [];
  const runner = runCodebuddy('hello', 'auto', {
    onTextDelta: (text) => chunks.push(text),
    onResult: () => {},
  }, 'system');
  await runner.done;
  setQueryImplementation();
  assert.deepEqual(chunks, ['ok']);
  assert.deepEqual(input.options.tools, []);
  assert.deepEqual(input.options.mcpServers, {});
  assert.equal(input.options.strictMcpConfig, true);
  assert.deepEqual(input.options.settingSources, []);
  assert.equal(input.options.extraArgs['no-session-persistence'], null);
});
