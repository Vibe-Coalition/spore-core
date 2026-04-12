FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY static/ ./static/

RUN groupadd -r manager && useradd -r -g manager -d /app -s /sbin/nologin manager \
    && chown -R manager:manager /app

USER manager

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const h=require('http');h.get('http://localhost:'+process.env.MANAGER_PORT+'/api/auth/check',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
