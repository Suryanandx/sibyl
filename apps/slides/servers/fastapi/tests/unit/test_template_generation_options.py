import asyncio
from itertools import product
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import BackgroundTasks, FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.v1.ppt.endpoints import template as api
from models.sql.async_task import AsyncTaskModel
from models.sql.template_v2 import TemplateV2
from services.database import get_async_session
from templates.v2 import certified_generation, generation
from templates.v2.models.layouts import LayoutGenerationOptions, RawSlideLayouts
from tests.unit.test_template_api import RAW_LAYOUTS, GENERATED_LAYOUTS, MERGED_COMPONENTS
from tests.unit.test_templates_v2_certified_generation import _raw_layout, _manifest, _flexible_plan


@pytest.mark.parametrize("text_growth,visual_replacement,flexible_grouping", product([False, True], repeat=3))
def test_optional_passes_run_only_when_enabled(monkeypatch, text_growth, visual_replacement, flexible_grouping):
    options = LayoutGenerationOptions(
        text_growth=text_growth,
        visual_replacement=visual_replacement,
        flexible_grouping=flexible_grouping,
    )
    calls = []
    responses = {
        certified_generation.VisualDataReplacementPlan: {"replacements": []},
        certified_generation.SemanticSlideManifest: _manifest().model_dump(),
        certified_generation.FlexibleSlidePlan: _flexible_plan().model_dump(),
        certified_generation.TextCapacityPlan: {"adjustments": []},
    }

    def fake_generate(*, output_model, **kwargs):
        calls.append(output_model)
        return responses[output_model]

    reserve = Mock(wraps=certified_generation._reserve_single_line_text_overflow_space)
    monkeypatch.setattr(certified_generation, "_generate_structured_with_provider_fallback", fake_generate)
    monkeypatch.setattr(certified_generation, "_reserve_single_line_text_overflow_space", reserve)
    layout = generation.generate_slide_layout(
        _raw_layout(), 0, "https://example.com/slide.png", generation_options=options
    )
    expected = []
    if visual_replacement:
        expected.append(certified_generation.VisualDataReplacementPlan)
    expected.append(certified_generation.SemanticSlideManifest)
    if flexible_grouping:
        expected.append(certified_generation.FlexibleSlidePlan)
    if text_growth:
        expected.append(certified_generation.TextCapacityPlan)
    assert calls == expected
    assert bool(reserve.call_count) is text_growth
    assert (layout.components[1].elements[0].type == "grid") is flexible_grouping


def test_semantic_failure_also_disables_automatic_text_growth(monkeypatch):
    monkeypatch.setattr(certified_generation, "_generate_structured_with_provider_fallback", Mock(side_effect=ValueError("unavailable")))
    reserve = Mock(wraps=certified_generation._reserve_single_line_text_overflow_space)
    monkeypatch.setattr(certified_generation, "_reserve_single_line_text_overflow_space", reserve)
    layout = generation.generate_slide_layout(
        _raw_layout(), 0, "https://example.com/slide.png",
        generation_options=LayoutGenerationOptions(text_growth=False, visual_replacement=False),
    )
    assert layout.components
    reserve.assert_not_called()


@pytest.mark.parametrize("invalid", [{"text_growth": "false"}, {"visual_replacement": 0}, {"visible": False}])
def test_generation_options_reject_invalid_values(invalid):
    with pytest.raises(ValidationError):
        LayoutGenerationOptions.model_validate(invalid)


@pytest.mark.parametrize("request_model", [api.InitTemplateRequest, api.CreateTemplateRequest])
def test_legacy_creation_payloads_default_to_all_passes(request_model):
    request = request_model.model_validate({
        "pptx_url": "/deck.pptx",
        "slide_image_urls": ["/slide.png"],
    })
    assert request.generation_options.model_dump() == {
        "text_growth": True,
        "visual_replacement": True,
        "flexible_grouping": True,
    }
    assert "generation_options" not in request_model.model_json_schema().get("required", [])


def test_omitted_options_preserve_generation_behavior(monkeypatch):
    responses = {
        certified_generation.VisualDataReplacementPlan: {"replacements": []},
        certified_generation.SemanticSlideManifest: _manifest().model_dump(),
        certified_generation.FlexibleSlidePlan: _flexible_plan().model_dump(),
        certified_generation.TextCapacityPlan: {"adjustments": []},
    }
    generate = Mock(side_effect=lambda *, output_model, **kwargs: responses[output_model])
    monkeypatch.setattr(certified_generation, "_generate_structured_with_provider_fallback", generate)
    legacy_layout = generation.generate_slide_layout(_raw_layout(), 0, "https://example.com/slide.png")
    assert [call.kwargs["output_model"] for call in generate.call_args_list] == list(responses)
    explicit_layout = generation.generate_slide_layout(
        _raw_layout(), 0, "https://example.com/slide.png",
        generation_options=LayoutGenerationOptions(),
    )
    assert legacy_layout == explicit_layout


def test_saved_options_merge_only_explicit_overrides():
    template = TemplateV2(name="Custom", assets={"generation_options": {
        "text_growth": False, "visual_replacement": False, "flexible_grouping": False,
    }})
    options = api._template_generation_options(template, LayoutGenerationOptions(flexible_grouping=True))
    assert options.model_dump() == {"text_growth": False, "visual_replacement": False, "flexible_grouping": True}
    assert template.assets["generation_options"]["flexible_grouping"] is False


@pytest.mark.parametrize("assets", [None, {}, {"generation_options": {"text_growth": "invalid"}}])
def test_legacy_or_invalid_saved_options_use_defaults(assets):
    assert api._template_generation_options(TemplateV2(name="Custom", assets=assets)) == LayoutGenerationOptions()


def test_multi_slide_generation_forwards_options(monkeypatch):
    options = LayoutGenerationOptions(text_growth=False)
    generate = Mock(return_value=GENERATED_LAYOUTS.layouts[0])
    monkeypatch.setattr(generation, "generate_slide_layout", generate)
    generation.generate_template(RawSlideLayouts.model_validate(RAW_LAYOUTS), ["/slide.png"], generation_options=options)
    assert generate.call_args.kwargs["generation_options"] == options


def test_async_workers_forward_options(monkeypatch, fake_async_session):
    options = LayoutGenerationOptions(text_growth=False, flexible_grouping=False)
    generate = Mock(return_value=GENERATED_LAYOUTS.layouts[0])
    monkeypatch.setattr(api, "generate_slide_layout", generate)
    task = AsyncTaskModel(type="template.create", status="pending", data={})
    asyncio.run(api._generate_slide_layouts_with_task_progress(
        RawSlideLayouts.model_validate(RAW_LAYOUTS), ["/slide.png"], {}, task, fake_async_session,
        name="Custom", thumbnail=None, generation_options=options,
    ))
    assert generate.call_args.kwargs["generation_options"] == options


def test_create_persists_and_forwards_options(monkeypatch, fake_async_session):
    options = LayoutGenerationOptions(text_growth=False, visual_replacement=False, flexible_grouping=False)
    request = api.CreateTemplateRequest(pptx_url="/deck.pptx", slide_image_urls=["/slide.png"], generation_options=options)
    monkeypatch.setattr(api, "_prepare_template_source", AsyncMock(return_value=("/deck.pptx", RawSlideLayouts.model_validate(RAW_LAYOUTS), RAW_LAYOUTS, {})))
    generate = Mock(return_value=GENERATED_LAYOUTS)
    monkeypatch.setattr(api, "generate_template", generate)
    monkeypatch.setattr(api, "_merge_generated_components", AsyncMock(return_value=MERGED_COMPONENTS))
    monkeypatch.setattr(api, "_generate_generated_theme", AsyncMock(return_value=None))
    template = asyncio.run(api._create_template_sync(request, fake_async_session))
    assert generate.call_args.args[-1] == options
    assert template.assets["generation_options"] == options.model_dump()
    init_id = asyncio.run(api.init_template(api.InitTemplateRequest.model_validate(request.model_dump()), fake_async_session))
    assert fake_async_session.added[-1].id == init_id
    assert fake_async_session.added[-1].assets["generation_options"] == options.model_dump()


@pytest.mark.parametrize("supplied_options", [None, {}, {"text_growth": False}])
def test_async_creation_serializes_only_explicit_options(
    monkeypatch, fake_async_session, supplied_options,
):
    payload = {"pptx_url": "/deck.pptx", "slide_image_urls": ["/slide.png"]}
    if supplied_options is not None:
        payload["generation_options"] = supplied_options
    request = api.CreateTemplateRequest.model_validate(payload)
    monkeypatch.setattr(api, "resolve_app_path_to_filesystem", lambda _url: __file__)
    task = asyncio.run(api.create_template(BackgroundTasks(), request, fake_async_session))

    assert "import_settings" not in task.payload
    assert "import_settings" not in api.CreateTemplateRequest.model_json_schema()["properties"]
    if supplied_options is None:
        assert "generation_options" not in task.payload
    else:
        assert task.payload["generation_options"] == request.generation_options.model_dump()
    restored = api.CreateTemplateRequest.model_validate(task.payload)
    assert restored.generation_options == request.generation_options
    assert ("generation_options" in restored.model_fields_set) is (supplied_options is not None)


def test_layout_route_uses_saved_options_and_partial_override(monkeypatch, fake_async_session):
    template = TemplateV2(name="Custom", raw_layouts=RAW_LAYOUTS, assets={
        "slide_image_urls": ["/slide.png"],
        "generation_options": {"text_growth": False, "visual_replacement": False, "flexible_grouping": False},
    })
    fake_async_session._get_results[template.id] = template
    generate = Mock(return_value=GENERATED_LAYOUTS.layouts[0])
    monkeypatch.setattr(api, "generate_slide_layout", generate)
    app = FastAPI()
    app.include_router(api.TEMPLATE_ROUTER)
    app.dependency_overrides[get_async_session] = lambda: fake_async_session
    with TestClient(app) as client:
        legacy_response = client.post("/template/layouts/create", json={"template_id": template.id, "index": 0})
        assert legacy_response.status_code == 200, legacy_response.text
        assert generate.call_args.kwargs["generation_options"] == LayoutGenerationOptions(
            text_growth=False, visual_replacement=False, flexible_grouping=False,
        )
        response = client.post("/template/layouts/create", json={"template_id": template.id, "index": 0, "generation_options": {"flexible_grouping": True}})
        assert response.status_code == 200, response.text
        assert generate.call_args.kwargs["generation_options"] == LayoutGenerationOptions(text_growth=False, visual_replacement=False)
        invalid = client.post("/template/layouts/create", json={"template_id": template.id, "index": 0, "generation_options": {"text_growth": "false"}})
        assert invalid.status_code == 422
