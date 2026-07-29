# codebuddycli-proxy

将 CodeBuddy Agent SDK 封装为 **OpenAI Chat Completions 兼容 API**，供 Cherry Studio、OpenAI SDK、LangChain 等客户端或 Agent 接入。

它是一个纯模型网关：服务端不执行命令、读写文件、调用 MCP 或访问数据库。若模型请求工具，代理只返回标准 OpenAI `tool_calls`；由接入该 API 的 Agent 在自己的环境中决定是否执行。

## 支持范围

- `POST /v1/chat/completions`：流式 SSE 与非流式响应
- `GET /v1/models`：可用模型列表
- `GET /health`、`GET /v1/health`：健康检查
- OpenAI `messages`、`system` / `developer` 消息、多轮上下文
- OpenAI function calling / `tool_calls` 中继
- PNG、JPEG、WebP 的 Base64 `image_url` 输入

不提供 `/v1/embeddings`、`/v1/responses` API。服务不保存请求正文、工具参数或模型响应。

## 安全边界

每次模型请求都通过 CodeBuddy Agent SDK 的受限配置执行：

- 内置工具固定为 `[]`
- MCP 固定为空配置
- 不加载本地 CodeBuddy 设置
- 不持久化会话

因此，数据库查询、Shell 命令、文件操作等工具必须由上游 Agent 接到 `tool_calls` 后在它自己的受控环境中执行。请始终设置 `PROXY_API_KEY`，并避免把服务端口直接暴露到公网。

## 快速开始

要求：Node.js 18 或更高版本，以及有效的 CodeBuddy API Key。

```bash
npm install

CODEBUDDY_API_KEY="你的 CodeBuddy API Key" \
CODEBUDDY_INTERNET_ENVIRONMENT=internal \
PROXY_API_KEY="替换为强随机密钥" \
node server.js
```

服务默认监听 `http://127.0.0.1:8787`。

`CODEBUDDY_INTERNET_ENVIRONMENT=internal` 用于中国版 CodeBuddy API Key；海外版不要设置，iOA 环境使用 `ioa`。该部署方式只依赖环境变量中的 API Key，不依赖宿主机 `~/.codebuddy` 的登录信息。

## Docker 部署

Docker Hub 镜像：[jobinbai/codebuddycli-proxy](https://hub.docker.com/r/jobinbai/codebuddycli-proxy)

```bash
docker pull jobinbai/codebuddycli-proxy:latest
```

推荐启动方式：

```bash
docker run -d \
  --name codebuddycli-proxy \
  --restart unless-stopped \
  -p 8787:8787 \
  -e CODEBUDDY_API_KEY="你的 CodeBuddy API Key" \
  -e CODEBUDDY_INTERNET_ENVIRONMENT=internal \
  -e PROXY_API_KEY="替换为强随机密钥" \
  jobinbai/codebuddycli-proxy:latest
```

容器镜像不包含密钥。请在运行时通过环境变量或密钥管理服务注入；不要把真实密钥提交到仓库、镜像或日志中。

## 调用 Chat Completions

`stream` 默认为 `false`。设置为 `true` 时，服务返回 OpenAI 格式的 SSE 数据流，并以 `data: [DONE]` 结束。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer 替换为你的代理密钥' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "hy3",
    "messages": [{"role": "user", "content": "写一首五言绝句"}]
  }'
```

流式请求：

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer 替换为你的代理密钥' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "hy3",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

SDK 会在助手消息完成后提供稳定消息，因此 SSE 格式兼容 OpenAI，但不保证底层逐 token 的增量速度。

### OpenAI SDK（Python）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="替换为你的代理密钥",
)

response = client.chat.completions.create(
    model="hy3",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
```

## 工具调用：由上游 Agent 执行

向请求提供标准 OpenAI `tools` 定义后，模型会返回 `tool_calls`。代理不会执行函数；你的 Agent 应执行工具、把结果作为 `role: "tool"` 消息回传，再发起下一次请求。

```json
{
  "model": "hy3",
  "messages": [{"role": "user", "content": "查询 t_standard 的数量"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "execute_sql",
      "description": "在业务数据库执行只读 SQL",
      "parameters": {
        "type": "object",
        "properties": {"sql": {"type": "string"}},
        "required": ["sql"]
      }
    }
  }]
}
```

返回的 `tool_calls` 示例：

```json
{
  "tool_calls": [{
    "id": "call_xxx",
    "type": "function",
    "function": {"name": "execute_sql", "arguments": "{\"sql\":\"SELECT COUNT(*) AS cnt FROM t_standard\"}"}
  }]
}
```

执行结果由上游 Agent 以如下消息继续对话：

```json
{"role": "tool", "tool_call_id": "call_xxx", "content": "{\"cnt\": 42}"}
```

## 图片输入

仅接受 OpenAI `image_url` 的 PNG、JPEG、WebP Base64 data URL；不支持远程 URL。单张图片最大 10 MiB。

```bash
IMAGE_BASE64=$(base64 -i /path/to/image.png | tr -d '\n')

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer 替换为你的代理密钥' \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\": \"hy3\",
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"text\", \"text\": \"请描述这张图片\"},
        {\"type\": \"image_url\", \"image_url\": {
          \"url\": \"data:image/png;base64,$IMAGE_BASE64\"
        }}
      ]
    }]
  }"
```

图片的 MIME 类型必须和 data URL 中的实际格式匹配，例如 PNG 使用 `data:image/png;base64,...`。

## 模型与接口

可用模型：`auto`、`hy3`、`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、`minimax-m3`、`kimi-k3-1`、`kimi-k2.7`、`kimi-k2.6`、`deepseek-v4-flash`、`deepseek-v4-pro`。

传入未知模型名时回退到 `DEFAULT_MODEL`（默认 `auto`）。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer 替换为你的代理密钥'

curl http://127.0.0.1:8787/health
```

除健康检查外，API 在配置 `PROXY_API_KEY` 后都需要：

```text
Authorization: Bearer <PROXY_API_KEY>
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 监听端口。 |
| `HOST` | `127.0.0.1` | 监听地址。对外服务时改为 `0.0.0.0`，并设置 `PROXY_API_KEY`。 |
| `PROXY_API_KEY` | 空 | 客户端 Bearer Token。生产环境必须设置。 |
| `CODEBUDDY_API_KEY` | 空 | 传给 CodeBuddy SDK 的 API Key。 |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | 空 | 中国版使用 `internal`；iOA 使用 `ioa`。 |
| `CODEBUDDY_AUTH_TOKEN` | 空 | 可选的 CodeBuddy 认证 Token。 |
| `CODEBUDDY_BIN` | SDK 内置 CLI | 可选的 CodeBuddy CLI 绝对路径。 |
| `DEFAULT_MODEL` | `auto` | 未知模型名时使用的模型。 |
| `HIDE_REASONING` | `1` | 设为 `0` 时输出 `reasoning_content` 扩展字段；默认隐藏。 |
| `REQUEST_TIMEOUT_MS` | `600000` | 单请求超时（毫秒）。 |
| `WORK_DIR` | `~/.codebuddycli-proxy/workspace` | SDK 查询工作目录。 |

## 故障排查

- `401 Authentication required`：检查 `CODEBUDDY_API_KEY` 是否有效；中国版还需设置 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`。不要依赖容器外的 CLI 登录状态。
- `Invalid API key`：请求的 `Authorization` 值必须与 `PROXY_API_KEY` 完全一致。
- `image_url must be ... Base64 data URL`：仅使用 PNG/JPEG/WebP 的 `data:image/...;base64,...`，不要传远程图片链接。
- 返回 `tool_calls`：这是预期行为。请由上游 Agent 执行工具后，将 `role: "tool"` 结果发回。

## 开发

```bash
npm test
node --check server.js
```

项目使用官方 `@tencent-ai/agent-sdk`，其内置 CodeBuddy CLI，无需单独安装全局 CodeBuddy 命令。
