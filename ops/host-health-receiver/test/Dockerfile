FROM python:3.13-slim-bookworm
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /requirements.txt
RUN pip install --require-hashes --only-binary=:all: --no-deps --no-compile -r /requirements.txt
USER 10001:10001
ENTRYPOINT ["python3"]
