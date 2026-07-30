'use strict';
/**
 * 完整复刻 CodeBuddy CLI 发往模型服务的请求头。
 *
 * 参考实现：@tencent-ai/codebuddy-code 的 ModelProvider.axiosToFetchAdapter()
 * 头名常量与生成规则详见 docs/chat-api-request-analysis.md。
 *
 * 设计原则：调用方只提供认证令牌，其余身份类头（X-User-Id / X-Domain）
 * 一律从 JWT 自身推导，避免手工配置产生前后矛盾的指纹。
 */

const crypto = require('crypto');

// CLI 版本：本代理已不再依赖 @tencent-ai/agent-sdk（纯直连，无子进程），
// 仅用于 user-agent 指纹。可用 CODEBUDDY_CLI_VERSION 覆盖以对齐真实客户端。
const CLI_VERSION = process.env.CODEBUDDY_CLI_VERSION || '2.127.3';

// OpenAI Node SDK 的客户端指纹。version 需与 CLI 内置的 openai 依赖一致。
const STAINLESS_PACKAGE_VERSION = '6.25.0';

const OS_MAP = { darwin: 'MacOS', win32: 'Windows', linux: 'Linux' };

function stainlessOs() {
  return OS_MAP[process.platform] || 'Unknown';
}

/** 32 位小写 hex，等价于 CLI 的 generateUUUID().replace(/-/g,'') */
function hex32() {
  return crypto.randomBytes(16).toString('hex');
}

/** 16 位小写 hex，OTel spanId */
function hex16() {
  return crypto.randomBytes(8).toString('hex');
}

/** base64url 解码 JWT payload；非 JWT 返回 null，不抛异常 */
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 从令牌推导身份信息。
 * - JWT：X-User-Id 取 sub，X-Domain 取 iss 的 hostname
 * - API Key：X-User-Id 取 anonymous_<key 后 8 位>，无 X-Domain
 */
function deriveIdentity(token) {
  const payload = decodeJwtPayload(token);

  if (payload) {
    let domain;
    if (typeof payload.iss === 'string') {
      try {
        domain = new URL(payload.iss).hostname;
      } catch {
        domain = undefined;
      }
    }
    return {
      kind: 'jwt',
      userId: typeof payload.sub === 'string' ? payload.sub : undefined,
      domain,
      // exp 为秒级时间戳
      expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined,
      username: typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    };
  }

  // API Key 模式：CLI 观测到的形态是 anonymous_ + key 尾部 8 位
  const tail = typeof token === 'string' ? token.slice(-8) : '';
  return {
    kind: 'apiKey',
    userId: tail ? `anonymous_${tail}` : undefined,
    domain: undefined,
    expiresAt: undefined,
  };
}

/** 令牌是否已过期（留 30s 余量）。非 JWT 一律视为未过期。 */
function isTokenExpired(token, now = Date.now()) {
  const { expiresAt } = deriveIdentity(token);
  if (!expiresAt) return false;
  return expiresAt.getTime() - 30_000 <= now;
}

/** 生成一组自洽的链路追踪 ID */
function newTraceContext() {
  return {
    traceId: hex32(),
    spanId: hex16(),
    parentSpanId: hex16(),
    sampled: true,
  };
}

/**
 * 构造完整请求头。
 *
 * 键的插入顺序刻意对齐真实抓包结果——部分风控会对头顺序做指纹，
 * Node 对普通对象保持插入序，故此处顺序即最终发送顺序。
 *
 * @param {object}  opts
 * @param {string}  opts.token           认证令牌（JWT 或 API Key）
 * @param {object}  opts.session         会话上下文，见 codebuddy-session.js
 * @param {string}  opts.messageId       本次请求 ID（32 hex）
 * @param {object}  [opts.trace]         链路上下文，缺省自动生成
 * @param {string}  [opts.agentIntent]   默认 craft
 * @param {string}  [opts.agentPurpose]  默认 conversation
 * @param {string}  [opts.ideType]       默认 CLI
 * @param {string}  [opts.product]       默认 SaaS
 * @param {boolean} [opts.privateData]   默认 false
 * @param {number}  [opts.retryCount]    x-stainless-retry-count，默认 0
 * @param {object}  [opts.extraHeaders]  追加/覆盖头
 */
function buildHeaders(opts) {
  const {
    token,
    session,
    messageId,
    trace = newTraceContext(),
    agentIntent = 'craft',
    agentPurpose = 'conversation',
    ideType = 'CLI',
    ideName = 'CLI',
    ideVersion = CLI_VERSION,
    product = 'SaaS',
    privateData = false,
    retryCount = 0,
    extraHeaders,
  } = opts;

  if (!token) throw new Error('token is required');
  if (!session) throw new Error('session is required');
  if (!messageId) throw new Error('messageId is required');

  const identity = deriveIdentity(token);
  const sampledFlag = trace.sampled === false ? '0' : '1';

  const headers = {
    // --- OpenAI SDK 基础头 ---
    accept: 'application/json',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-stainless-arch': process.arch === 'x64' ? 'x64' : process.arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': stainlessOs(),
    'x-stainless-package-version': STAINLESS_PACKAGE_VERSION,
    'x-stainless-retry-count': String(retryCount),
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,

    // --- 会话标识 ---
    'x-conversation-id': session.conversationId,
    'x-conversation-request-id': session.conversationRequestId,
    'x-agent-intent': agentIntent,
    'x-agent-purpose': agentPurpose,
    'x-ide-type': ideType,
    'x-ide-name': ideName,
    'x-ide-version': ideVersion,
    'x-private-data': privateData ? 'true' : 'false',
    'x-codebuddy-request': '1',
  };

  // API Key 模式下 CLI 会额外带 X-API-Key，且 authorization 在此处即注入
  if (identity.kind === 'apiKey') {
    headers['x-api-key'] = token;
    headers.authorization = `Bearer ${token}`;
  }

  // --- 请求级标识：两者同值，CLI 亦如此 ---
  headers['x-request-id'] = messageId;
  headers['x-conversation-message-id'] = messageId;

  // --- 链路追踪 ---
  headers.traceparent = `00-${trace.traceId}-${trace.spanId}-${sampledFlag === '1' ? '01' : '00'}`;
  headers.b3 = `${trace.traceId}-${trace.spanId}-${sampledFlag}${trace.parentSpanId ? `-${trace.parentSpanId}` : ''}`;
  headers['x-b3-traceid'] = trace.traceId;
  if (trace.parentSpanId) headers['x-b3-parentspanid'] = trace.parentSpanId;
  headers['x-b3-spanid'] = trace.spanId;
  headers['x-b3-sampled'] = sampledFlag;
  headers['x-trace-id'] = trace.traceId;

  // --- 鉴权拦截器注入（JWT 模式下 authorization 在链路头之后）---
  if (identity.kind === 'jwt') {
    headers.authorization = `Bearer ${token}`;
  }
  if (identity.userId) headers['x-user-id'] = identity.userId;
  if (identity.domain) headers['x-domain'] = identity.domain;

  headers['x-product'] = product;
  headers['user-agent'] = `${ideType}/${ideVersion} CodeBuddy/${ideVersion}`;

  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v === undefined || v === null) delete headers[k.toLowerCase()];
      else headers[k.toLowerCase()] = String(v);
    }
  }

  return headers;
}

module.exports = {
  CLI_VERSION,
  buildHeaders,
  decodeJwtPayload,
  deriveIdentity,
  hex16,
  hex32,
  isTokenExpired,
  newTraceContext,
};
