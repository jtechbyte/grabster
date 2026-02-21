"""
Password policy enforcement for GrabSter.

Design principles (NIST SP 800-63B aligned):
- Minimum 14 characters, maximum 128 characters
- Spaces and passphrases explicitly allowed
- NO arbitrary composition rules (symbols, uppercase, digits)
- Strength measured via zxcvbn (score must be >= 3 out of 4)
- Rejects passwords that contain the username
- zxcvbn's internal dictionaries cover ~30 000 common passwords,
  top names, English words, and common patterns — no separate list needed
- Raw passwords are NEVER logged
"""
import logging
from typing import Optional

import zxcvbn as _zxcvbn

logger = logging.getLogger("app.password")

MIN_LENGTH = 14
MAX_LENGTH = 128
# zxcvbn scores: 0=very weak, 1=weak, 2=fair, 3=strong, 4=very strong
MIN_SCORE = 3


def validate_password(password: str, username: Optional[str] = None) -> None:
    """
    Validate a candidate password against the GrabSter password policy.

    Raises:
        ValueError: with a specific, user-facing message describing the failure.

    Never logs or re-raises the raw password value.
    """
    # ── Length checks ────────────────────────────────────────────────────────
    if len(password) < MIN_LENGTH:
        raise ValueError(
            f"Password must be at least {MIN_LENGTH} characters long. "
            f"Consider using a passphrase (e.g. four random words)."
        )

    if len(password) > MAX_LENGTH:
        raise ValueError(f"Password must not exceed {MAX_LENGTH} characters.")

    # ── Username containment check (case-insensitive) ────────────────────────
    if username and username.lower() in password.lower():
        raise ValueError("Password must not contain your username.")

    # ── zxcvbn strength estimation ───────────────────────────────────────────
    # Pass username as a user-defined input so zxcvbn penalises passwords
    # that are based on it even when not a direct substring.
    user_inputs = [username] if username else []
    result = _zxcvbn.zxcvbn(password, user_inputs=user_inputs)
    score: int = result["score"]

    if score < MIN_SCORE:
        feedback = result.get("feedback", {})
        warning: str = feedback.get("warning", "")
        suggestions: list = feedback.get("suggestions", [])

        parts = ["Password is too weak or too common."]
        if warning:
            parts.append(warning + ".")
        if suggestions:
            parts.extend(suggestions)

        raise ValueError(" ".join(parts))


def strength_report(password: str, username: Optional[str] = None) -> dict:
    """
    Return a sanitised strength report suitable for sending to the client.
    The raw password is NOT included in the return value.
    """
    user_inputs = [username] if username else []
    result = _zxcvbn.zxcvbn(password, user_inputs=user_inputs)
    feedback = result.get("feedback", {})
    return {
        "score": result["score"],          # 0–4
        "warning": feedback.get("warning", ""),
        "suggestions": feedback.get("suggestions", []),
        "crack_time_display": result["crack_times_display"].get(
            "offline_slow_hashing_1e4_per_second", "unknown"
        ),
    }
