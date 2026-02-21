# Security Policy

## Supported Versions

Only the latest release of GrabSter is actively maintained and receives security patches.

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security issue, please report it privately:

1. **Open a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)** on this repository.
2. Alternatively, email the maintainers directly with subject line `[SECURITY] GrabSter vulnerability`.

Please include:

- A clear description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations (optional but appreciated)

You will receive an acknowledgment within **48 hours** and a status update within **7 days**.

## Security Design Notes

- **JWT tokens** are signed with a secret key that must be set via environment variable. The app refuses to start with the default placeholder.
- **Passwords** are hashed using PBKDF2-SHA256 via `passlib`.
- **Authentication cookies** are set with `HttpOnly` and `SameSite=Lax`. Enable `COOKIE_SECURE=true` when serving over HTTPS.
- **Rate limiting** on login: 5 attempts per IP per minute.
- **Debug endpoints** (`/docs`, `/redoc`, `/openapi.json`) are disabled by default and only accessible when `DEBUG=true`.
- **Security headers** (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) are set on every response.
- **File conversion** accepts only an allowlisted set of output formats.
- GrabSter is designed for **self-hosted, trusted-network use**. It is not recommended to expose it directly to the public internet without an authenticating reverse proxy (e.g., nginx + Authelia).
