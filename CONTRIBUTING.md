# Contributing to GrabSter

Thank you for your interest in contributing! GrabSter is a self-hosted media downloader built for security and ease of deployment.

## Getting Started

### Prerequisites

- Python 3.11+
- Docker & Docker Compose
- FFmpeg (for local development without Docker)

### Local Development Setup

```bash
# 1. Clone the repository
git clone https://github.com/your-username/grabster.git
cd grabster

# 2. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate   # Linux/macOS
# .venv\Scripts\activate    # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Set up environment variables
cp .env.example .env
# Edit .env: set SECRET_KEY to any random string (for dev, anything works)
# Set DEBUG=true and COOKIE_SECURE=false for local HTTP

# 5. Run the development server
uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

Alternatively, use Docker Compose for a closer-to-production environment:

```bash
cp .env.example .env
# Edit .env as above
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

## Code Style

- **Python**: Follow [PEP 8](https://pep8.org/). Use `logging` instead of `print()`.
- **Security first**: Never hardcode secrets or credentials. All config via environment variables.
- **Type hints**: Add type annotations to all new functions.
- **Error handling**: Return appropriate HTTP status codes. Never leak stack traces to the client.

## Pull Request Guidelines

1. **Fork** the repo and create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes, including any necessary tests.
3. Ensure your code is clean: no debug `print()` statements, no commented-out code.
4. **Open a Pull Request** against `main` with a clear description of what changed and why.

## Reporting Bugs

Open a GitHub Issue with:
- Steps to reproduce
- Expected vs. actual behavior
- Your deployment method (Docker / bare metal)
- Relevant logs (scrub any sensitive info)

## Security Issues

**Do not open public issues for security vulnerabilities.** See [SECURITY.md](SECURITY.md) for the responsible disclosure process.
