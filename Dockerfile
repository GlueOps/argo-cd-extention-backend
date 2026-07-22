# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

# Copy the package manifests (package.json + lockfile) first for better layer
# caching, then install with a strict, reproducible `npm ci` against the committed
# package-lock.json (fails fast on any lockfile drift).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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
