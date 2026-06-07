# syntax=docker/dockerfile:1.6
FROM node:20-slim AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
      libcups2 libdrm2 libgbm1 libnss3 libxcomposite1 \
      libxdamage1 libxrandr2 xdg-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install before NODE_ENV=production — Coolify may inject production at build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/session /app/logs /app/uploads \
 && useradd -m appuser \
 && chown -R appuser:appuser /app

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3264 \
    HOST=0.0.0.0

USER appuser

EXPOSE 3264

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3264) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "index.js"]
