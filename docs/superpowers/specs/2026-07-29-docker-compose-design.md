# Docker Compose 部署设计

## 目标

提供开箱可运行的 Docker Compose 配置，用 Docker Hub 已发布镜像部署代理，同时避免将任何 API 密钥纳入版本控制。

## 文件与配置

- `docker-compose.yml` 使用 `jobinbai/codebuddycli-proxy:latest`，发布宿主机 `8787` 到容器 `8787`。
- 服务通过同目录 `.env` 读取 `CODEBUDDY_API_KEY`、`PROXY_API_KEY` 与可选的 `CODEBUDDY_INTERNET_ENVIRONMENT`；Compose 文件不含密钥字面值。
- `.env.example` 说明必填项和中国版 CodeBuddy 的推荐环境值，供用户复制为 `.env`。
- 使用名为 `codebuddy-workspace` 的 Docker 命名卷持久化 `/app/workspace`。
- 设置 `restart: unless-stopped` 和针对 `/health` 的容器健康检查。

## 运行与验证

用户复制 `.env.example` 为 `.env` 并填入真实密钥后，运行 `docker compose up -d`。实现完成后以 `docker compose config` 验证插值后的 Compose 语法；不在验证中启动需要真实 CodeBuddy 密钥的服务。
