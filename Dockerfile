FROM node:22-bookworm-slim

WORKDIR /app

RUN chown node:node /app

USER node

# 直连版无运行时依赖（仅用 Node 内置模块），无需 npm install
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node lib/ ./lib/

RUN mkdir -p /app/workspace

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORK_DIR=/app/workspace

VOLUME ["/app/workspace"]
EXPOSE 8787

CMD ["node", "server.js"]
