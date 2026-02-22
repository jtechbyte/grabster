# GrabSter

**Self-hosted media downloader and converter** — download videos from YouTube, Vimeo, and 1000+ other sites. Built for security, clean deployment, and easy self-hosting.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue.svg)
![Python](https://img.shields.io/badge/python-3.11-blue.svg)

---

## Features

- 📥 **Download** video and audio from YouTube and 1000+ sites (via yt-dlp)
- 🎬 **Convert** uploaded video files with FFmpeg (mp4, mkv, webm, mp3, m4a, and more)
- 📚 **Library** — tag downloads into a personal video library with a built-in player
- 👤 **Multi-user** — admin panel, user management, role-based access control
- 🔒 **Secure by default** — JWT auth, HttpOnly cookies, strict security headers, rate limiting
- 🐳 **Docker-first** — one command to deploy

---

## Screenshots

| Login | Dashboard |
|-------|-----------|
| ![Login page](docs/screenshots/login.png?v=2) | ![Dashboard](docs/screenshots/dashboard.png?v=2) |

| Video Fetcher | My Library |
|--------------|------------|
| ![Video fetcher](docs/screenshots/fetcher.png?v=2) | ![Library](docs/screenshots/library.png?v=2) |

---

## Tech Stack

| Layer       | Technology               |
|-------------|--------------------------|
| Backend     | FastAPI (Python 3.11)    |
| Auth        | JWT (python-jose) + PBKDF2-SHA256  |
| Database    | SQLite                   |
| Downloader  | yt-dlp                   |
| Converter   | FFmpeg                   |
| Frontend    | Vanilla JS + Jinja2 HTML |
| Deployment  | Docker + Docker Compose  |

---

## Architecture

```
┌─────────────────────────────────────┐
│           Browser Client            │
│  (Vanilla JS, WebSocket for progress)│
└────────────────┬────────────────────┘
                 │ HTTPS
┌────────────────▼────────────────────┐
│         FastAPI Application          │
│  ┌──────────┐  ┌───────────────────┐│
│  │ Auth/JWT │  │ Download Manager  ││
│  └──────────┘  │  (yt-dlp worker)  ││
│  ┌──────────┐  └───────────────────┘│
│  │ Settings │  ┌───────────────────┐│
│  └──────────┘  │ Convert Manager   ││
│                │  (FFmpeg worker)  ││
│  ┌──────────┐  └───────────────────┘│
│  │ SQLite   │                        │
│  │ (data/)  │                        │
│  └──────────┘                        │
└─────────────────────────────────────┘
```

Data is persisted in Docker volumes and never stored in the container image.

---

## Quick Start (Docker)

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2+
- A machine with internet access

### Deploy in 3 steps

```bash
# 1. Clone the repository
git clone https://github.com/your-username/grabster.git
cd grabster

# 2. Configure environment
cp .env.example .env
```

Edit `.env` and set a strong `SECRET_KEY`:

```bash
# Generate a secure key:
openssl rand -hex 32
```

```bash
# 3. Start GrabSter
docker compose up -d

# Then open: http://localhost:8001
```

On first launch, register a new account. **The first registered user is automatically made an Admin.** 
If you need to manually promote another user to admin via the command line, run:
```bash
docker exec -it grabster sqlite3 /app/data/app.db "UPDATE users SET role = 'admin' WHERE username = 'YOUR_USERNAME';"
```

---

## Environment Variables

All configuration is done via environment variables in your `.env` file.

| Variable        | Required | Default      | Description                                                  |
|----------------|----------|--------------|--------------------------------------------------------------|
| `SECRET_KEY`    | ✅ Yes   | —            | JWT signing secret. Generate with `openssl rand -hex 32`.   |
| `PORT`          | No       | `8000`       | Host port to bind.                                           |
| `DEBUG`         | No       | `false`      | Enables `/docs`, `/redoc`, verbose logging. **Off in prod.** |
| `DB_PATH`       | No       | `data/app.db`| Path to SQLite database file.                                |
| `DOWNLOAD_DIR`  | No       | `downloads`  | *Note: Managed internally via Settings UI (DB).*             |
| `CONVERT_DIR`   | No       | `converted`  | Directory for FFmpeg output files.                           |
| `COOKIE_SECURE` | No       | `false`      | Set to `true` if hosting behind an HTTPS TLS reverse proxy.  |

---

## Development

```bash
cp .env.example .env
# Set DEBUG=true, COOKIE_SECURE=false, SECRET_KEY=any-dev-string

docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
# App runs on http://localhost:8001 with live reload
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full local setup instructions.

---

## Security

GrabSter is designed and hardened for self-hosted deployments:

- 🔑 **JWT tokens** signed with a user-provided secret key (required, no defaults)
- 🔒 **HttpOnly + SameSite cookies** — tokens are not accessible via JavaScript
- 🛡️ **Security headers** on every response (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
- 🚦 **Rate limiting** — 5 login attempts per IP per minute
- 🚫 **Debug endpoints disabled** in production (no `/docs`, `/openapi.json`)
- 👤 Non-root Docker container user (uid 1000)
- 🗂️ Input validation with allowlists for file conversion formats

**Recommendation**: Place GrabSter behind a reverse proxy (e.g., nginx or Caddy) with TLS. Do not expose it directly to the public internet without additional authentication.

---

## Volumes & Data

All user data lives in Docker volumes, not in the image. On a `docker compose down`, your data is preserved. To fully reset, remove the local directories:

```
data/       ← SQLite database
downloads/  ← Downloaded media
converted/  ← Converted output files
uploads/    ← Temporary upload staging (auto-cleared)
```

---

## License

[MIT License](LICENSE) — free to use, modify, and self-host.

---

## Reporting Security Issues

See [SECURITY.md](SECURITY.md). Please do not open public GitHub issues for security vulnerabilities.
