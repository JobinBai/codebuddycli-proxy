'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FunctionCallParser,
  PersistentSessionPool,
  PoolQueueTimeoutError,
  RequestTimingTrace,
  ToolCallStripper,
  extractFunctionCalls,
  messagesToPrompt,
  runCodebuddy,
  setQueryImplementation,
  usageToOpenAI,
} = require('../server');

test('aggregates request timing milestones without logging request or response content', () => {
  let now = 1000;
  const logs = [];
  const trace = new RequestTimingTrace({
    requestId: 'chatcmpl-test',
    model: 'hy3',
    stream: true,
    promptChars: 178,
    startedAtMs: 1000,
    startedAt: '2026-07-29T08:09:40.994Z',
    now: () => now,
    log: (line) => logs.push(JSON.parse(line)),
  });

  now = 1001;
  trace.markQueryCreated();
  now = 1010;
  trace.observe({ type: 'system' });
  now = 1020;
  trace.observe({ type: 'stream_event', event: { type: 'message_start' } });
  now = 1030;
  trace.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ab' } } });
  now = 1045;
  trace.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'cdef' } } });
  now = 1050;
  trace.observe({ type: 'assistant' });
  now = 1060;
  trace.observe({ type: 'result', duration_ms: 58, duration_api_ms: 55 });
  now = 1062;
  trace.finish('success');
  trace.finish('cancelled');

  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: 'codebuddy_request_timing',
    timestamp: '2026-07-29T08:09:40.994Z',
    request_id: 'chatcmpl-test',
    model: 'hy3',
    stream: true,
    outcome: 'success',
    prompt_chars: 178,
    queue_wait_ms: null,
    backend_worker: null,
    backend_generation: null,
    backend_reused: null,
    total_ms: 62,
    request_parsed_ms: 0,
    sdk_query_created_ms: 1,
    first_sdk_message_ms: 10,
    sdk_system_ms: 10,
    first_stream_event_ms: 20,
    first_text_delta_ms: 30,
    last_text_delta_ms: 45,
    assistant_ms: 50,
    result_ms: 60,
    text_stream_ms: 15,
    stream_event_count: 3,
    text_delta_count: 2,
    text_delta_chars: 6,
    max_text_delta_chars: 4,
    max_text_delta_gap_ms: 15,
    duration_ms: 58,
    duration_api_ms: 55,
    non_api_ms: 3,
  });
  assert.doesNotMatch(JSON.stringify(logs[0]), /ab|cdef/);
});

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

test('streams normal text immediately instead of buffering an arbitrary suffix', () => {
  const parser = new ToolCallStripper();
  assert.equal(parser.push('normal text'), 'normal text');
  assert.equal(parser.flush(), '');
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

test('SDK backend streams partial text while disabling server-side tools, MCP, settings, and persistence', async () => {
  let input;
  setQueryImplementation((params) => {
    input = params;
    const messages = (async function* () {
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } };
      yield { type: 'result', is_error: false, result: 'ok', usage: {} };
    })();
    messages.interrupt = async () => {};
    return messages;
  });
  const chunks = [];
  const partialChunks = [];
  const runner = runCodebuddy('hello', 'auto', {
    onTextDelta: (text) => chunks.push(text),
    onPartialTextDelta: (text) => partialChunks.push(text),
    onResult: () => {},
  }, 'system');
  await runner.done;
  setQueryImplementation();
  assert.deepEqual(chunks, ['ok']);
  assert.deepEqual(partialChunks, ['par']);
  assert.deepEqual(input.options.tools, []);
  assert.deepEqual(input.options.mcpServers, {});
  assert.equal(input.options.strictMcpConfig, true);
  assert.equal(input.options.includePartialMessages, true);
  assert.equal(input.options.systemPrompt, 'system');
  assert.deepEqual(input.options.settingSources, []);
  assert.equal(input.options.extraArgs['no-session-persistence'], null);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class FakeSession {
  constructor(options, { blocked = false } = {}) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.blocked = blocked;
    this.gate = deferred();
    if (!blocked) this.gate.resolve();
    this.entered = false;
    this.prompts = [];
    this.models = [];
    this.connected = 0;
    this.closed = 0;
    this.cumulativeApiMs = 0;
    this.failPrompt = null;
  }

  async connect() { this.connected += 1; }
  async setModel(model) { this.models.push(model); }
  async interrupt() { this.gate.resolve(); }
  close() { this.closed += 1; this.gate.resolve(); }
  async send(prompt) { this.prompts.push(prompt); }

  async *stream() {
    const current = this.prompts.at(-1);
    if (current !== '/clear') {
      this.entered = true;
      await this.gate.promise;
    }
    if (current === this.failPrompt) throw new Error('stdout closed');
    this.cumulativeApiMs += current === '/clear' ? 100 : 20;
    yield {
      type: 'result',
      is_error: false,
      result: current === '/clear' ? '' : 'ok',
      duration_ms: 20,
      duration_api_ms: this.cumulativeApiMs,
      usage: {},
    };
  }
}

function runPool(pool, prompt, trace = null) {
  const output = { result: null, error: null };
  const runner = pool.run(prompt, 'hy3', {
    onResult: (result) => { output.result = result; },
    onError: (error) => { output.error = error; },
  }, 'rules', trace);
  return { runner, output };
}

test('persistent pool runs three requests concurrently and queues a fourth', async () => {
  const sessions = [];
  const pool = new PersistentSessionPool({
    size: 3,
    queueTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    create: (options) => {
      const session = new FakeSession(options, { blocked: true });
      sessions.push(session);
      return session;
    },
    rebuildDelayMs: 1,
  });
  await pool.start();

  const firstThree = [1, 2, 3].map((index) => runPool(pool, `request-${index}`));
  await eventually(() => sessions.filter((session) => session.entered).length === 3);
  assert.equal(pool.status.busy, 3);

  const fourth = runPool(pool, 'request-4');
  await eventually(() => pool.status.queued_requests === 1);
  assert.deepEqual(sessions.map((session) => session.prompts.length), [2, 2, 2]);

  sessions[0].gate.resolve();
  await fourth.runner.done;
  sessions.slice(1).forEach((session) => session.gate.resolve());
  await Promise.all(firstThree.map(({ runner }) => runner.done));
  await eventually(() => pool.status.available === 3);

  assert.equal(
    sessions.flatMap((session) => session.prompts).filter((prompt) => prompt !== '/clear').length,
    4
  );
  await pool.stop();
});

test('persistent pool bounds queue waiting', async () => {
  const sessions = [];
  const pool = new PersistentSessionPool({
    size: 1,
    queueTimeoutMs: 20,
    requestTimeoutMs: 1000,
    create: (options) => {
      const session = new FakeSession(options, { blocked: true });
      sessions.push(session);
      return session;
    },
    rebuildDelayMs: 1,
  });
  await pool.start();
  const active = runPool(pool, 'active');
  await eventually(() => sessions[0].entered);
  const queued = runPool(pool, 'queued');
  await queued.runner.done;

  assert.ok(queued.output.error instanceof PoolQueueTimeoutError);
  assert.equal(queued.output.error.statusCode, 503);
  sessions[0].gate.resolve();
  await active.runner.done;
  await eventually(() => pool.status.available === 1);
  await pool.stop();
});

test('persistent pool rebuilds only the failed worker and adjusts cumulative API time', async () => {
  const sessions = [];
  const pool = new PersistentSessionPool({
    size: 3,
    queueTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    create: (options) => {
      const session = new FakeSession(options);
      sessions.push(session);
      return session;
    },
    rebuildDelayMs: 1,
  });
  await pool.start();
  sessions[0].failPrompt = '【本次请求运行规则】\nrules\n\n【本次请求内容】\nfail';

  const failed = runPool(pool, 'fail');
  await failed.runner.done;
  assert.match(failed.output.error.message, /stdout closed/);

  const healthy = runPool(pool, 'healthy');
  await healthy.runner.done;
  assert.equal(healthy.output.result.duration_api_ms, 20);
  await eventually(() => sessions.length === 4);
  await eventually(() => pool.status.healthy === 3);

  assert.equal(sessions[0].closed, 1);
  assert.deepEqual(
    pool.status.workers.map((worker) => worker.generation).sort(),
    [1, 1, 2]
  );
  await eventually(() => pool.status.available === 3);
  await pool.stop();
});
