# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage – install Python dependencies
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS builder

WORKDIR /build

# Install build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --prefix=/install --no-cache-dir -r requirements.txt


# ---------------------------------------------------------------------------
# Runtime stage – minimal image
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# Install ffmpeg (required for video conversion) + gosu for privilege drop
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (entrypoint will drop to this user)
RUN groupadd --gid 1000 appgroup && \
    useradd --uid 1000 --gid appgroup --no-create-home --shell /bin/false appuser

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY --chown=appuser:appgroup app/ ./app/

# Write entrypoint inline (avoids CRLF line-ending issues from Windows dev machines)
RUN printf '#!/bin/sh\nset -e\nfor dir in /app/data /app/downloads /app/converted /app/uploads; do\n    mkdir -p "$dir"\n    chown appuser:appgroup "$dir"\ndone\nexec gosu appuser uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers\n' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

# Volumes – created here as placeholders; actual ownership fixed by entrypoint
RUN mkdir -p data downloads converted uploads

EXPOSE 8000

# Logs to stdout (no log file needed – Docker captures stdout/stderr)
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# Entrypoint fixes volume permissions then drops to appuser
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
