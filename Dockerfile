FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY api ./api
COPY public ./public

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
