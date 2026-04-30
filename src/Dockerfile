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
    netcat-openbsd \
    mosh \
    parallel \
    slurm-client \
    htop less tree file \
    rsync zip unzip \
    net-tools iputils-ping dnsutils \
    ca-certificates gnupg \
    # Chromium system dependencies for Playwright
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

## ── Tailscale (private-tailnet access, userspace mode) ─────────────
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
      | tee /usr/share/keyrings/tailscale-archive-keyring.gpg > /dev/null \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
      | tee /etc/apt/sources.list.d/tailscale.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends tailscale \
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
    zendriver \
    requests \
    pyyaml \
    Pillow \
    edge-tts

WORKDIR /app

## ── Node dependencies (cached unless package.json changes) ────────
# Build context is the repo root; src/ lives next to the top-level plugins/.
COPY src/package.json ./
RUN npm install --production && npm cache clean --force

## ── Pre-install Chromium for Playwright browser tool ──────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright-core install chromium

## ── Application code (changes frequently — fast layer) ────────────
COPY src/index.js src/app.js src/config.js src/test.js ./
COPY src/spore.json ./
COPY src/seed-graph.sql ./
COPY src/graph/ ./graph/
COPY src/agent/ ./agent/
COPY src/workers/ ./workers/
COPY src/gateways/ ./gateways/
COPY src/providers/ ./providers/
COPY src/tools/ ./tools-default/
COPY src/voice/ ./voice/
COPY src/static/ ./static/
# Plugin manager core (api.js, manager.js, openclaw-adapter.js, index.js).
COPY src/plugins/ ./plugins/
# Bundled plugin packages live at the repo root (../plugins/ relative to src/).
# Layered on top of the manager files; manager.loadAll() filters to subdirs
# with manifests, so the .js files at the top level are ignored.
COPY plugins/ ./plugins/
COPY src/lib/ ./lib/
COPY src/reference-nodes.sql ./
COPY src/migrate-ref-email.sql ./

RUN groupadd -g 2000 spore && useradd -r -u 2000 -g 2000 spore \
    && mkdir -p /data /workspace /app/tools \
    && chown -R spore:spore /app /data /workspace /opt/pw-browsers \
    && echo 'spore ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/sbin/cron, /usr/bin/tailscale' > /etc/sudoers.d/spore-apt \
    && chmod 0440 /etc/sudoers.d/spore-apt

COPY src/entrypoint.sh ./entrypoint.sh
COPY src/cron-wrapper.sh /usr/local/bin/cron
COPY src/crontab-wrapper.sh /usr/local/bin/crontab
RUN chmod +x ./entrypoint.sh
RUN chmod +x /usr/local/bin/cron
RUN chmod +x /usr/local/bin/crontab

HEALTHCHECK --interval=30s --timeout=60s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${SPORE_HEALTH_PORT:-18790}/health || exit 1

ENV NODE_ENV=production
ENV SPORE_LOG_LEVEL=info

STOPSIGNAL SIGTERM

CMD ["/bin/sh", "./entrypoint.sh"]
