# UNFOLD — Node 24 for node:sqlite parity with local dev. Pure-JS deps
# (bcryptjs, express, jpeg-js) need no native build step, so -slim is enough.
FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
