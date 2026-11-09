import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from api.v1.auth.context import reset_current_owner_id, set_current_owner_id
from api.v1.ppt.endpoints import presentation as endpoint
from models.sql.presentation import PresentationModel, PresentationVersion
from models.sql.slide import SlideModel
from models.sql.user import User


def test_explicit_regeneration_creates_new_slides_while_reconnects_resume(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'regenerate.db'}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(endpoint, "async_session_maker", sessions)
    monkeypatch.setattr(
        endpoint, "get_provider_settings", AsyncMock(return_value={"LLM": "codex"})
    )
    monkeypatch.setattr(endpoint, "load_community_references", AsyncMock(return_value=[]))
    generate = AsyncMock(return_value={
        "title": "Fresh deck",
        "slides": [{"title": "Fresh slide", "html": "<section>Fresh slide</section>"}],
    })
    monkeypatch.setattr(endpoint, "generate_smart_presentation", generate)

    async def stream(presentation_id):
        async with sessions() as session:
            response = await endpoint.stream_presentation(presentation_id, session)
            return "".join([chunk async for chunk in response.body_iterator])

    async def run():
        async with engine.begin() as connection:
            for model in (User, PresentationModel, SlideModel):
                await connection.run_sync(model.__table__.create)
        owner_id = uuid.uuid4()
        token = set_current_owner_id(owner_id)
        try:
            deck = PresentationModel(
                version=PresentationVersion.V2_STANDARD,
                content="Solar power", n_slides=1, language="English",
                generation_mode="smart", title="Original deck",
            )
            old_slide = SlideModel(
                presentation=deck.id, layout="smart-html", layout_group="smart-html",
                index=0, content={"title": "Old slide"},
                html_content="<section>Old slide</section>",
            )
            async with sessions() as session:
                session.add(User(id=owner_id, username="qa", hashed_password="unused"))
                session.add(deck)
                session.add(old_slide)
                await session.commit()

            assert "Old slide" in await stream(deck.id)
            generate.assert_not_awaited()
            async with sessions() as session:
                await endpoint.regenerate_smart_presentation(deck.id, session)
            assert "Fresh slide" in await stream(deck.id)
            generate.assert_awaited_once()
            assert generate.await_args.kwargs["existing_slides"] == []

            # Reconnecting after completion replays the fresh checkpoint;
            # it must not erase it or start another model request.
            assert "Fresh slide" in await stream(deck.id)
            generate.assert_awaited_once()

            other_owner = set_current_owner_id(uuid.uuid4())
            try:
                async with sessions() as session:
                    with pytest.raises(HTTPException) as error:
                        await endpoint.regenerate_smart_presentation(deck.id, session)
                    assert error.value.status_code == 404
            finally:
                reset_current_owner_id(other_owner)
        finally:
            reset_current_owner_id(token)
            await engine.dispose()

    asyncio.run(run())


@pytest.mark.parametrize("mode,content,provider", [
    ("smart", "Solar power", "presenton"),
    ("smart", "", "codex"),
    ("standard", "Solar power", "codex"),
])
def test_rejected_regeneration_preserves_slides(monkeypatch, mode, content, provider):
    deck = PresentationModel(
        version=PresentationVersion.V2_STANDARD, content=content, n_slides=1,
        language="English", generation_mode=mode,
    )
    session = SimpleNamespace(
        get=AsyncMock(return_value=deck), execute=AsyncMock(), commit=AsyncMock()
    )
    monkeypatch.setattr(
        endpoint, "get_provider_settings", AsyncMock(return_value={"LLM": provider})
    )
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint.regenerate_smart_presentation(deck.id, session))
    assert error.value.status_code == 400
    session.execute.assert_not_awaited()
    session.commit.assert_not_awaited()
