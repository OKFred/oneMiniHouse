FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --chmod=0444 supervisor.py /app/supervisor.py
USER 10001:10001
CMD ["python", "/app/supervisor.py", "--config", "/app/config.json"]
