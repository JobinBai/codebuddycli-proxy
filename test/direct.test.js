'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHeaders,
  decodeJwtPayload,
  deriveIdentity,
  isTokenExpired,
  newTraceContext,
} = require('../lib/codebuddy-headers');
const { Session, SessionStore } = require('../lib/codebuddy-session');
const {
  aggregateChunks,
  CodebuddyClient,
  normalizeChatCompletionsUrl,
  parseSseStream,
  resolveEndpoint,
} = require('../lib/codebuddy-client');
const { normalizeChunk, resolveModel, sessionKeyOf } = require('../server');

// ---------- 构造一个结构真实的 JWT（仅用于测试，签名无意义）----------
function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;
const TEST_JWT = makeJwt({
  sub: '81919ef5-8ec1-4c89-9ae6-91f592b9845c',
  iss: 'https://www.codebuddy.cn/auth/realms/copilot',
  exp: FUTURE_EXP,
  preferred_username: '13260131837',
});

// ---------- 身份推导 ----------

test('decodes JWT payload and derives identity from sub/iss', () => {
  const payload = decodeJwtPayload(TEST_JWT);
  assert.equal(payload.sub, '81919ef5-8ec1-4c89-9ae6-91f592b9845c');

  const identity = deriveIdentity(TEST_JWT);
  assert.equal(identity.kind, 'jwt');
  assert.equal(identity.userId, '81919ef5-8ec1-4c89-9ae6-91f592b9845c');
  assert.equal(identity.domain, 'www.codebuddy.cn');
  assert.equal(identity.username, '13260131837');
});

test('falls back to anonymous identity for non-JWT api keys', () => {
  const identity = deriveIdentity('sk-test-demo-key');
  assert.equal(identity.kind, 'apiKey');
  assert.equal(identity.userId, 'anonymous_demo-key');
  assert.equal(identity.domain, undefined);
});

test('detects expired tokens with a safety margin', () => {
  const expired = makeJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(isTokenExpired(expired), true);
  assert.equal(isTokenExpired(TEST_JWT), false);
  // 非 JWT 无从判断，不应误判为过期
  assert.equal(isTokenExpired('sk-whatever'), false);
});

test('malformed tokens degrade gracefully instead of throwing', () => {
  assert.equal(decodeJwtPayload('not.a.jwt'), null);
  assert.equal(decodeJwtPayload(''), null);
  assert.doesNotThrow(() => deriveIdentity('a.b.c'));
});

// ---------- 请求头生成 ----------

test('builds the full CLI header set with identity derived from the token', () => {
  const session = new Session('k');
  const { messageId, trace } = session.nextRequest();
  const headers = buildHeaders({ token: TEST_JWT, session, messageId, trace });

  assert.equal(headers.authorization, `Bearer ${TEST_JWT}`);
  assert.equal(headers['x-user-id'], '81919ef5-8ec1-4c89-9ae6-91f592b9845c');
  assert.equal(headers['x-domain'], 'www.codebuddy.cn');
  assert.equal(headers['x-product'], 'SaaS');
  assert.equal(headers['x-codebuddy-request'], '1');
  assert.equal(headers['x-agent-intent'], 'craft');
  assert.equal(headers['x-agent-purpose'], 'conversation');
  assert.equal(headers['x-ide-type'], 'CLI');
  assert.equal(headers['x-private-data'], 'false');
  assert.equal(headers['x-requested-with'], 'XMLHttpRequest');
  assert.match(headers['user-agent'], /^CLI\/[\d.]+ CodeBuddy\/[\d.]+$/);
  // JWT 模式不应出现 X-API-Key
  assert.equal(headers['x-api-key'], undefined);
});

test('api key mode adds X-API-Key and omits X-Domain', () => {
  const session = new Session('k');
  const { messageId, trace } = session.nextRequest();
  const headers = buildHeaders({ token: 'sk-test-demo-key', session, messageId, trace });

  assert.equal(headers['x-api-key'], 'sk-test-demo-key');
  assert.equal(headers.authorization, 'Bearer sk-test-demo-key');
  assert.equal(headers['x-domain'], undefined);
  assert.equal(headers['x-user-id'], 'anonymous_demo-key');
});

test('request id and conversation message id are identical, as the CLI does', () => {
  const session = new Session('k');
  const { messageId, trace } = session.nextRequest();
  const headers = buildHeaders({ token: TEST_JWT, session, messageId, trace });

  assert.equal(headers['x-request-id'], headers['x-conversation-message-id']);
  assert.match(headers['x-request-id'], /^[0-9a-f]{32}$/);
});

test('trace headers stay mutually consistent', () => {
  const session = new Session('k');
  const { messageId, trace } = session.nextRequest();
  const headers = buildHeaders({ token: TEST_JWT, session, messageId, trace });

  const { traceId, spanId, parentSpanId } = trace;
  assert.equal(headers.traceparent, `00-${traceId}-${spanId}-01`);
  assert.equal(headers.b3, `${traceId}-${spanId}-1-${parentSpanId}`);
  assert.equal(headers['x-b3-traceid'], traceId);
  assert.equal(headers['x-b3-spanid'], spanId);
  assert.equal(headers['x-b3-parentspanid'], parentSpanId);
  assert.equal(headers['x-b3-sampled'], '1');
  assert.equal(headers['x-trace-id'], traceId);
  assert.match(traceId, /^[0-9a-f]{32}$/);
  assert.match(spanId, /^[0-9a-f]{16}$/);
});

test('header insertion order matches the captured CLI request', () => {
  const session = new Session('k');
  const { messageId, trace } = session.nextRequest();
  const keys = Object.keys(buildHeaders({ token: TEST_JWT, session, messageId, trace }));

  const expectedHead = [
    'accept',
    'content-type',
    'x-requested-with',
    'x-stainless-arch',
    'x-stainless-lang',
    'x-stainless-os',
    'x-stainless-package-version',
    'x-stainless-retry-count',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    'x-conversation-id',
    'x-conversation-request-id',
    'x-agent-intent',
    'x-agent-purpose',
    'x-ide-type',
    'x-ide-name',
    'x-ide-version',
    'x-private-data',
    'x-codebuddy-request',
    'x-request-id',
    'x-conversation-message-id',
    'traceparent',
  ];
  assert.deepEqual(keys.slice(0, expectedHead.length), expectedHead);
  // user-agent 恒为最后一个，与抓包一致
  assert.equal(keys[keys.length - 1], 'user-agent');
});

test('extraHeaders can override and delete headers', () => {
  const session = new Session('k');
  const { messageId, trace } = session.nextRequest();
  const headers = buildHeaders({
    token: TEST_JWT,
    session,
    messageId,
    trace,
    extraHeaders: { 'X-Custom': 'v1', 'x-product': null },
  });

  assert.equal(headers['x-custom'], 'v1');
  assert.equal(headers['x-product'], undefined);
});

test('rejects missing token or session', () => {
  const session = new Session('k');
  assert.throws(() => buildHeaders({ session, messageId: 'a' }), /token is required/);
  assert.throws(() => buildHeaders({ token: TEST_JWT, messageId: 'a' }), /session is required/);
  assert.throws(() => buildHeaders({ token: TEST_JWT, session }), /messageId is required/);
});

// ---------- 会话生命周期 ----------

test('conversation id is stable while request ids rotate', () => {
  const session = new Session('k');
  const a = session.nextRequest();
  const b = session.nextRequest();

  assert.notEqual(a.messageId, b.messageId);
  // 同一轮内 traceId 与 parentSpanId 保持不变，spanId 每请求一个
  assert.equal(a.trace.traceId, b.trace.traceId);
  assert.equal(a.trace.parentSpanId, b.trace.parentSpanId);
  assert.notEqual(a.trace.spanId, b.trace.spanId);
});

test('beginTurn rotates the turn-scoped identifiers only', () => {
  const session = new Session('k');
  const conversationId = session.conversationId;
  const firstTurn = session.conversationRequestId;
  const firstTrace = session.traceId;

  session.beginTurn();

  assert.equal(session.conversationId, conversationId, 'conversation id must survive turns');
  assert.notEqual(session.conversationRequestId, firstTurn);
  assert.notEqual(session.traceId, firstTrace);
  assert.equal(session.turnCount, 2);
});

test('session store reuses sessions by key and isolates unknown keys', () => {
  const store = new SessionStore();
  const a1 = store.acquire('user-a');
  const a2 = store.acquire('user-a');
  const b = store.acquire('user-b');

  assert.equal(a1.conversationId, a2.conversationId);
  assert.notEqual(a1.conversationId, b.conversationId);
  assert.equal(store.size, 2);
});

test('keyless callers get throwaway sessions that never pool', () => {
  const store = new SessionStore();
  const one = store.acquire(null);
  const two = store.acquire(null);

  assert.notEqual(one.conversationId, two.conversationId);
  assert.equal(store.size, 0);
});

test('expired sessions are swept and replaced', () => {
  const store = new SessionStore({ ttlMs: 10 });
  const first = store.acquire('k');
  first.lastUsedAt = Date.now() - 1000;

  const second = store.acquire('k');
  assert.notEqual(first.conversationId, second.conversationId);
});

test('session store evicts the oldest entry beyond capacity', () => {
  const store = new SessionStore({ maxSessions: 2 });
  store.acquire('a');
  store.acquire('b');
  store.acquire('c');

  assert.equal(store.size, 2);
  assert.equal(store.sessions.has('a'), false);
});

// ---------- URL 处理 ----------

test('normalizes duplicated chat/completions suffixes', () => {
  assert.equal(normalizeChatCompletionsUrl('https://x/v2'), 'https://x/v2/chat/completions');
  assert.equal(normalizeChatCompletionsUrl('https://x/v2/'), 'https://x/v2/chat/completions');
  assert.equal(
    normalizeChatCompletionsUrl('https://x/v2/chat/completions/chat/completions'),
    'https://x/v2/chat/completions',
  );
  assert.equal(normalizeChatCompletionsUrl('https://x/v2?a=1'), 'https://x/v2/chat/completions?a=1');
});

test('defaults to the internal copilot endpoint', () => {
  assert.equal(resolveEndpoint(), 'https://copilot.tencent.com/v2/chat/completions');
  assert.equal(resolveEndpoint('http://127.0.0.1:9099/v2'), 'http://127.0.0.1:9099/v2/chat/completions');
});

// ---------- SSE 解析与聚合 ----------

async function* sseSource(text, { chunkSize = 7 } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
}

test('parses SSE frames split across arbitrary chunk boundaries', async () => {
  const text = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n';
  const seen = [];
  for await (const chunk of parseSseStream(sseSource(text, { chunkSize: 3 }))) seen.push(chunk);

  assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
});

test('SSE parser stops at [DONE] and tolerates CRLF plus junk frames', async () => {
  const text = 'data: {"a":1}\r\n\r\n: heartbeat\r\n\r\ndata: not-json\r\n\r\ndata: [DONE]\r\n\r\ndata: {"a":9}\r\n\r\n';
  const seen = [];
  for await (const chunk of parseSseStream(sseSource(text))) seen.push(chunk);

  assert.deepEqual(seen, [{ a: 1 }], 'must not emit anything after [DONE]');
});

test('aggregates streamed deltas into a single completion', () => {
  const completion = aggregateChunks(
    [
      { id: 'c1', model: 'hy3', created: 100, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: '' }] },
      { id: 'c1', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: '' }] },
      { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'c1', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ],
    'hy3',
  );

  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0].message.content, 'Hello');
  assert.equal(completion.choices[0].finish_reason, 'stop');
  assert.equal(completion.usage.total_tokens, 7);
});

test('aggregation merges incremental tool call arguments', () => {
  const completion = aggregateChunks(
    [
      { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '{"a"' } }] } }] },
      { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: ':1}' } }] } }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
    'hy3',
  );

  const [call] = completion.choices[0].message.tool_calls;
  assert.equal(call.id, 'call_1');
  assert.equal(call.function.name, 'get_weather');
  assert.equal(call.function.arguments, '{"a":1}');
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
});

test('aggregation keeps reasoning content separate from content', () => {
  const completion = aggregateChunks(
    [
      { id: 'c', choices: [{ index: 0, delta: { reasoning_content: 'think' } }] },
      { id: 'c', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] },
    ],
    'hy3',
  );

  assert.equal(completion.choices[0].message.content, 'answer');
  assert.equal(completion.choices[0].message.reasoning_content, 'think');
});

// ---------- 客户端行为 ----------

test('client always forces stream:true because upstream rejects non-stream', async () => {
  let captured;
  const client = new CodebuddyClient({
    token: TEST_JWT,
    baseUrl: 'http://example.test/v2',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });

  const completion = await client.createCompletion(
    { model: 'hy3', messages: [{ role: 'user', content: 'hi' }], stream: false },
    { session: new Session('k') },
  );

  assert.equal(captured.url, 'http://example.test/v2/chat/completions');
  assert.equal(JSON.parse(captured.init.body).stream, true, 'stream must be forced to true');
  assert.equal(completion.choices[0].message.content, 'ok');
});

test('client surfaces upstream error code and requestId', async () => {
  const client = new CodebuddyClient({
    token: TEST_JWT,
    baseUrl: 'http://example.test/v2',
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 11101, msg: 'Non-stream chat request is currently not supported', requestId: 'rid-1' }), {
        status: 400,
      }),
  });

  await assert.rejects(
    () => client.createCompletion({ model: 'hy3', messages: [] }, { session: new Session('k') }),
    (err) => {
      assert.equal(err.name, 'CodebuddyApiError');
      assert.equal(err.code, 11101);
      assert.equal(err.requestId, 'rid-1');
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('client sends the simulated headers upstream', async () => {
  let sent;
  const client = new CodebuddyClient({
    token: TEST_JWT,
    baseUrl: 'http://example.test/v2',
    fetchImpl: async (url, init) => {
      sent = init.headers;
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });

  await client.createCompletion({ model: 'hy3', messages: [] }, { session: new Session('k') });

  assert.equal(sent['x-user-id'], '81919ef5-8ec1-4c89-9ae6-91f592b9845c');
  assert.equal(sent['x-codebuddy-request'], '1');
  assert.ok(sent.traceparent.startsWith('00-'));
});

test('client requires a token', () => {
  assert.throws(() => new CodebuddyClient({}), /token is required/);
});

// ---------- 服务层 ----------

test('unknown models fall back to the default', () => {
  assert.equal(resolveModel('hy3'), 'hy3');
  assert.equal(resolveModel('gpt-4o'), 'hy3');
  assert.equal(resolveModel(undefined), 'hy3');
});

test('session key prefers explicit headers over payload fields', () => {
  assert.equal(sessionKeyOf({ headers: { 'x-session-id': 'h' } }, { user: 'p' }), 'h');
  assert.equal(sessionKeyOf({ headers: {} }, { session_id: 's' }), 's');
  assert.equal(sessionKeyOf({ headers: {} }, { user: 'u' }), 'u');
  assert.equal(sessionKeyOf({ headers: {} }, {}), null);
});

test('chunk normalization strips upstream placeholder fields', () => {
  const normalized = normalizeChunk(
    {
      id: 'c',
      model: 'hy3',
      choices: [{ index: 0, delta: { content: 'hi', reasoning_content: '', refusal: '', tool_calls: [], function_call: null, extra_fields: null }, finish_reason: '' }],
    },
    'hy3',
  );

  const { delta } = normalized.choices[0];
  assert.equal(delta.content, 'hi');
  assert.equal('reasoning_content' in delta, false);
  assert.equal('refusal' in delta, false);
  assert.equal('tool_calls' in delta, false);
  assert.equal(normalized.choices[0].finish_reason, null, 'empty finish_reason must become null');
  assert.equal(normalized.object, 'chat.completion.chunk');
});
