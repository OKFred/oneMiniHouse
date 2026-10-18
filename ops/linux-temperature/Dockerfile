# syntax=docker/dockerfile:1
# Build from the repository root; Dockerfile.dockerignore excludes private files.
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
       ca-certificates python3 python3-paho-mqtt smartmontools \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 collector \
    && useradd --uid 10001 --gid 10001 --no-create-home \
       --shell /usr/sbin/nologin collector \
    && python3 -c 'import paho.mqtt; assert paho.mqtt.__version__.split(".")[0] == "2"'

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CREDENTIALS_DIRECTORY=/run/secrets

WORKDIR /app
COPY --chmod=0444 ops/linux-temperature/agent.py ops/linux-temperature/smart_reader.py ops/linux-temperature/healthcheck.py ./
COPY --chmod=0444 ops/host-temperature/read-temperatures.sh ./

USER 10001:10001
CMD ["python3", "/app/agent.py", "--config", "/run/secrets/config.json", "--data", "/var/lib/one-minihouse-temperature-mqtt"]
