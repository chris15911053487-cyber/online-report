FROM python:3.12-slim

# 清华源在部分 Docker 构建环境会 403，默认改用阿里云；可 build-arg 覆盖：
# docker compose -f docker-compose.deploy.yml build --build-arg PIP_INDEX_URL=https://pypi.org/simple ai-agent
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=mirrors.aliyun.com

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# checkpoint 持久化目录（compose 挂卷到 /data）
RUN mkdir -p /data

# 仅内网监听；不对公网映射端口（见 docker-compose）
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
