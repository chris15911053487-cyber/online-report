# 多阶段构建：自动编译前端，确保每次部署包含最新前端代码
# 使用方式：docker compose -f docker-compose.deploy.yml up -d --build

# Stage 1: 构建前端 (React + Vite)
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /frontend-build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: 生产运行镜像
FROM node:20-bookworm-slim
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ .

# 从 Stage 1 复制前端构建产物，路径与服务器代码中 repoRoot/frontend/dist 一致
COPY --from=frontend-builder /frontend-build/dist /frontend/dist

RUN chown -R node:node /app /frontend

ENV NODE_ENV=production
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
