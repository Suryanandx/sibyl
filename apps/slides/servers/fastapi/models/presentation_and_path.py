import os
import uuid
from typing import Optional

from pydantic import BaseModel, model_validator

from utils.get_env import get_app_data_directory_env


def _download_path(path: str) -> Optional[str]:
    """Engine-relative URL of an exported file (served under /app_data/)."""
    if not path:
        return None
    normalized = path.replace("\\", "/")
    if normalized.startswith("/app_data/"):
        return normalized
    app_data = (get_app_data_directory_env() or "").replace("\\", "/").rstrip("/")
    if app_data and normalized.startswith(app_data + "/"):
        return "/app_data/" + normalized[len(app_data) + 1 :]
    index = normalized.find("/exports/")
    if index != -1:
        return "/app_data" + normalized[index:]
    return None


class PresentationAndPath(BaseModel):
    presentation_id: uuid.UUID
    path: str


class PresentationPathAndEditPath(PresentationAndPath):
    edit_path: str
    # Sibyl: URL path of the exported file on the engine (GET it with the
    # owner token); prefix /slides when going through the Sibyl web app.
    download_path: Optional[str] = None
    # Sibyl: what this generation actually cost (OpenRouter usage accounting).
    # `estimated` is true when some model calls reported no cost.
    cost_usd: Optional[float] = None
    estimated: Optional[bool] = None

    @model_validator(mode="after")
    def _fill_download_path(self) -> "PresentationPathAndEditPath":
        if self.download_path is None:
            self.download_path = _download_path(self.path)
        return self


__all__ = ["PresentationAndPath", "PresentationPathAndEditPath", "os"]
