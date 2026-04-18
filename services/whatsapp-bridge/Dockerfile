# WhatsApp bridge — Express + whatsapp-web.js (Puppeteer/Chromium).
#
# Runs on the VPS alongside the Seraphine backend so the LLM tools
# (whatsapp_send_message / whatsapp_send_voice) can reach it over the
# private `seraphine-net` Docker network at http://whatsapp-bridge:3001.
#
# Chromium is downloaded by npm postinstall (puppeteer bundle). The apt
# libs below are its runtime deps on Debian bookworm; without them the
# headless browser crashes on launch with "error while loading shared
# libraries" and whatsapp-web.js never reaches the QR step.

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation dumb-init wget xdg-utils lsb-release \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libgcc-s1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
    libxrandr2 libxshmfence1 libxtst6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `patches/` must be present when npm runs postinstall (patch-package).
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV NODE_ENV=production
EXPOSE 3001

# dumb-init reaps Chromium's orphaned child processes so the container
# doesn't accumulate zombies over long-running sessions.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
