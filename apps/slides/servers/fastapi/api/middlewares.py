from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from utils.sibyl import (
    OWNER_TOKEN_COOKIE,
    owner_login_required,
    token_from_headers,
    token_matches,
)
from utils.user_config import update_env_with_user_config


class UserConfigEnvUpdateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        update_env_with_user_config()
        return await call_next(request)


class SibylOwnerTokenMiddleware(BaseHTTPMiddleware):
    """Single-owner auth (Sibyl): when SIBYL_OWNER_TOKEN is set every route
    except the health check requires the token, as `Authorization: Bearer`
    or the `sibyl_slides_token` cookie. Compared in constant time."""

    _PUBLIC_PATHS = {"/healthz", "/api/v1/sibyl/health"}

    async def dispatch(self, request: Request, call_next):
        if not owner_login_required():
            return await call_next(request)
        if request.method == "OPTIONS" or request.url.path in self._PUBLIC_PATHS:
            return await call_next(request)
        provided = token_from_headers(
            request.headers.get("authorization"),
            request.cookies.get(OWNER_TOKEN_COOKIE),
        )
        if not provided or not token_matches(provided):
            return JSONResponse(
                status_code=401,
                content={"detail": "Sibyl owner token required", "ownerLogin": True},
                headers={"Cache-Control": "no-store"},
            )
        return await call_next(request)
