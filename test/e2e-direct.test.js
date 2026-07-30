'use strict';
/**
 * server.js 端到端联调：
 * 用一个本地 mock 上游接收真实发出的请求（头 + 体），断言：
 *   1) 请求头完整复刻 CLI 指纹（含可观测性 / 风控头）
 *   2) 上游强制 stream:true
 *   3) 流式与非流式都能还原成标准 OpenAI 响应
 *   4) 同一会话下 X-Conversation-ID 稳定、请求级 ID 轮换
 *
 * 不依赖真实令牌：用自签名（未验签）JWT 仅驱动头推导。
 */

const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

function makeFakeJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

// 必须在 require server 之前写入令牌
const TOKEN = makeFakeJwt({
  sub: 'usr_abc123',
  iss: 'https://copilot.tencent.com',
  preferred_username: 'alice',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
process.env.CODEBUDDY_API_KEY = TOKEN;
process.env.PROXY_API_KEY = ''; // 关闭代理鉴权，纯测头模拟

let capturedRequests = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    capturedRequests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'hy3',
        system_fingerprint: 'sf-e2e', system_message: 'X',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'hy3',
        system_fingerprint: 'sf-e2e',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'hy3',
        system_fingerprint: 'sf-e2e',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'hy3',
        system_fingerprint: 'sf-e2e',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const { server } = require('../server');

async function collectSse(response) {
  const text = await response.text();
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;
      try { events.push(JSON.parse(payload)); } catch { /* skip */ }
    }
  }
  return { text, events };
}

test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  process.env.CODEBUDDY_BASE_URL = `http://127.0.0.1:${upPort}/v2`;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
});

function baseUrl() {
  return `http://127.0.0.1:${server.address().port}`;
}

test('health 返回身份推导结果', async () => {
  const res = await fetch(`${baseUrl()}/health`);
  const json = await res.json();
  assert.strictEqual(json.mode, 'direct');
  assert.strictEqual(json.auth.kind, 'jwt');
  assert.strictEqual(json.auth.userId, 'usr_abc123');
  assert.strictEqual(json.auth.domain, 'copilot.tencent.com');
  assert.strictEqual(json.auth.expired, false);
});

test('发出请求时完整模拟 CLI 请求头', async () => {
  capturedRequests = [];
  await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-e2e' },
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });

  assert.strictEqual(capturedRequests.length, 1);
  const h = capturedRequests[0].headers;

  // 鉴权头
  assert.strictEqual(h.authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(h['x-user-id'], 'usr_abc123');
  assert.strictEqual(h['x-domain'], 'copilot.tencent.com');

  // 会话三级标识
  assert.ok(/^[0-9a-f-]{36}$/.test(h['x-conversation-id']), 'conversation id');
  assert.ok(h['x-conversation-request-id'], 'conversation request id');
  assert.ok(h['x-request-id'], 'request id');
  assert.strictEqual(h['x-request-id'], h['x-conversation-message-id'], 'req id == message id');

  // 链路追踪
  assert.ok(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[1-2]$/.test(h.traceparent), 'traceparent');
  assert.ok(/^[0-9a-f]{32}-[0-9a-f]{16}-[01]-[0-9a-f]{16}$/.test(h.b3), 'b3');
  assert.strictEqual(h['x-b3-traceid'], h['x-trace-id'], 'trace id 一致');
  assert.strictEqual(h['x-b3-sampled'], '1');

  // OpenAI SDK 指纹
  assert.strictEqual(h.accept, 'application/json');
  assert.strictEqual(h['content-type'], 'application/json');
  assert.strictEqual(h['x-requested-with'], 'XMLHttpRequest');
  assert.strictEqual(h['x-stainless-lang'], 'js');
  assert.strictEqual(h['x-stainless-runtime'], 'node');
  assert.strictEqual(h['x-private-data'], 'false');
  assert.strictEqual(h['x-ide-type'], 'CLI');
  assert.strictEqual(h['x-agent-intent'], 'craft');
  assert.strictEqual(h['x-agent-purpose'], 'conversation');
  assert.strictEqual(h['user-agent'], 'axios/1.18.1');

  // 上游强制流式，即便调用方没要求
  assert.strictEqual(capturedRequests[0].body.stream, true);
});

test('流式响应还原为 OpenAI SSE', async () => {
  capturedRequests = [];
  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-e2e' },
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const { events } = await collectSse(res);
  assert.ok(events.length >= 4, '至少 4 个 chunk');
  assert.strictEqual(events[0].choices[0].delta.role, 'assistant');
  assert.strictEqual(events[events.length - 1].usage.total_tokens, 7);
  // 合并后文本应为 Hello
  const text = events.map((e) => e.choices[0].delta.content || '').join('');
  assert.strictEqual(text, 'Hello');
});

test('非流式响应被内部聚合为 chat.completion', async () => {
  capturedRequests = [];
  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-e2e' },
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  const json = await res.json();
  assert.strictEqual(json.object, 'chat.completion');
  assert.strictEqual(json.choices[0].message.role, 'assistant');
  assert.strictEqual(json.choices[0].message.content, 'Hello');
  assert.strictEqual(json.usage.total_tokens, 7);
  // 即便调用方传 stream:false，发往上游的仍被强制为 true
  assert.strictEqual(capturedRequests[0].body.stream, true);
});

test('同一会话跨轮：conversation-id 稳定、请求级 ID 轮换', async () => {
  capturedRequests = [];
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-reuse' };
  await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: '1' }], stream: false }),
  });
  await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: '2' }], stream: false }),
  });
  assert.strictEqual(capturedRequests.length, 2);
  const cid1 = capturedRequests[0].headers['x-conversation-id'];
  const cid2 = capturedRequests[1].headers['x-conversation-id'];
  assert.strictEqual(cid1, cid2, '会话 ID 稳定');
  assert.notStrictEqual(
    capturedRequests[0].headers['x-request-id'],
    capturedRequests[1].headers['x-request-id'],
    '每次请求 ID 轮换',
  );
});

test('额外 OpenAI 参数透传到上游', async () => {
  capturedRequests = [];
  await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-params' },
    body: JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.3,
      top_p: 0.9,
      n: 2,
      max_tokens: 256,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      logit_bias: { '123': -5 },
      logprobs: true,
      top_logprobs: 3,
      user: 'ops-user-9',
      response_format: { type: 'json_object' },
      seed: 42,
      parallel_tool_calls: false,
      service_tier: 'default',
      reasoning_effort: 'low',
      metadata: { tag: 'x' },
    }),
  });
  assert.strictEqual(capturedRequests.length, 1);
  const body = capturedRequests[0].body;
  assert.strictEqual(body.temperature, 0.3);
  assert.strictEqual(body.top_p, 0.9);
  assert.strictEqual(body.n, 2);
  assert.strictEqual(body.max_tokens, 256);
  assert.strictEqual(body.presence_penalty, 0.1);
  assert.strictEqual(body.frequency_penalty, 0.2);
  assert.deepStrictEqual(body.logit_bias, { '123': -5 });
  assert.strictEqual(body.logprobs, true);
  assert.strictEqual(body.top_logprobs, 3);
  assert.strictEqual(body.user, 'ops-user-9');
  assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  assert.strictEqual(body.seed, 42);
  assert.strictEqual(body.parallel_tool_calls, false);
  assert.strictEqual(body.service_tier, 'default');
  assert.strictEqual(body.reasoning_effort, 'low');
  assert.deepStrictEqual(body.metadata, { tag: 'x' });
  // 客户端意图的 stream:false 不出现在上游请求体（内部强制 true）
  assert.strictEqual(body.stream, true);
});

test('流式输出忠实透传 system_fingerprint 与 usage', async () => {
  capturedRequests = [];
  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-fidelity' },
    body: JSON.stringify({
      model: 'hy3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const { events } = await collectSse(res);
  // 每个 chunk 都带有上游的 system_fingerprint（透传，不被代理丢弃）
  for (const e of events) {
    assert.strictEqual(e.system_fingerprint, 'sf-e2e', 'system_fingerprint 透传');
  }
  // 末位 chunk 携带 usage
  const last = events[events.length - 1];
  assert.strictEqual(last.usage.total_tokens, 7);
  // 内容未被破坏
  const text = events.map((e) => e.choices[0].delta.content || '').join('');
  assert.strictEqual(text, 'Hello');
  // stream_options 透传到上游
  assert.deepStrictEqual(capturedRequests[0].body.stream_options, { include_usage: true });
});
