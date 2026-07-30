#!/usr/bin/env node
/**
 * codebuddycli-proxy / direct 模式
 * --------------------------------
 * OpenAI 兼容的对话 API，直连 CodeBuddy 模型服务，不再 spawn CLI 子进程。
 *
 * 与 server.js 的差异：
 *   server.js         经 Agent SDK 拉起 CLI，附带完整 agent 能力（工具、文件读写）
 *   server-direct.js  纯 LLM 直连，延迟更低，请求头由本进程完整模拟
 *
 * 你只需提供认证令牌，其余风控相关请求头（X-User-Id / X-Domain / 链路追踪 /
 * 会话三级标识）全部自动生成，规则见 docs/chat-api-request-analysis.md。
 *
 * 环境变量：
 *   CODEBUDDY_API_KEY   必填。认证令牌（JWT 或 API Key）；兼容旧名 CODEBUDDY_TOKEN
 *   CODEBUDDY_BASE_URL  上游地址，默认 https://copilot.tencent.com/v2
 *   PORT                监听端口，默认 8787
 *   HOST                监听地址，默认 127.0.0.1
 *   PROXY_API_KEY       设置后客户端须带 Authorization: Bearer <key>
 *   DEFAULT_MODEL       默认模型，默认 hy3
 *   REQUEST_TIMEOUT_MS  单请求超时，默认 600000
 *   SESSION_TTL_MS      会话空闲回收时间，默认 1800000
 */

'use strict';

const http = require('http');
const { CodebuddyApiError, CodebuddyClient } = require('./lib/codebuddy-client');
const { SessionStore } = require('./lib/codebuddy-session');
const { deriveIdentity, isTokenExpired } = require('./lib/codebuddy-headers');

// ---------- 配置 ----------
function readPositiveInt(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

const PORT = readPositiveInt('PORT', 8787, 65535);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_TOKEN || '';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'hy3';
const REQUEST_TIMEOUT_MS = readPositiveInt('REQUEST_TIMEOUT_MS', 600_000);
const SESSION_TTL_MS = readPositiveInt('SESSION_TTL_MS', 30 * 60 * 1000);

const KNOWN_MODELS = [
  'auto', 'hy3', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3',
  'kimi-k3-1', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-flash', 'deepseek-v4-pro',
];

// ---------- 工具函数 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function openaiError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, code } });
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function resolveModel(requested) {
  if (requested && KNOWN_MODELS.includes(requested)) return requested;
  return DEFAULT_MODEL;
}

/**
 * 会话键：决定哪些请求共享同一个 X-Conversation-ID。
 * 优先取显式声明的会话头，其次取 user 字段；都没有则退化为一次性会话。
 */
function sessionKeyOf(req, payload) {
  return (
    req.headers['x-session-id'] ||
    req.headers['x-conversation-id'] ||
    payload.session_id ||
    payload.user ||
    null
  );
}

/**
 * 上游 chunk 可能带空串占位（finish_reason / reasoning_content 等），需归一成 OpenAI 标准形态；
 * 其余字段（system_fingerprint、usage、logprobs 等）全部忠实透传，以保证与任意 OpenAI 客户端的
 * 最大兼容——我们只是个薄代理，不应丢弃上游返回的任何语义字段。
 */
function normalizeChunk(chunk, model) {
  const out = { ...chunk };
  if (model && !out.model) out.model = model;
  if (!out.object) out.object = 'chat.completion.chunk';
  if (out.choices) {
    out.choices = out.choices.map((choice) => {
      const nc = { ...choice };
      if (nc.delta && typeof nc.delta === 'object') {
        const d = { ...nc.delta };
        if (d.reasoning_content === '') delete d.reasoning_content;
        if (d.content === null) delete d.content;
        if (d.function_call === null) delete d.function_call;
        if (d.refusal === '') delete d.refusal;
        if (d.extra_fields === null) delete d.extra_fields;
        if (Array.isArray(d.tool_calls) && d.tool_calls.length === 0) delete d.tool_calls;
        nc.delta = d;
      }
      if (nc.finish_reason === '') nc.finish_reason = null;
      return nc;
    });
  }
  return out;
}

// ---------- 日志（仅输出到控制台，不写文件） ----------
function logEvent(level, fields) {
  const ts = new Date().toISOString();
  const parts = [`[${ts}]`, level];
  for (const [k, v] of Object.entries(fields)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  console.log(parts.join(' '));
}

// ---------- 运行时 ----------
const sessions = new SessionStore({ ttlMs: SESSION_TTL_MS });
let client = null;

function getClient() {
  if (!client) {
    client = new CodebuddyClient({ token: TOKEN, timeoutMs: REQUEST_TIMEOUT_MS });
  }
  return client;
}

async function handleChatCompletions(req, res, payload) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return openaiError(res, 400, 'messages must be a non-empty array');
  }

  if (isTokenExpired(TOKEN)) {
    return openaiError(res, 401, 'CODEBUDDY_API_KEY has expired; refresh it and restart', 'authentication_error');
  }

  const model = resolveModel(payload.model);
  const wantStream = payload.stream === true;

  const session = sessions.acquire(sessionKeyOf(req, payload));
  // 每次对外请求视为新一轮；工具循环由调用方自行驱动
  session.beginTurn();

  // ---- 请求日志 ----
  const sessionKey = sessionKeyOf(req, payload) || '-';
  const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
  const preview = typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 200) : '(non-text)';
  const promptChars = payload.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const upStart = Date.now();
  logEvent('REQ', {
    model: payload.model || '(default)',
    resolved: model,
    session: sessionKey,
    messages: payload.messages.length,
    prompt_chars: promptChars,
    stream: wantStream,
    prompt: preview,
  });

  // 透传 OpenAI Chat Completions 全量参数到上游（上游本身即 OpenAI 兼容）。
  // 不传 stream：客户端流式/非流式意图由本服务内部处理；上游拒绝非流式，故内部恒以 stream:true 发起。
  const PASSTHROUGH_PARAMS = [
    'temperature', 'top_p', 'n', 'max_tokens', 'max_completion_tokens',
    'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs',
    'top_logprobs', 'user', 'response_format', 'seed', 'tools', 'tool_choice',
    'parallel_tool_calls', 'service_tier', 'reasoning_effort', 'modalities',
    'audio', 'metadata', 'stream_options', 'function_call', 'functions',
  ];
  const upstreamParams = { model, messages: payload.messages };
  for (const key of PASSTHROUGH_PARAMS) {
    if (payload[key] !== undefined) upstreamParams[key] = payload[key];
  }

  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) abortController.abort(new Error('client disconnected'));
  });

  try {
    if (!wantStream) {
      const completion = await getClient().createCompletion(upstreamParams, {
        session,
        signal: abortController.signal,
      });
      logEvent('RES', { model, upstream_ms: Date.now() - upStart, status: 200, stream: false });
      return sendJson(res, 200, completion);
    }

    const { stream } = await getClient().createStream(upstreamParams, {
      session,
      signal: abortController.signal,
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    let firstChunkAt = null;
    let chunkCount = 0;
    for await (const chunk of stream) {
      if (firstChunkAt === null) firstChunkAt = Date.now();
      chunkCount += 1;
      res.write(`data: ${JSON.stringify(normalizeChunk(chunk, model))}\n\n`);
    }
    const upstreamMs = Date.now() - upStart;
    const ttft = firstChunkAt !== null ? firstChunkAt - upStart : null;
    res.write('data: [DONE]\n\n');
    logEvent('RES', { model, upstream_ms: upstreamMs, ttft_ms: ttft, chunks: chunkCount, status: 200, stream: true });
    return res.end();
  } catch (err) {
    const aborted = abortController.signal.aborted && !res.writableEnded && req.destroyed;
    if (aborted) {
      if (!res.writableEnded) res.end();
      return undefined;
    }

    if (res.headersSent) {
      // 流已开始，只能以 SSE 错误帧收尾
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const upstreamMs = Date.now() - upStart;
    if (err instanceof CodebuddyApiError) {
      const status = err.status === 401 || err.status === 403 ? err.status : 502;
      logEvent('ERR', { model, upstream_ms: upstreamMs, status, code: err.code ?? null, error: err.message });
      return openaiError(
        res,
        status,
        `${err.message}${err.requestId ? ` (requestId: ${err.requestId})` : ''}`,
        status === 401 ? 'authentication_error' : 'upstream_error',
        err.code ?? null,
      );
    }
    logEvent('ERR', { model, upstream_ms: upstreamMs, status: 500, error: err.message || 'internal error' });
    return openaiError(res, 500, err.message || 'internal error', 'internal_error');
  }
}

function handleModels(res) {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: KNOWN_MODELS.map((id) => ({ id, object: 'model', created, owned_by: 'codebuddy' })),
  });
}

function handleHealth(res) {
  const identity = deriveIdentity(TOKEN);
  sendJson(res, 200, {
    status: 'ok',
    mode: 'direct',
    upstream: getClient().endpoint,
    auth: {
      kind: identity.kind,
      userId: identity.userId,
      domain: identity.domain,
      expiresAt: identity.expiresAt ? identity.expiresAt.toISOString() : null,
      expired: isTokenExpired(TOKEN),
    },
    sessions: sessions.size,
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Session-Id',
    });
    return res.end();
  }

  if (url === '/health' || url === '/v1/health') return handleHealth(res);

  if (PROXY_API_KEY) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${PROXY_API_KEY}`) {
      return openaiError(res, 401, 'invalid proxy api key', 'authentication_error');
    }
  }

  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) return handleModels(res);

  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return openaiError(res, 400, `invalid JSON body: ${err.message}`);
    }
    return handleChatCompletions(req, res, payload);
  }

  return openaiError(res, 404, `unknown route: ${url}`, 'not_found');
});

if (require.main === module) {
  if (!TOKEN) {
    console.error('CODEBUDDY_API_KEY is required. Export the token, then restart.');
    process.exit(1);
  }
  const identity = deriveIdentity(TOKEN);
  if (isTokenExpired(TOKEN)) {
    console.warn('[warn] CODEBUDDY_API_KEY appears to be expired; requests will likely fail with 401');
  }
  server.listen(PORT, HOST, () => {
    console.log(`codebuddycli-proxy (direct) listening on http://${HOST}:${PORT}`);
    console.log(`upstream: ${getClient().endpoint}`);
    console.log(`auth: ${identity.kind}${identity.userId ? ` uid=${identity.userId}` : ''}${identity.domain ? ` domain=${identity.domain}` : ''}`);
  });
}

module.exports = {
  KNOWN_MODELS,
  handleChatCompletions,
  normalizeChunk,
  resolveModel,
  sessionKeyOf,
  server,
};
