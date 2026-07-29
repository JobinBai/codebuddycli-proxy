#!/usr/bin/env node
/**
 * codebuddycli-proxy
 * ------------------
 * 基于 CodeBuddy Agent SDK 的 OpenAI 兼容 HTTP 代理。
 *
 * 原理：每个请求通过 CodeBuddy 官方 Agent SDK 调用无头后端，
 * 将 SDK 消息转换为 OpenAI Chat Completions 格式（含 SSE 流式）。
 *
 * Node.js >= 18。
 *
 * 环境变量：
 *   PORT                代理监听端口（默认 8787）
 *   HOST                监听地址（默认 127.0.0.1）
 *   PROXY_API_KEY       可选。设置后客户端必须携带 Authorization: Bearer <key>
 *   CODEBUDDY_API_KEY   你的 CodeBuddy API Key（透传给 SDK）
 *   CODEBUDDY_BIN       可选的 CodeBuddy CLI 绝对路径（默认使用 SDK 内置 CLI）
 *   DEFAULT_MODEL       未指定/未知模型时使用的模型（默认 "auto"）
 *   REQUEST_TIMEOUT_MS  单请求超时毫秒数（默认 600000）
 *   WORK_DIR            CLI 工作目录（默认 ~/.codebuddycli-proxy/workspace）
 */

'use strict';

const http = require('http');
const { randomUUID } = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { query } = require('@tencent-ai/agent-sdk');
let queryImplementation = query;
const SDK_CLI_PATH = path.resolve(path.dirname(require.resolve('@tencent-ai/agent-sdk')), '..', 'cli', 'bin', 'codebuddy');

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
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const CODEBUDDY_BIN = process.env.CODEBUDDY_BIN || SDK_CLI_PATH;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'auto';
const REQUEST_TIMEOUT_MS = readPositiveInt('REQUEST_TIMEOUT_MS', 600000);
const WORK_DIR = process.env.WORK_DIR || path.join(os.homedir(), '.codebuddycli-proxy', 'workspace');
// 是否隐藏推理模型的思考过程（reasoning_content）。默认隐藏：对外 API 不应暴露
// 模型“我要执行 SQL / 运行命令”之类的 agentic 自言自语（虽无实际执行风险，但不专业且占带宽）。
// 需要思考过程的客户端设 HIDE_REASONING=0 开启。
const HIDE_REASONING = process.env.HIDE_REASONING !== '0';

if (!path.isAbsolute(CODEBUDDY_BIN) || !fs.existsSync(CODEBUDDY_BIN)) {
  throw new Error('CODEBUDDY_BIN must be an existing absolute path');
}

// 纯 LLM 模式下强制注入的系统指令：禁止模型把内容裹进 <tool_call>/Write 等工具语法，
// 必须直接以纯文本（代码块）形式给出完整内容。否则模型会退化成 Agent 行为，
// 把代码塞进 <tool_call name="Write"> 的 JSON 参数里，导致对外接口只返回一句开场白。
const PURE_LLM_GUARD = [
  '当前运行环境没有任何本地文件读写、命令行或编辑工具，因此：',
  '1. 永远不要把回答包装成 <tool_call>、Write、Edit 或任何【本地】工具调用语法；',
  '2. 当用户让你“写/创建/生成”页面、脚本、文件或代码时，请直接把完整内容以纯文本（如 ```代码块```）写在回复里；',
  '3. 不要说“我来创建文件 / let me create the file”，而是直接给出最终内容；',
  '4. 始终以用户可直接复制使用的内容作答。',
  '5. 你无法访问任何数据库或执行命令，不要描述“执行 SQL / 运行命令 / 查询数据库”等你做不到的操作；直接基于已知信息作答。',
].join('\n');

// 函数调用模式下的基础约束：仍禁止本地工具，但明确允许通过 <function_call> 与外部交互
const FUNCTION_MODE_GUARD = [
  '当前运行环境没有本地文件读写、命令行或编辑工具（不要用 <tool_call>、Write、Edit 等本地工具语法）。',
  '但你可以通过下方定义的“函数调用(function calling)”与外部系统交互、获取信息或执行操作。',
  '不要臆想你拥有数据库或命令行访问能力；只能通过已定义的函数调用与外部交互。',
].join('\n');

// CLI 当前支持的模型（codebuddy --help 输出，未知模型将回退到 DEFAULT_MODEL）
const KNOWN_MODELS = [
  'auto', 'hy3', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3',
  'kimi-k3-1', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-flash', 'deepseek-v4-pro',
];

const activeQueries = new Set();

fs.mkdirSync(WORK_DIR, { recursive: true });

// ---------- 工具函数 ----------

/** 构造干净的子进程环境：剥离宿主注入的 CODEBUDDY_* 变量（嵌套运行会互相干扰导致卡死） */
function buildCleanEnv() {
  const env = {
    HOME: os.homedir(),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    TERM: 'dumb',
    LANG: process.env.LANG || 'en_US.UTF-8',
  };
  // SDK transport 会合并 process.env；以 undefined 覆盖后，Node spawn 不会传递这些变量。
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CODEBUDDY_')) env[key] = undefined;
  }
  // 仅透传鉴权相关变量
  if (process.env.CODEBUDDY_API_KEY) env.CODEBUDDY_API_KEY = process.env.CODEBUDDY_API_KEY;
  if (process.env.CODEBUDDY_AUTH_TOKEN) env.CODEBUDDY_AUTH_TOKEN = process.env.CODEBUDDY_AUTH_TOKEN;
  // API Key 认证时，国内版/iOA 需要此变量选择正确的 CodeBuddy 服务端点。
  if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT) {
    env.CODEBUDDY_INTERNET_ENVIRONMENT = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  }
  if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
  if (process.env.NO_PROXY) env.NO_PROXY = process.env.NO_PROXY;
  return env;
}

/** 提取 OpenAI message.content 中的文本（支持 string 与多模态数组） */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

function imageBlockFromOpenAI(part) {
  const url = part?.image_url?.url;
  const match = typeof url === 'string' && url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('image_url must be a PNG, JPEG, or WebP Base64 data URL');
  const data = match[2];
  const bytes = Buffer.byteLength(data, 'base64');
  if (bytes > 10 * 1024 * 1024) throw new Error('image exceeds the 10 MiB limit');
  return { type: 'image', source: { type: 'base64', media_type: match[1], data } };
}

function hasImageInput(messages) {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === 'image_url'));
}

async function* imageMessageStream(messages, textPrompt) {
  const content = [{ type: 'text', text: textPrompt }];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === 'image_url') content.push(imageBlockFromOpenAI(part));
  }
  yield { type: 'user', session_id: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content } };
}

/** assistant 消息可能只带 tool_calls（content 为空），需把函数调用也序列化进 prompt */
function assistantToText(m) {
  const parts = [];
  const text = contentToText(m.content);
  if (text) parts.push(text);
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const fn = tc.function || {};
      parts.push(`[调用函数 ${fn.name || '?'}(${fn.arguments || ''})]`);
    }
  }
  return parts.join('\n');
}

/** 将 OpenAI messages[] 序列化为单条 prompt（CLI 每次请求无状态） */
function messagesToPrompt(messages) {
  const systems = [];
  const turns = [];
  for (const m of messages || []) {
    if (m.role === 'assistant') {
      const t = assistantToText(m);
      if (t) turns.push(`Assistant: ${t}`);
      continue;
    }
    const text = contentToText(m.content);
    if (!text) continue;
    if (m.role === 'system' || m.role === 'developer') {
      systems.push(text);
    } else if (m.role === 'tool') {
      turns.push(`Tool result for ${m.tool_call_id || 'unknown call'}: ${text}`);
    } else {
      turns.push(`User: ${text}`);
    }
  }

  // 只有一条 user 消息且无历史时，直接用原文，避免注入格式噪音
  if (systems.length === 0 && turns.length === 1 && turns[0].startsWith('User: ')) {
    return turns[0].slice(6);
  }

  const parts = [];
  if (systems.length) {
    parts.push(`[系统指令，必须严格遵守]\n${systems.join('\n')}`);
  }
  if (turns.length > 1) {
    parts.push(`[以下是此前的对话记录]\n${turns.slice(0, -1).join('\n\n')}`);
  }
  const last = turns[turns.length - 1] || 'User: ';
  parts.push(`[当前消息，请直接回复，不要带 "Assistant:" 前缀]\n${last}`);
  return parts.join('\n\n');
}

function resolveModel(requested) {
  if (requested && KNOWN_MODELS.includes(requested)) return requested;
  return DEFAULT_MODEL;
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

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function openaiError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: null } });
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

function usageToOpenAI(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const completion = u.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

// ---------- <tool_call> 包裹剥离 ----------
// 模型在纯 LLM 模式下仍可能把代码裹进 <tool_call name="Write">{...}</tool_call>，
// 下面工具负责把它还原成真实内容（取 JSON 里的 content 字段），让对外接口拿到干净文本。

function extractToolContent(inner) {
  const t = (inner || '').trim();
  if (!t) return '';
  try {
    const obj = JSON.parse(t);
    if (typeof obj.content === 'string') return obj.content;
    if (obj.content != null) return JSON.stringify(obj.content, null, 2);
    return t;
  } catch {
    return t;
  }
}

// 流式安全剥离：边收边吐，遇到 <tool_call> 块先缓冲，闭合后只输出其中的真实内容
class ToolCallStripper {
  constructor() {
    this.buf = '';
    this.done = false;
  }

  push(text) {
    this.buf += text;
    return this._drain();
  }

  _drain() {
    let out = '';
    while (true) {
      const open = this.buf.indexOf('<tool_call');
      if (open === -1) {
        if (this.done) {
          out += this.buf;
          this.buf = '';
        } else {
          // 保留末尾少量字符，避免把 '<tool_call' 的开头截断到下一帧
          const keep = Math.min(this.buf.length, 20);
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
        }
        break;
      }
      out += this.buf.slice(0, open);
      this.buf = this.buf.slice(open);
      const close = this.buf.indexOf('</tool_call>');
      if (close === -1) {
        if (this.done) {
          out += this.buf;
          this.buf = '';
        }
        break; // 标签未闭合，暂存等待更多数据
      }
      const tagEnd = this.buf.indexOf('>');
      const inner = tagEnd >= 0 ? this.buf.slice(tagEnd + 1, close) : '';
      out += extractToolContent(inner);
      this.buf = this.buf.slice(close + '</tool_call>'.length);
    }
    return out;
  }

  flush() {
    this.done = true;
    return this._drain();
  }
}

// 非流式一次性清理
function stripToolCallsOnce(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/g, (_, inner) => extractToolContent(inner));
}

// ---------- OpenAI function calling 中继 ----------

// 将客户端传来的 OpenAI tools[] 规范化为 [{name, description, parameters}]
function normalizeFunctions(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const fn = t && (t.function || t);
    if (fn && fn.name) {
      out.push({
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

function validateChatRequest(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return '"messages" is required and must be a non-empty array';
  }
  const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
  for (const message of body.messages) {
    if (!message || !roles.has(message.role)) return 'each message must have a supported role';
    if (message.content != null && typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || message.content.some((part) => !part || (part.type === 'text' ? typeof part.text !== 'string' : part.type !== 'image_url'))) {
        return 'only text message content is supported';
      }
    }
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') {
      return 'tool messages require a string tool_call_id';
    }
  }
  if (body.stream_options != null && (typeof body.stream_options !== 'object' || Array.isArray(body.stream_options))) {
    return 'stream_options must be an object';
  }
  if (body.tools != null && !Array.isArray(body.tools)) return 'tools must be an array';
  const names = new Set();
  for (const tool of body.tools || []) {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string') {
      return 'each tool must have type "function" and function.name';
    }
    if (names.has(tool.function.name)) return 'tool function names must be unique';
    names.add(tool.function.name);
  }
  return null;
}

// 构造"函数调用"系统指令：把可用函数以 JSON 描述下发给模型，并用 <function_call> 约定格式驱动结构化输出
function buildFunctionInstruction(functions, toolChoice) {
  const schema = functions.map((f) => ({
    name: f.name,
    description: f.description,
    parameters: f.parameters,
  }));
  let inst = [
    '你可以通过“函数调用(function calling)”获取外部信息或执行操作。可用函数如下（JSON 描述）：',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '调用规则：',
    '- 需要调用时，严格按以下格式输出（可一次输出多个，每个一行）：',
    '  <function_call name="函数名">{参数 JSON 对象}</function_call>',
    '- 参数必须是合法 JSON 对象，键名与上面的 parameters 一致。',
    '- 调用后请停止继续输出，等待“Tool result”返回结果，再决定继续调用或直接回答。',
    '- 不要用 <tool_call>、Write、Edit 等本地工具语法；上面这些是结构化输出约定，并非本地工具。',
    '- 若已掌握足够信息可直接回答用户，则不调用任何函数，直接给出最终回复。',
  ];
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    inst.push(`- 本次你【必须】调用函数 "${toolChoice.function.name}"，不要输出其它内容，也不要调用其它函数。`);
  }
  return inst.join('\n');
}

// 非流式：从整段文本中提取 <function_call>/<tool_call> 块，转换为 tool_calls，并从正文移除
function extractFunctionCalls(text, knownNames) {
  const toolCalls = [];
  if (typeof text !== 'string') return { content: text, toolCalls };
  // CodeBuddy 有时会输出 <tool_call:ID>name"><parameter name="key">value</parameter></invoke>
  // 而不是提示词约定的 <function_call name="name">{...}</function_call>。
  // 两者都只被转换为 OpenAI tool_calls，绝不在本服务端执行。
  let result = text.replace(/<tool_call(?::[^>\s]*)?[^>]*>\s*([\w.-]+)"?>([\s\S]*?)(?:<\/tool_call>|<\/invoke>)/g, (full, name, inner) => {
    if (knownNames && !knownNames.has(name)) return full;
    const args = {};
    const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let parameter;
    while ((parameter = paramRe.exec(inner)) !== null) args[parameter[1]] = parameter[2].trim();
    toolCalls.push({ name, arguments: JSON.stringify(args) });
    return '';
  });
  const re = /<(function_call|tool_call)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let regularResult = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(result)) !== null) {
    const full = m[0];
    const inner = m[2];
    const nameMatch = full.match(/name="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : null;
    regularResult += result.slice(lastIndex, m.index);
    if (name && (!knownNames || knownNames.has(name))) {
      toolCalls.push({ name, arguments: inner.trim() });
      // 跳过该块（不计入正文）
    } else {
      regularResult += full; // 未知函数名：保留原文，避免误吞
    }
    lastIndex = m.index + full.length;
  }
  regularResult += result.slice(lastIndex);
  // 外层 <tool_calls:...> 只是 CodeBuddy 包装，不应泄露给 OpenAI 客户端。
  regularResult = regularResult.replace(/<\/?tool_calls(?::[^>\s]*)?[^>]*>/g, '');
  return { content: regularResult.trim(), toolCalls };
}

// 流式：边收边解析，命中 <function_call> 块时回调 onToolCall（而不是当作正文），
// 仅把块外的纯文本通过 onContent 透出。
class FunctionCallParser {
  constructor(knownNames, onContent, onToolCall) {
    this.knownNames = knownNames || null;
    this.onContent = onContent;
    this.onToolCall = onToolCall;
    this.buf = '';
    this.done = false;
  }

  push(text) {
    this.buf += text;
    this._drain();
  }

  _drain() {
    const openRe = /<(function_call|tool_call)\b/;
    while (true) {
      const open = this.buf.search(openRe);
      if (open === -1) {
        if (this.done) {
          if (this.buf) this.onContent(this.buf);
          this.buf = '';
        } else {
          // 保留末尾以防 '<function_call' 开头被截断到下一帧
          const keep = Math.min(this.buf.length, 30);
          const safe = this.buf.slice(0, this.buf.length - keep);
          if (safe) this.onContent(safe);
          this.buf = this.buf.slice(this.buf.length - keep);
        }
        break;
      }
      const before = this.buf.slice(0, open);
      if (before) this.onContent(before);
      this.buf = this.buf.slice(open);
      const tagMatch = this.buf.match(/^<(function_call|tool_call)\b/);
      const tagName = tagMatch ? tagMatch[1] : 'function_call';
      const closeRe = new RegExp('</' + tagName + '>');
      const close = this.buf.search(closeRe);
      if (close === -1) {
        if (this.done) {
          if (this.buf) this.onContent(this.buf);
          this.buf = '';
        }
        break; // 标签未闭合，暂存
      }
      const tagEnd = this.buf.indexOf('>');
      const inner = this.buf.slice(tagEnd + 1, close);
      const head = this.buf.slice(0, tagEnd);
      const nameMatch = head.match(/name="([^"]+)"/);
      const name = nameMatch ? nameMatch[1] : null;
      this.buf = this.buf.slice(close + ('</' + tagName + '>').length);
      if (name && (!this.knownNames || this.knownNames.has(name))) {
        const args = inner.trim();
        if (args) this.onToolCall({ name, arguments: args });
      } else {
        // 未知函数名：原样保留
        const recon = `<${tagName}${name ? ` name="${name}"` : ''}>${inner}</${tagName}>`;
        this.onContent(recon);
      }
    }
  }

  flush() {
    this.done = true;
    this._drain();
  }
}

// ---------- CodeBuddy SDK 执行核心 ----------

/**
 * 通过官方 SDK 运行一个无状态查询。
 * 只消费 SDK 的 assistant/result 消息，不解析底层原始增量事件。
 */
function runCodebuddy(prompt, model, handlers, systemPrompt) {
  const controller = new AbortController();
  let settled = false;
  let cancelled = false;
  let sdkQuery;
  const finishError = (err) => {
    if (!settled && !cancelled) {
      settled = true;
      handlers.onError && handlers.onError(err);
    }
  };
  const timer = setTimeout(() => {
    finishError(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    controller.abort();
    void sdkQuery?.interrupt();
  }, REQUEST_TIMEOUT_MS);

  const task = (async () => {
    try {
      sdkQuery = queryImplementation({
        prompt,
        options: {
          abortController: controller,
          cwd: WORK_DIR,
          env: buildCleanEnv(),
          model,
          sessionId: randomUUID(),
          pathToCodebuddyCode: CODEBUDDY_BIN,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          // 硬性安全边界：本服务只返回 OpenAI tool_calls，永不执行本地工具。
          tools: [],
          permissionMode: 'default',
          persistSession: false,
          extraArgs: {
            'no-session-persistence': null,
          },
          // 关闭 SDK 的底层原始增量事件，仅消费稳定的 SDK 消息类型。
          includePartialMessages: false,
          systemPrompt: { append: systemPrompt || PURE_LLM_GUARD },
        },
      });
      activeQueries.add(sdkQuery);
      let gotResult = false;
      for await (const message of sdkQuery) {
        if (message.type === 'assistant') {
          const text = message.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
          const thinking = message.message.content
            .filter((block) => block.type === 'thinking')
            .map((block) => block.thinking)
            .join('');
          if (text) handlers.onTextDelta && handlers.onTextDelta(text);
          if (thinking) handlers.onThinkingDelta && handlers.onThinkingDelta(thinking);
          if (message.message.stop_reason) {
            handlers.onStopReason && handlers.onStopReason(message.message.stop_reason, message.message.usage);
          }
        } else if (message.type === 'result') {
          gotResult = true;
          if (message.is_error) {
            finishError(new Error(message.errors?.join('; ') || `CodeBuddy ${message.subtype}`));
          } else if (!settled) {
            settled = true;
            handlers.onResult && handlers.onResult(message);
          }
        }
      }
      if (!gotResult) finishError(new Error('CodeBuddy SDK ended without a result message'));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      finishError(new Error(`CodeBuddy SDK request failed: ${detail}`));
    } finally {
      clearTimeout(timer);
      if (sdkQuery) activeQueries.delete(sdkQuery);
      handlers.onExit && handlers.onExit();
    }
  })();

  return {
    done: task,
    kill() {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      void sdkQuery?.interrupt();
      void task.catch(() => {});
    },
  };
}

// ---------- 路由处理 ----------

function checkAuth(req) {
  if (!PROXY_API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${PROXY_API_KEY}`;
}

function handleModels(res) {
  const now = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: KNOWN_MODELS.map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'codebuddy',
    })),
  });
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return openaiError(res, 400, 'invalid JSON body');
  }

  const validationError = validateChatRequest(body);
  if (validationError) return openaiError(res, 400, validationError);

  const model = resolveModel(body.model);
  const prompt = messagesToPrompt(body.messages);
  const backendPrompt = hasImageInput(body.messages) ? imageMessageStream(body.messages, prompt) : prompt;
  const stream = body.stream === true;
  const includeUsage = body.stream_options && body.stream_options.include_usage === true;

  // 函数调用中继：解析客户端 tools，注入调用规则；tool_choice=none 时不进入函数模式
  const functions = normalizeFunctions(body.tools);
  const toolChoice = body.tool_choice || 'auto';
  const functionMode = functions.length > 0 && toolChoice !== 'none';
  const knownNames = new Set(functions.map((f) => f.name));
  const requiredToolName = toolChoice && typeof toolChoice === 'object'
    ? toolChoice.function?.name
    : null;
  if (requiredToolName && !knownNames.has(requiredToolName)) {
    return openaiError(res, 400, `tool_choice references an unknown function: ${requiredToolName}`);
  }
  const toolCallRequired = toolChoice === 'required' || Boolean(requiredToolName);
  if (toolCallRequired && functions.length === 0) {
    return openaiError(res, 400, 'tool_choice requires at least one function in tools');
  }
  const systemPrompt = functionMode
    ? `${FUNCTION_MODE_GUARD}\n\n${buildFunctionInstruction(functions, toolChoice)}`
    : PURE_LLM_GUARD;

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  console.log(`[${new Date().toISOString()}] chat.completions model=${model} stream=${stream} promptChars=${prompt.length}`);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    const sendChunk = (delta, finishReason = null, usage) => {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      if (usage) chunk.usage = usage;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const sendUsage = (usage) => {
      if (!includeUsage || !usage) return;
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage,
      })}\n\n`);
    };

    // 先发 role chunk（OpenAI 惯例）；函数模式下 content 为 null
    sendChunk(functionMode ? { role: 'assistant', content: null } : { role: 'assistant', content: '' });

    let finished = false;
    let stopReason = 'stop';
    let finalUsage = null;
    let hasToolCalls = false;
    let toolCallIndex = 0;
    let functionTextAcc = '';

    const onToolCall = (call) => {
      if (finished) return;
      hasToolCalls = true;
      const id = `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      sendChunk({
        tool_calls: [{
          index: toolCallIndex++,
          id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }],
      });
    };
    const onContent = (t) => { if (!finished && t) sendChunk({ content: t }); };

    // 函数模式用 FunctionCallParser 把 <function_call> 转成 tool_calls；
    // 否则用 ToolCallStripper 清理可能的 <tool_call> 包裹
    const parser = functionMode
      ? new FunctionCallParser(knownNames, onContent, onToolCall)
      : new ToolCallStripper();

    const proc = runCodebuddy(backendPrompt, model, {
      onTextDelta(text) {
        if (!finished) {
          if (functionMode) {
            // SDK 以完整 assistant 消息交付文本；等到 result 时统一解析，避免原始工具标签泄露。
            functionTextAcc += text;
          } else {
            const clean = parser.push(text);
            if (clean) sendChunk({ content: clean });
          }
        }
      },
      onThinkingDelta(text) {
        // 默认隐藏思考过程（HIDE_REASONING）；设 HIDE_REASONING=0 时以 reasoning_content 扩展字段透出
        if (!finished && !HIDE_REASONING) sendChunk({ reasoning_content: text });
      },
      onStopReason(reason, usage) {
        stopReason = mapStopReason(reason);
        if (usage) finalUsage = usageToOpenAI(usage);
      },
      onResult(evt) {
        if (finished) return;
        if (functionMode) {
          const { content, toolCalls } = extractFunctionCalls(functionTextAcc || String(evt.result || ''), knownNames);
          if (content) sendChunk({ content });
          for (const call of toolCalls) onToolCall(call);
        } else {
          const trailing = parser.flush();
          if (trailing) sendChunk({ content: trailing });
        }
        if (toolCallRequired && !hasToolCalls) {
          finished = true;
          res.write(`data: ${JSON.stringify({ error: { message: 'Model did not return the required tool call', type: 'server_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        finished = true;
        if (evt.usage) finalUsage = usageToOpenAI(evt.usage);
        const fr = hasToolCalls ? 'tool_calls' : stopReason;
        sendChunk({}, fr);
        sendUsage(finalUsage);
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError(err) {
        if (finished) return;
        finished = true;
        // 流已开启，只能以 SSE 错误事件形式输出
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onExit() {
        if (!finished) {
          finished = true;
          sendChunk({}, stopReason);
          sendUsage(finalUsage);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
    }, systemPrompt);

    req.on('close', () => {
      if (!finished) {
        finished = true;
        proc.kill();
      }
    });
  } else {
    // 非流式：等待 result 事件
    let responded = false;
    let textAcc = '';
    let stopReason = 'stop';

    const proc = runCodebuddy(backendPrompt, model, {
      onTextDelta(t) { textAcc += t; },
      onStopReason(r) { stopReason = mapStopReason(r); },
      onResult(evt) {
        if (responded) return;
        responded = true;
        const raw = evt.result != null ? String(evt.result) : textAcc;
        if (functionMode) {
          const { content, toolCalls } = extractFunctionCalls(raw, knownNames);
          const tool_calls = toolCalls.map((tc) => ({
            id: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
          if (toolCallRequired && tool_calls.length === 0) {
            return openaiError(res, 502, 'Model did not return the required tool call', 'server_error');
          }
          sendJson(res, 200, {
            id: completionId,
            object: 'chat.completion',
            created,
            model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: tool_calls.length ? (content || null) : content,
                ...(tool_calls.length ? { tool_calls } : {}),
              },
              finish_reason: tool_calls.length ? 'tool_calls' : stopReason,
            }],
            usage: usageToOpenAI(evt.usage),
          });
        } else {
          const content = stripToolCallsOnce(raw);
          sendJson(res, 200, {
            id: completionId,
            object: 'chat.completion',
            created,
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: stopReason,
            }],
            usage: usageToOpenAI(evt.usage),
          });
        }
      },
      onError(err) {
        if (responded) return;
        responded = true;
        openaiError(res, 500, err.message, 'server_error');
      },
    }, systemPrompt);

    req.on('close', () => {
      if (!responded) proc.kill();
    });
  }
}

// ---------- HTTP 服务器 ----------

let shuttingDown = false;
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (shuttingDown) return openaiError(res, 503, 'Server is shutting down', 'server_error');

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (url === '/health' || url === '/v1/health') {
    return sendJson(res, 200, { status: 'ok', backend: 'codebuddy-agent-sdk', tools: 'disabled', reasoning: HIDE_REASONING ? 'hidden' : 'visible' });
  }

  if (!checkAuth(req)) {
    return openaiError(res, 401, 'Invalid API key. Expected header: Authorization: Bearer <PROXY_API_KEY>', 'authentication_error');
  }

  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    return handleModels(res);
  }

  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    try {
      return await handleChatCompletions(req, res);
    } catch (err) {
      if (!res.headersSent) return openaiError(res, 500, err.message, 'server_error');
      try { res.end(); } catch {}
      return;
    }
  }

  openaiError(res, 404, `Unknown route: ${req.method} ${url}`);
});

function startServer() {
  server.listen(PORT, HOST, () => {
    console.log('╭──────────────────────────────────────────────────╮');
    console.log('│  codebuddycli-proxy — OpenAI-compatible gateway   │');
    console.log('╰──────────────────────────────────────────────────╯');
    console.log(`  Listening : http://${HOST}:${PORT}`);
    console.log(`  Endpoints : POST /v1/chat/completions | GET /v1/models | GET /health`);
    console.log(`  Backend   : CodeBuddy Agent SDK (models: ${KNOWN_MODELS.join(', ')})`);
    console.log(`  Auth      : ${PROXY_API_KEY ? 'Bearer key required' : 'disabled (local use)'}`);
    console.log('  CLI tools : disabled (tool calls are returned to the upstream agent)');
    console.log(`  Reasoning : ${HIDE_REASONING ? 'hidden (set HIDE_REASONING=0 to show)' : 'visible (reasoning_content)'}`);
    console.log(`  Work dir  : ${WORK_DIR}`);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received; aborting ${activeQueries.size} active request(s)...`);
  for (const sdkQuery of activeQueries) void sdkQuery.interrupt();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) startServer();

module.exports = {
  FunctionCallParser,
  ToolCallStripper,
  extractFunctionCalls,
  messagesToPrompt,
  normalizeFunctions,
  runCodebuddy,
  setQueryImplementation(implementation) { queryImplementation = implementation || query; },
  stripToolCallsOnce,
  usageToOpenAI,
};
