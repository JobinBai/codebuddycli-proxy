FROM node:22-bookworm-slim

WORKDIR /app

RUN chown node:node /app

USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js ./

RUN mkdir -p /app/workspace

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORK_DIR=/app/workspace

VOLUME ["/app/workspace"]
EXPOSE 8787

CMD ["node", "server.js"]
