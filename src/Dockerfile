FROM node:22-slim

## ── System packages ────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git jq bc \
    cron \
    sudo \
    sqlite3 \
    ffmpeg \
    imagemagick \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    python3-numpy \
    python3-pil \
    python3-opencv \
    libegl1-mesa-dev \
    libgl1-mesa-glx \
    libsndfile1 \
    make g++ \
    vim nano \
    tmux screen \
    openssh-client \
    htop less tree file \
    rsync zip unzip \
    net-tools iputils-ping dnsutils \
    # Chromium system dependencies for Playwright
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

## ── Python packages (heavy, rarely changing — cached layer) ───────
RUN pip3 install --break-system-packages --no-cache-dir \
    scipy \
    librosa \
    soundfile \
    moderngl \
    av \
    pedalboard \
    curl-cffi \
    requests \
    pyyaml \
    Pillow \
    edge-tts

WORKDIR /app

## ── Node dependencies (cached unless package.json changes) ────────
COPY package.json ./
RUN npm install --production && npm cache clean --force

## ── Pre-install Chromium for Playwright browser tool ──────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright-core install chromium

## ── Application code (changes frequently — fast layer) ────────────
COPY index.js app.js config.js test.js ./
COPY anima.json ./
COPY seed-graph.sql ./
COPY graph/ ./graph/
COPY agent/ ./agent/
COPY workers/ ./workers/
COPY gateways/ ./gateways/
COPY providers/ ./providers/
COPY tools/ ./tools-default/
COPY voice/ ./voice/
COPY static/ ./static/
COPY plugins/ ./plugins/

RUN groupadd -g 2000 anima && useradd -r -u 2000 -g 2000 anima \
    && mkdir -p /data /workspace /app/tools \
    && chown -R anima:anima /app /data /workspace /opt/pw-browsers \
    && echo 'anima ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/sbin/cron' > /etc/sudoers.d/anima-apt \
    && chmod 0440 /etc/sudoers.d/anima-apt

COPY entrypoint.sh ./entrypoint.sh
COPY cron-wrapper.sh /usr/local/bin/cron
COPY crontab-wrapper.sh /usr/local/bin/crontab
RUN chmod +x ./entrypoint.sh
RUN chmod +x /usr/local/bin/cron
RUN chmod +x /usr/local/bin/crontab

HEALTHCHECK --interval=30s --timeout=60s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${ANIMA_HEALTH_PORT:-18790}/health || exit 1

ENV NODE_ENV=production
ENV ANIMA_LOG_LEVEL=info

STOPSIGNAL SIGTERM

CMD ["/bin/sh", "./entrypoint.sh"]
