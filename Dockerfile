FROM node:24-alpine

WORKDIR /app

# 直连版只使用 Node 内置模块：镜像不包含 npm 依赖、包清单或锁文件。
COPY --chown=node:node server.js ./
COPY --chown=node:node lib/ ./lib/

RUN mkdir -p /app/workspace && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORK_DIR=/app/workspace

VOLUME ["/app/workspace"]
EXPOSE 8787

CMD ["node", "server.js"]
