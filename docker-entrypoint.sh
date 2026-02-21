#!/bin/sh
# Fix ownership of mounted volumes so appuser (uid 1000) can write to them.
# This runs briefly as root before dropping to appuser via su-exec.
set -e

for dir in /app/data /app/downloads /app/converted /app/uploads; do
    mkdir -p "$dir"
    chown appuser:appgroup "$dir"
done

# Drop to appuser and start the application
exec su-exec appuser uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers
