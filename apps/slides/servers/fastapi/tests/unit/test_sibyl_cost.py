import asyncio

from utils import sibyl_cost


class _Usage:
    """Shape of an OpenAI SDK usage object with OpenRouter's extra `cost`."""

    def __init__(self, cost=None):
        self.prompt_tokens = 100
        self.completion_tokens = 50
        self.total_tokens = 150
        self.model_extra = {} if cost is None else {"cost": cost}


def test_meter_sums_reported_costs_for_the_current_generation_only():
    sibyl_cost.record_usage({"cost": 1.0})  # no meter: ignored
    meter, token = sibyl_cost.start_cost_meter()
    try:
        sibyl_cost.record_usage({"cost": 0.0012})
        sibyl_cost.record_usage(_Usage(cost=0.0008))
        assert meter.summary() == {"cost_usd": 0.002, "estimated": False}

        async def in_thread():
            await asyncio.to_thread(sibyl_cost.record_usage, {"cost": "0.001"})

        asyncio.run(in_thread())
        assert meter.summary()["cost_usd"] == 0.003
        sibyl_cost.record_usage(_Usage())
        assert meter.summary()["estimated"] is True, "a call without cost makes it a lower bound"
    finally:
        sibyl_cost.stop_cost_meter(token)
    assert sibyl_cost.current_cost_meter() is None


def test_usage_hook_records_openrouter_cost():
    from llmai.openai.client import OpenAIClient

    sibyl_cost.install_usage_hook()
    meter, token = sibyl_cost.start_cost_meter()
    try:
        client = OpenAIClient.__new__(OpenAIClient)
        client._response_usage(_Usage(cost=0.0042))
        assert meter.total_usd == 0.0042
        assert meter.calls == 1
    finally:
        sibyl_cost.stop_cost_meter(token)
