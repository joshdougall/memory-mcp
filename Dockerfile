FROM node:22-slim

WORKDIR /app

COPY --chown=node:node package*.json .
RUN npm ci --omit=dev

COPY --chown=node:node server.js .

EXPOSE 8000
USER node
CMD ["node", "server.js"]
