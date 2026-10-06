FROM node:22-slim

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# server.js is not standalone any more: it imports ./semantic/*, which imports
# ../compact/graph.js, so every local module it can reach at runtime has to be
# in the image or it dies on module resolution at startup. scripts/ carries the
# embedding backfill, which is run inside the container after a deploy.
COPY --chown=node:node server.js .
COPY --chown=node:node semantic ./semantic
COPY --chown=node:node compact ./compact
COPY --chown=node:node scripts ./scripts

# transformers.js caches the model inside its own package directory at run
# time. npm ci runs as root, so that tree is root owned and the node user
# cannot create the cache: every embed then fails with EACCES and search
# silently degrades to keyword only. The Docker build job only builds the
# image, it never runs it, so nothing in CI catches this.
RUN mkdir -p node_modules/@huggingface/transformers/.cache \
 && chown -R node:node node_modules/@huggingface/transformers/.cache

EXPOSE 8000
USER node
CMD ["node", "server.js"]
