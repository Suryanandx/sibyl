"""Sibyl Slides runtime defaults and owner-token auth.

Copyright Sibyl contributors. Licensed under the Apache License, Version 2.0.

This module adapts the vendored Presenton backend to Sibyl:

* Models come from OpenRouter out of the box (``OPENROUTER_API_KEY`` +
  ``SIBYL_SLIDES_MODEL``), through Presenton's OpenAI-compatible OpenRouter
  client.
* Paid image generation is off unless ``SIBYL_SLIDES_IMAGE_PROVIDER`` is set.
* Presenton's multi-user accounts are replaced by Sibyl's single-owner token
  (``SIBYL_OWNER_TOKEN``), sent as ``Authorization: Bearer <token>`` or as the
  ``sibyl_slides_token`` cookie (used by <img>, EventSource and the export
  browser, which cannot set headers).
* Third-party telemetry of bundled libraries is switched off.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any, Optional

# A cheap, capable OpenRouter model with JSON/structured-output support.
# Override with SIBYL_SLIDES_MODEL (any id from https://openrouter.ai/models).
DEFAULT_SLIDES_MODEL = "deepseek/deepseek-v4.1-flash"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_BASE_PATH = "/slides"
OWNER_TOKEN_COOKIE = "sibyl_slides_token"

# Placeholder returned to the settings UI for secrets that come from the
# environment; never persisted back.
ENV_SECRET_PLACEHOLDER = "__configured__"

_TELEMETRY_OFF = {
    "MEM0_TELEMETRY": "False",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "ANONYMIZED_TELEMETRY": "False",
    "DO_NOT_TRACK": "1",
    "NEXT_TELEMETRY_DISABLED": "1",
    "SCARF_NO_ANALYTICS": "true",
}


def _clean(value: Optional[str]) -> str:
    return (value or "").strip()


def slides_model() -> str:
    return _clean(os.getenv("SIBYL_SLIDES_MODEL")) or DEFAULT_SLIDES_MODEL


def image_provider() -> str:
    return _clean(os.getenv("SIBYL_SLIDES_IMAGE_PROVIDER"))


def base_path() -> str:
    value = _clean(os.getenv("SIBYL_SLIDES_BASE_PATH"))
    if value == "":
        value = DEFAULT_BASE_PATH
    value = "/" + value.strip("/") if value.strip("/") else ""
    return value


def editor_path(presentation_id: Any) -> str:
    """Browser path of the slide editor for a deck (under the Sibyl origin)."""
    return f"{base_path()}/presentation?id={presentation_id}"


def apply_runtime_env() -> None:
    """Set environment defaults before the rest of the backend reads them."""
    for key, value in _TELEMETRY_OFF.items():
        os.environ[key] = value
    # Presenton's account system is replaced by the Sibyl owner token.
    os.environ["DISABLE_AUTH"] = "true"
    os.environ.setdefault("OPENROUTER_BASE_URL", OPENROUTER_BASE_URL)
    # Presenton's hosted community gallery is not part of Sibyl Slides.
    os.environ["PRESENTON_COMMUNITY_ENABLED"] = "false"

    app_data = _clean(os.getenv("APP_DATA_DIRECTORY"))
    if not app_data:
        app_data = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", "..", "data")
        )
        os.environ["APP_DATA_DIRECTORY"] = app_data
    os.environ.setdefault("TEMP_DIRECTORY", os.path.join(app_data, "tmp"))
    # Keep the export browser cache out of TEMP_DIRECTORY (emptied on start).
    os.environ.setdefault("PUPPETEER_CACHE_DIR", os.path.join(app_data, "puppeteer-cache"))
    os.environ.setdefault("USER_CONFIG_PATH", os.path.join(app_data, "userConfig.json"))


def sibyl_provider_defaults(config: dict[str, Any]) -> dict[str, Any]:
    """Provider settings Sibyl applies on startup.

    Out of the box (no provider chosen yet) the deck model is OpenRouter.
    ``SIBYL_SLIDES_MODEL`` / ``SIBYL_SLIDES_IMAGE_PROVIDER``, when set
    explicitly, win over what was saved in the settings UI on every start.
    Secrets are never written here; they stay in the environment.
    """
    updates: dict[str, Any] = {}
    if not _clean(config.get("LLM")):
        updates["LLM"] = "openrouter"
    llm = updates.get("LLM") or config.get("LLM")
    if llm == "openrouter":
        if _clean(os.getenv("SIBYL_SLIDES_MODEL")) or not _clean(config.get("OPENROUTER_MODEL")):
            updates["OPENROUTER_MODEL"] = slides_model()
        if not _clean(config.get("OPENROUTER_BASE_URL")):
            updates["OPENROUTER_BASE_URL"] = OPENROUTER_BASE_URL

    provider = image_provider()
    if provider:
        updates["IMAGE_PROVIDER"] = provider
        updates["DISABLE_IMAGE_GENERATION"] = False
    elif config.get("DISABLE_IMAGE_GENERATION") is None and not _clean(config.get("IMAGE_PROVIDER")):
        # No paid image generation unless the owner opts in.
        updates["DISABLE_IMAGE_GENERATION"] = True
    return updates


# Provider secrets that may come from the environment instead of the settings DB.
ENV_SECRET_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "PEXELS_API_KEY",
    "PIXABAY_API_KEY",
)


def overlay_env_secrets(config: dict[str, Any]) -> dict[str, Any]:
    """Mark env-provided secrets as configured for the settings UI."""
    result = dict(config)
    for key in ENV_SECRET_KEYS:
        if not _clean(result.get(key)) and _clean(os.getenv(key)):
            result[key] = ENV_SECRET_PLACEHOLDER
    return result


def strip_env_secret_placeholders(config: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in config.items()
        if value != ENV_SECRET_PLACEHOLDER
    }


# ── Owner token ──────────────────────────────────────────────────────────────


def owner_token() -> str:
    return _clean(os.getenv("SIBYL_OWNER_TOKEN"))


def owner_login_required() -> bool:
    return bool(owner_token())


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


def token_matches(provided: Optional[str]) -> bool:
    expected = owner_token()
    if not expected:
        return True
    # Compare fixed-length digests so neither content nor length leaks.
    return hmac.compare_digest(_digest(expected), _digest(provided or ""))


def token_from_headers(authorization: Optional[str], cookie_value: Optional[str]) -> Optional[str]:
    auth = _clean(authorization)
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    if cookie_value:
        return cookie_value.strip()
    return None


def export_cookie_header(existing: Optional[str]) -> Optional[str]:
    """Cookie header for the headless export browser, carrying the owner token."""
    token = owner_token()
    existing = _clean(existing)
    if not token:
        return existing or None
    if f"{OWNER_TOKEN_COOKIE}=" in existing:
        return existing
    cookie = f"{OWNER_TOKEN_COOKIE}={token}"
    return f"{existing}; {cookie}" if existing else cookie
