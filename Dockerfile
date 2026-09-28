# Без npm-зависимостей (см. README) — сборка образа не требует npm install.
# node:22-slim: node:sqlite доступен без флага с Node 22.5+; engines.node требует >=22.13.0.
FROM node:22-slim

WORKDIR /app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
