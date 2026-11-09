"""Authenticate the owning Electron client independently of account login."""

import hmac
import os
from urllib.parse import urlsplit

from fastapi import Request
from starlette.responses import JSONResponse

DESKTOP_COOKIE_NAME = "presenton_desktop_session"
DESKTOP_TOKEN_HEADER = "x-presenton-desktop-token"


def desktop_token() -> str:
    return os.getenv("PRESENTON_DESKTOP_TOKEN", "")


def desktop_cookie_header() -> str | None:
    token = desktop_token()
    if os.getenv("PRESENTON_ELECTRON") == "true" and token:
        return f"{DESKTOP_COOKIE_NAME}={token}"
    return None


def desktop_request_denied(request: Request) -> JSONResponse | None:
    if os.getenv("PRESENTON_ELECTRON") != "true":
        return None

    token = desktop_token()
    origins = set(filter(None, os.getenv("PRESENTON_DESKTOP_ORIGINS", "").split(",")))
    hosts = {urlsplit(origin).netloc for origin in origins}
    if len(token) < 32 or not hosts:
        return JSONResponse({"detail": "Desktop session unavailable"}, status_code=503)
    # Check the actual Host, not forwarded headers: DNS rebinding must not turn
    # an attacker's hostname into an authorized local application origin.
    origin = request.headers.get("origin")
    if request.headers.get("host") not in hosts or (
        origin is not None and origin not in origins
    ):
        return JSONResponse({"detail": "Forbidden desktop origin"}, status_code=403)
    if request.method == "OPTIONS" and origin in origins and request.headers.get("access-control-request-method"):
        return None  # The exact-origin CORS middleware answers without executing a route.
    supplied = request.headers.get(DESKTOP_TOKEN_HEADER) or request.cookies.get(
        DESKTOP_COOKIE_NAME, ""
    )
    if not hmac.compare_digest(supplied.encode(), token.encode()):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return None
