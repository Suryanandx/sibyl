import asyncio
import copy
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.v1.ppt.router import API_V1_PPT_ROUTER
from models.sql.presentation import PresentationModel, PresentationVersion
from services.chat.memory_layer import PresentationChatMemoryLayer
from services.chat.tools import ChatTools
from services.database import get_async_session
from tests.conftest import FakeAsyncSession


def _presentation():
    now = datetime.now(timezone.utc)
    return PresentationModel(
        id=uuid.uuid4(),
        version=PresentationVersion.V2_STANDARD,
        content="",
        n_slides=2,
        language="en",
        title="Original",
        theme={
            "source": "template",
            "template_id": "template-id",
            "name": "Template Theme",
            "data": {"colors": {"primary": "#123456"}},
        },
        created_at=now,
        updated_at=now,
    )


def _app(session):
    app = FastAPI()
    app.include_router(API_V1_PPT_ROUTER)
    app.dependency_overrides[get_async_session] = lambda: session
    return app


@pytest.mark.parametrize(
    "update",
    [
        {"title": "Renamed"},
        {"n_slides": 3},
        {"title": "Renamed", "theme": None},
        {"title": "Renamed", "theme": {"data": {"colors": {"primary": "#abcdef"}}}},
        {
            "slides": [
                {
                    "id": str(uuid.uuid4()),
                    "layout_group": "template-v2",
                    "layout": "title",
                    "index": 0,
                    "content": {"title": "Edited"},
                }
            ]
        },
    ],
)
def test_presentation_updates_preserve_template_theme(update):
    presentation = _presentation()
    original_theme = copy.deepcopy(presentation.theme)
    session = FakeAsyncSession(get_results={presentation.id: presentation})
    body = {"id": str(presentation.id), **copy.deepcopy(update)}
    for slide in body.get("slides", []):
        slide["presentation"] = str(presentation.id)

    response = TestClient(_app(session)).patch("/api/v1/ppt/presentation/update", json=body)

    assert response.status_code == 200, response.text
    assert presentation.theme == original_theme
    assert response.json()["theme"] == original_theme
    if "title" in update:
        assert presentation.title == update["title"]
    if "n_slides" in update:
        assert presentation.n_slides == update["n_slides"]
    if "slides" in update:
        assert session.added_all[0].content == {"title": "Edited"}
    assert session.commit_count == 1


@pytest.mark.parametrize("source", ["app", "mcp"])
def test_theme_customization_routes_and_update_field_are_removed(source):
    schema = (
        _app(FakeAsyncSession()).openapi()
        if source == "app"
        else json.loads((Path(__file__).resolve().parents[2] / "openai_spec.json").read_text())
    )
    assert not any(
        path.startswith(("/api/v1/ppt/theme/", "/api/v1/ppt/themes/"))
        for path in schema["paths"]
    )
    assert "/api/v1/ppt/template/{template_id}/theme" in schema["paths"]
    body_schema = schema["paths"]["/api/v1/ppt/presentation/update"]["patch"][
        "requestBody"
    ]["content"]["application/json"]["schema"]
    properties = schema["components"]["schemas"][
        body_schema["$ref"].split("/")[-1]
    ]["properties"]
    assert "theme" not in properties


def test_template_summary_reads_only_the_stored_template_theme():
    presentation = _presentation()
    session = FakeAsyncSession(get_results={presentation.id: presentation})
    memory = PresentationChatMemoryLayer(session, presentation.id)
    tools = ChatTools(memory)
    tools._get_presentation_outline = AsyncMock(return_value={"title": "Original"})
    tools._get_available_layouts = AsyncMock(return_value={"layouts": []})

    summary = asyncio.run(tools._get_template_summary({}))

    assert summary["theme"] == presentation.theme
    summary["theme"]["data"]["colors"]["primary"] = "#abcdef"
    assert presentation.theme["data"]["colors"]["primary"] == "#123456"
    assert session.commit_count == 0
    assert not {"getPresentationTheme", "setPresentationTheme"} & tools._tool_handlers.keys()
