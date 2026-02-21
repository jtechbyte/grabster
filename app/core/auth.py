import os
import logging
from datetime import datetime, timedelta
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi.security import OAuth2PasswordBearer
from fastapi import Depends, HTTPException, status, Request
from pydantic import BaseModel

# Re-export password helpers so callers use a single import path
from app.core.password import validate_password, strength_report  # noqa: F401

logger = logging.getLogger("app.auth")

# ---------------------------------------------------------------------------
# Secret key – MUST be set via environment variable.
# Generate with: openssl rand -hex 32
# ---------------------------------------------------------------------------
_SECRET_KEY = os.environ.get("SECRET_KEY", "")

_PLACEHOLDER = "CHANGE_ME"

if not _SECRET_KEY or _SECRET_KEY == _PLACEHOLDER:
    raise RuntimeError(
        "SECRET_KEY environment variable is not set or is still the placeholder value. "
        "Generate a strong key with `openssl rand -hex 32` and set it in your .env file."
    )

SECRET_KEY = _SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30 * 24 * 60  # 30 days

# Argon2 for all new hashes; existing pbkdf2_sha256 hashes still verify
# transparently and are re-hashed to Argon2 on next successful login.
pwd_context = CryptContext(
    schemes=["argon2", "pbkdf2_sha256"],
    deprecated="auto",
    argon2__time_cost=3,        # iterations
    argon2__memory_cost=65536,  # 64 MiB
    argon2__parallelism=2,
)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    username: Optional[str] = None


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=15))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(request: Request):
    """
    Get authenticated user from either cookie or Authorization header.
    Raises HTTP 401 if no valid token is found.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )

    token = _extract_token(request)
    if not token:
        raise credentials_exception

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = TokenData(username=username)
    except JWTError:
        raise credentials_exception

    from app.core.db import db
    user = db.get_user(username=token_data.username)
    if user is None:
        raise credentials_exception
    return user


async def get_current_user_optional(request: Request):
    """
    Get current user without raising exceptions.
    Returns None if no valid token is present.
    """
    token = _extract_token(request)
    if not token:
        return None

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            return None

        from app.core.db import db
        user = db.get_user(username=username)
        if not user:
            logger.debug("Token references unknown user: %s", username)
        return user
    except JWTError as e:
        logger.debug("JWT validation failed: %s", e)
        return None


def _extract_token(request: Request) -> Optional[str]:
    """Extract bearer token from cookie or Authorization header."""
    token = request.cookies.get("access_token")
    if not token:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ", 1)[1]
    return token
