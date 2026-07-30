'use strict';
/**
 * 会话生命周期管理。
 *
 * CLI 的三层标识语义（务必区分，否则风控侧会看到自相矛盾的会话图）：
 *   X-Conversation-ID          会话级，一次会话内恒定（UUID，带连字符）
 *   X-Conversation-Request-ID  轮次级，一次用户提问内恒定（32 hex）
 *   X-Request-ID / X-Conversation-Message-ID
 *                              请求级，每个 HTTP 请求都不同（32 hex，两者同值）
 *
 * 链路追踪同理：traceId 覆盖整轮，spanId 每请求一个，
 * parentSpanId 指向该轮的根 span。
 */

const { randomUUID } = require('crypto');
const { hex16, hex32 } = require('./codebuddy-headers');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟无活动即回收
const DEFAULT_MAX_SESSIONS = 1000;

class Session {
  constructor(key) {
    this.key = key;
    this.conversationId = randomUUID();
    this.createdAt = Date.now();
    this.lastUsedAt = this.createdAt;
    this.turnCount = 0;
    this.requestCount = 0;
    this.beginTurn();
  }

  /** 开启新一轮对话：刷新轮次级标识与链路根 span */
  beginTurn() {
    this.conversationRequestId = hex32();
    this.traceId = hex32();
    this.rootSpanId = hex16();
    this.turnCount += 1;
    this.lastUsedAt = Date.now();
    return this;
  }

  /** 为单个 HTTP 请求分配标识与 span */
  nextRequest() {
    this.requestCount += 1;
    this.lastUsedAt = Date.now();
    return {
      messageId: hex32(),
      trace: {
        traceId: this.traceId,
        spanId: hex16(),
        parentSpanId: this.rootSpanId,
        sampled: true,
      },
    };
  }

  isExpired(ttlMs, now = Date.now()) {
    return now - this.lastUsedAt > ttlMs;
  }
}

class SessionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  /**
   * 取出（或新建）会话。
   * key 为空时返回一次性会话，不入池——适合无状态调用方。
   */
  acquire(key) {
    if (!key) return new Session(null);

    this.sweep();

    let session = this.sessions.get(key);
    if (session && session.isExpired(this.ttlMs)) {
      this.sessions.delete(key);
      session = undefined;
    }

    if (!session) {
      session = new Session(key);
      this.sessions.set(key, session);
      this.evictIfNeeded();
    } else {
      // Map 保持插入序，重新插入即等效于 LRU 提升
      this.sessions.delete(key);
      this.sessions.set(key, session);
    }

    return session;
  }

  sweep(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (session.isExpired(this.ttlMs, now)) this.sessions.delete(key);
    }
  }

  evictIfNeeded() {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  get size() {
    return this.sessions.size;
  }

  clear() {
    this.sessions.clear();
  }
}

module.exports = { DEFAULT_MAX_SESSIONS, DEFAULT_TTL_MS, Session, SessionStore };
