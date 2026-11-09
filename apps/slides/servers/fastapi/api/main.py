import os

from utils.sibyl import apply_runtime_env

# Sibyl defaults (OpenRouter, owner token, telemetry off) must be in place
# before any other backend module reads the environment.
apply_runtime_env()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import FileResponse

from api.lifespan import app_lifespan
from api.middlewares import SibylOwnerTokenMiddleware, UserConfigEnvUpdateMiddleware
from api.v1.async_tasks.router import API_V1_ASYNC_TASKS_ROUTER
from api.v1.auth.router import API_V1_AUTH_ROUTER
from api.v1.admin.router import API_V1_ADMIN_ROUTER
from api.v1.mock.router import API_V1_MOCK_ROUTER
from api.v1.ppt.router import API_V1_PPT_ROUTER
from api.v1.webhook.router import API_V1_WEBHOOK_ROUTER
from api.v2.router import API_V2_ROUTER
from utils.get_env import get_app_data_directory_env
from utils.mime_types import init_sandbox_safe_mimetypes
from utils.sibyl import image_provider, owner_login_required, slides_model
from utils.path_helpers import get_resource_path
from api.v1.auth.assets import mount_app_data_assets


init_sandbox_safe_mimetypes()

from utils.sibyl_cost import install_usage_hook

# Sibyl: every OpenRouter call's reported cost goes to the deck being built.
install_usage_hook()



app = FastAPI(lifespan=app_lifespan)

# Routers
app.include_router(API_V1_PPT_ROUTER)
app.include_router(API_V1_WEBHOOK_ROUTER)
app.include_router(API_V1_MOCK_ROUTER)
app.include_router(API_V1_AUTH_ROUTER)
app.include_router(API_V1_ADMIN_ROUTER)
app.include_router(API_V1_ASYNC_TASKS_ROUTER)
app.include_router(API_V2_ROUTER)

# Mount app_data and static assets (direct FastAPI access; nginx also serves /static in Docker).
app_data_dir = get_app_data_directory_env()
if app_data_dir:
    os.makedirs(app_data_dir, exist_ok=True)
    # Configuration, databases, logs and Chromium state are private even when
    # account login is disabled. Only browser assets have HTTP mounts.
    mount_app_data_assets(app, app_data_dir)

static_dir = get_resource_path("static")
if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

# The browser reaches this API same-origin through the Sibyl Slides web app
# (/slides/api/...), and the Gateway calls it server-to-server, so CORS is
# only opened for origins listed in SIBYL_SLIDES_CORS_ORIGINS.
cors_origins = [
    origin.strip().rstrip("/")
    for origin in (os.getenv("SIBYL_SLIDES_CORS_ORIGINS") or "").split(",")
    if origin.strip()
]
if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.add_middleware(UserConfigEnvUpdateMiddleware)
app.add_middleware(SibylOwnerTokenMiddleware)


@app.get("/healthz", include_in_schema=False)
@app.get("/api/v1/sibyl/health", tags=["Sibyl"])
async def sibyl_health():
    """Public liveness check; says whether the owner token is required."""
    return {
        "ok": True,
        "service": "sibyl-slides",
        "ownerLogin": owner_login_required(),
        "model": slides_model(),
        "imageProvider": image_provider() or None,
    }


@app.get("/api/v1/sibyl/config", tags=["Sibyl"])
async def sibyl_config():
    """The engine's active deck model and its OpenRouter price per token, so
    the gateway estimates and labels costs for the model actually used."""
    from utils.sibyl_cost import model_pricing

    model = slides_model()
    return {
        "model": model,
        "pricing": await model_pricing(model),
        "imageProvider": image_provider() or None,
        "costAccounting": "openrouter-usage",
    }


@app.middleware("http")
async def static_icon_fallback_middleware(request: Request, call_next):
    """Serve placeholder when icon paths are missing (e.g. renamed Phosphor icons)."""
    response = await call_next(request)
    if response.status_code != 404:
        return response
    path = request.url.path
    if not path.startswith("/static/icons/"):
        return response
    placeholder = get_resource_path("static/icons/placeholder.svg")
    if not os.path.isfile(placeholder):
        return response
    return FileResponse(placeholder, media_type="image/svg+xml")
