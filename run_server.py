"""
Local development launcher for GrabSter.

Automatically loads .env from the project root, then starts uvicorn.
Ensures WindowsProactorEventLoop is set before any imports on Windows.

Usage:
    python run_server.py
"""
import sys
import os
import asyncio
from pathlib import Path

# ── 1. Load .env file if present ──────────────────────────────────────────
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())
    print(f"[INFO] Loaded environment from {env_path}")
else:
    print(f"[WARN] No .env file found at {env_path}")
    print("[WARN] Copy .env.example to .env and set your SECRET_KEY.")

# ── 2. Windows: set ProactorEventLoop BEFORE importing uvicorn/FastAPI ────
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

# ── 3. Start server ───────────────────────────────────────────────────────
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8001,
        reload=False,
        loop="asyncio",
    )
