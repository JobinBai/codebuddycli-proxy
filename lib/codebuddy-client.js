'use strict';
/**
 * 直连 CodeBuddy 模型服务的客户端（不经过 CLI 子进程）。
 *
 * 两个必须处理的上游特性：
 *   1. 服务端不支持非流式：stream:false 会返回 code 11101。
 *      因此对外若请求非流式，内部仍以流式发起，再聚合成完整响应。
 *   2. 请求头即风控信号，全部由 codebuddy-headers 统一生成，
 *      调用方只需提供令牌。
 */

const { buildHeaders, isTokenExpired } = require('./codebuddy-headers');

const DEFAULT_BASE_URL = 'https://copilot.tencent.com/v2';

/** 去除重复的 /chat/completions 后缀，与 CLI 的同名方法一致 */
function normalizeChatCompletionsUrl(url) {
  const markIndex = url.search(/[?#]/);
  const suffix = markIndex >= 0 ? url.slice(markIndex) : '';
  let base = markIndex >= 0 ? url.slice(0, markIndex) : url;
  base = base.replace(/\/+$/, '');
  while (base.endsWith('/chat/completions')) base = base.slice(0, -17);
  return `${base}/chat/completions${suffix}`;
}

function resolveEndpoint(baseUrl) {
  return normalizeChatCompletionsUrl(baseUrl || process.env.CODEBUDDY_BASE_URL || DEFAULT_BASE_URL);
}

class CodebuddyApiError extends Error {
  constructor(message, { status, code, requestId, body } = {}) {
    super(message);
    this.name = 'CodebuddyApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

/** 将 SSE 字节流切成一个个 data 负载 */
async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let sep;
    // 事件以空行分隔，兼容 \n\n 与 \r\n\r\n
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + buffer.slice(sep).match(/^\r?\n\r?\n/)[0].length);

      const dataLines = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;

      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;

      try {
        yield JSON.parse(payload);
      } catch {
        // 忽略无法解析的心跳/注释帧
      }
    }
  }
}

/** 把流式 chunk 合并成一个标准 chat.completion 响应 */
function aggregateChunks(chunks, fallbackModel) {
  const choices = new Map();
  let id;
  let model = fallbackModel;
  let created;
  let usage;
  let systemFingerprint;

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.created) created = chunk.created;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.system_fingerprint) systemFingerprint = chunk.system_fingerprint;

    for (const choice of chunk.choices || []) {
      const index = choice.index ?? 0;
      if (!choices.has(index)) {
        choices.set(index, { index, role: 'assistant', content: '', reasoning: '', toolCalls: new Map(), finishReason: null, logprobs: null, refusal: null });
      }
      const acc = choices.get(index);
      const delta = choice.delta || {};

      if (delta.role) acc.role = delta.role;
      if (typeof delta.content === 'string') acc.content += delta.content;
      if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content;
      if (typeof delta.refusal === 'string' && delta.refusal) acc.refusal = delta.refusal;

      for (const tc of delta.tool_calls || []) {
        const tcIndex = tc.index ?? 0;
        if (!acc.toolCalls.has(tcIndex)) {
          acc.toolCalls.set(tcIndex, { id: tc.id, type: tc.type || 'function', function: { name: '', arguments: '' } });
        }
        const accTc = acc.toolCalls.get(tcIndex);
        if (tc.id) accTc.id = tc.id;
        if (tc.type) accTc.type = tc.type;
        if (tc.function?.name) accTc.function.name += tc.function.name;
        if (tc.function?.arguments) accTc.function.arguments += tc.function.arguments;
      }

      if (choice.logprobs) acc.logprobs = choice.logprobs;
      // 上游会用空串占位，只认非空值
      if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    }
  }

  const built = [...choices.values()]
    .sort((a, b) => a.index - b.index)
    .map((acc) => {
      const message = { role: acc.role || 'assistant', content: acc.content };
      if (acc.reasoning) message.reasoning_content = acc.reasoning;
      if (acc.refusal) message.refusal = acc.refusal;
      if (acc.toolCalls.size) {
        message.tool_calls = [...acc.toolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => tc);
      }
      return { index: acc.index, message, logprobs: acc.logprobs || null, finish_reason: acc.finishReason || 'stop' };
    });

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: built.length ? built : [{ index: 0, message: { role: 'assistant', content: '' }, logprobs: null, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
    ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
  };
}

/** 解析上游错误响应，尽量还原 code / requestId 便于排查 */
async function toApiError(response) {
  const text = await response.text().catch(() => '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const message = parsed?.msg || parsed?.error?.message || text || `upstream returned ${response.status}`;
  return new CodebuddyApiError(message, {
    status: response.status,
    code: parsed?.code,
    requestId: parsed?.requestId,
    body: text,
  });
}

class CodebuddyClient {
  /**
   * @param {object}  opts
   * @param {string}  opts.token                认证令牌（JWT 或 API Key）
   * @param {string}  [opts.baseUrl]            默认 https://copilot.tencent.com/v2
   * @param {number}  [opts.timeoutMs]          单请求超时，默认 600000
   * @param {object}  [opts.headerDefaults]     透传给 buildHeaders 的默认值
   * @param {Function}[opts.fetchImpl]          便于测试注入
   */
  constructor({ token, baseUrl, timeoutMs = 600_000, headerDefaults = {}, fetchImpl } = {}) {
    if (!token) throw new Error('token is required');
    this.token = token;
    this.endpoint = resolveEndpoint(baseUrl);
    this.timeoutMs = timeoutMs;
    this.headerDefaults = headerDefaults;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('global fetch is unavailable; Node >= 18 required');
  }

  get tokenExpired() {
    return isTokenExpired(this.token);
  }

  /**
   * 发起一次对话请求。
   *
   * @param {object}  params            OpenAI Chat Completions 请求体
   * @param {object}  ctx
   * @param {object}  ctx.session       会话对象
   * @param {AbortSignal} [ctx.signal]
   * @param {object}  [ctx.extraHeaders]
   * @returns {Promise<{stream: AsyncIterable, headers: object, response: Response}>}
   */
  async createStream(params, { session, signal, extraHeaders } = {}) {
    if (!session) throw new Error('session is required');

    const { messageId, trace } = session.nextRequest();
    const headers = buildHeaders({
      token: this.token,
      session,
      messageId,
      trace,
      ...this.headerDefaults,
      extraHeaders: { ...this.headerDefaults.extraHeaders, ...extraHeaders },
    });

    // 上游拒绝非流式，这里恒定为 true
    const body = JSON.stringify({ ...params, stream: true });

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), this.timeoutMs);

    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      throw await toApiError(response);
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    async function* iterate() {
      try {
        for await (const chunk of parseSseStream(response.body)) yield chunk;
      } finally {
        cleanup();
      }
    }

    return { stream: iterate(), headers, messageId, response };
  }

  /** 非流式调用：内部走流式再聚合 */
  async createCompletion(params, ctx = {}) {
    const { stream } = await this.createStream(params, ctx);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return aggregateChunks(chunks, params.model);
  }
}

module.exports = {
  CodebuddyApiError,
  CodebuddyClient,
  DEFAULT_BASE_URL,
  aggregateChunks,
  normalizeChatCompletionsUrl,
  parseSseStream,
  resolveEndpoint,
};
