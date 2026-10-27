FROM python:3.13-slim-bookworm AS dependencies
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
COPY requirements.txt /requirements.txt
RUN pip install --require-hashes --only-binary=:all: --no-deps --no-compile --target /dependencies -r /requirements.txt

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/vendor
WORKDIR /app
COPY --from=dependencies --chmod=0555 /dependencies /app/vendor
COPY --chmod=0444 receiver.py /app/receiver.py
USER 10001:10001
CMD ["python", "/app/receiver.py", "--config", "/app/config.json"]
