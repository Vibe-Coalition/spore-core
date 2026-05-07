FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends make g++ openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm

COPY ssh-sidecar.js ./

RUN groupadd -g 2000 spore && useradd -u 2000 -g 2000 -m -s /usr/sbin/nologin spore \
    && mkdir -p /data /run/ssh-sidecar /tmp \
    && chown -R spore:spore /app /data /run/ssh-sidecar /tmp

USER spore

CMD ["node", "ssh-sidecar.js"]
