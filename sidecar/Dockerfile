FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --production && rm -rf /root/.npm

COPY ssh-sidecar.js ./

RUN groupadd -g 2000 anima && useradd -r -u 2000 -g 2000 anima \
    && mkdir -p /data /run/ssh-sidecar \
    && chown -R anima:anima /app /data /run/ssh-sidecar

USER anima

CMD ["node", "ssh-sidecar.js"]
