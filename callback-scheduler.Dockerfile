FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi \
    && npm install --no-save --omit=dev --no-audit --no-fund bullmq@5.81.4 ioredis@5.9.3

COPY . .

CMD ["node", "callback-scheduler.js"]
