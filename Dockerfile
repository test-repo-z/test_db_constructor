FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY config ./config
COPY db ./db
COPY src ./src
COPY scripts ./scripts
# data/ (resolution manifest) and benchmarks/ are written by the CLI scripts, so the unprivileged
# `node` user must own them when the scripts are run inside the container.
COPY --chown=node:node data ./data
RUN mkdir -p benchmarks/results benchmarks/reports && chown -R node:node benchmarks
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
