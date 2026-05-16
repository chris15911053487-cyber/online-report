# Build context MUST be the repo root (directory that contains both `frontend/` and `server/`).
# Correct: from repo root → `docker compose -f docker-compose.deploy.yml build`
# Wrong: `cd server && docker build -f Dockerfile .` (no `frontend/` in context; COPY below fails).

# --- Build React + Vite frontend (output: /frontend/dist) ---
FROM node:20-bookworm AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci && npm cache clean --force
COPY frontend/ ./
RUN npm run build

# --- Production: Fastify + built static app ---
FROM node:20-bookworm-slim

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./
COPY --from=frontend-builder /frontend/dist /frontend/dist
RUN chown -R node:node /app /frontend/dist

ENV NODE_ENV=production
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
