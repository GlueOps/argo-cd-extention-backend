# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Copy manifests first for better layer caching. Prefer reproducible installs:
# `npm ci` uses the committed package-lock.json. Commit that lockfile so image
# builds are deterministic; the `||` keeps builds working until it's committed.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

ENV PORT=8000 \
    NODE_ENV=production
EXPOSE 8000

# Run as a non-root user. node:*-alpine ships an unprivileged `node` user (uid 1000);
# this pairs with the Deployment's runAsNonRoot/readOnlyRootFilesystem securityContext.
USER node

# Container-level health signal for `docker run`; Kubernetes uses its own probes.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
