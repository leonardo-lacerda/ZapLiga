FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ADBUTILS_ADB_PATH=/usr/bin/adb \
    WORKER_DEBUG_DIR=/tmp/geelark-worker-debug \
    WORKER_DATA_DIR=/data

# adb do Debian (o adbutils fala com o servidor adb que ele mesmo sobe).
RUN apt-get update \
    && apt-get install -y --no-install-recommends adb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# Usuário sem root; o HOME guarda as chaves do adb (~/.android).
# /data: memória de telas aprendidas e arquivo de telas reais (volume no compose).
RUN useradd --create-home --uid 10001 worker && mkdir -p /data && chown worker:worker /data
USER worker

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
