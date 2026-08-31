FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev
COPY apps/fake-waxum/server.mjs apps/fake-waxum/server.mjs
CMD ["node", "apps/fake-waxum/server.mjs"]
