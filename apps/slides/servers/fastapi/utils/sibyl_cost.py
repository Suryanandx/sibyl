"""
Sibyl: actual model cost per presentation.

The engine calls OpenRouter itself, so only the engine can know what a deck
really cost. OpenRouter reports the USD cost of every call in ``usage.cost``
(usage accounting, requested with ``usage: {include: true}``). A hook on the
LLM client's usage parser adds each call's cost to the *current* meter, a
context variable set around one generation; asyncio tasks and
``asyncio.to_thread`` workers inherit it, so outline, structure, slide content
and retries made for that deck all land on the same meter.
"""

from __future__ import annotations

import logging
import threading
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Optional

LOGGER = logging.getLogger(__name__)


@dataclass
class CostMeter:
    total_usd: float = 0.0
    calls: int = 0
    # Calls whose response carried token usage but no cost (another provider,
    # or a gateway that strips it): the total is then a lower bound.
    unpriced_calls: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, cost: Optional[float]) -> None:
        with self._lock:
            self.calls += 1
            if cost is None:
                self.unpriced_calls += 1
            else:
                self.total_usd += cost

    @property
    def estimated(self) -> bool:
        """True when some calls had no reported cost (or none were made)."""
        return self.calls == 0 or self.unpriced_calls > 0

    def summary(self) -> dict[str, Any]:
        return {"cost_usd": round(self.total_usd, 6), "estimated": self.estimated}


_CURRENT: ContextVar[Optional[CostMeter]] = ContextVar("sibyl_cost_meter", default=None)


def start_cost_meter() -> tuple[CostMeter, Token]:
    meter = CostMeter()
    return meter, _CURRENT.set(meter)


def stop_cost_meter(token: Token) -> None:
    try:
        _CURRENT.reset(token)
    except ValueError:
        # Reset from another context (e.g. a background task): just clear it.
        _CURRENT.set(None)


def current_cost_meter() -> Optional[CostMeter]:
    return _CURRENT.get()


def _read_cost(raw: Any) -> Optional[float]:
    if isinstance(raw, dict):
        value = raw.get("cost")
    else:
        value = getattr(raw, "cost", None)
        if value is None:
            extra = getattr(raw, "model_extra", None)
            if isinstance(extra, dict):
                value = extra.get("cost")
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None
    return None


def record_usage(raw_usage: Any) -> None:
    """Add one LLM response's usage to the current meter (no-op without one)."""
    meter = _CURRENT.get()
    if meter is None or raw_usage is None:
        return
    meter.add(_read_cost(raw_usage))


_installed = False


def install_usage_hook() -> None:
    """Wrap the OpenAI-compatible usage parser (used for OpenRouter) once."""
    global _installed
    if _installed:
        return
    try:
        from llmai.openai.client import OpenAIClient
    except Exception:  # pragma: no cover - llmai layout changed
        LOGGER.warning("[sibyl.cost] llmai OpenAIClient not found; costs stay estimated")
        return
    original = OpenAIClient._response_usage

    def _response_usage(self, usage):  # type: ignore[no-untyped-def]
        parsed = original(self, usage)
        if parsed is not None and usage is not None:
            record_usage(usage)
        return parsed

    OpenAIClient._response_usage = _response_usage  # type: ignore[method-assign]
    _installed = True


# ── model pricing (for the gateway's pre-call budget estimate) ────────────────

_PRICING_TTL_S = 6 * 60 * 60
_pricing_cache: dict[str, Any] = {"at": 0.0, "models": {}}


async def model_pricing(model: str) -> Optional[dict[str, float]]:
    """USD per token for ``model`` from OpenRouter's public /models list
    (cached for six hours): ``{"prompt": …, "completion": …}``, or None."""
    import time

    import httpx

    now = time.time()
    if now - float(_pricing_cache["at"]) > _PRICING_TTL_S or not _pricing_cache["models"]:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.get("https://openrouter.ai/api/v1/models")
                response.raise_for_status()
                data = response.json().get("data") or []
            _pricing_cache["models"] = {
                item.get("id"): item.get("pricing") or {} for item in data if isinstance(item, dict)
            }
            _pricing_cache["at"] = now
        except Exception as error:  # network down: no pricing, the gateway falls back
            LOGGER.warning("[sibyl.cost] could not read OpenRouter pricing: %s", error)
    pricing = _pricing_cache["models"].get(model)
    if not isinstance(pricing, dict):
        return None
    try:
        prompt = float(pricing.get("prompt") or 0)
        completion = float(pricing.get("completion") or 0)
    except (TypeError, ValueError):
        return None
    if prompt <= 0 and completion <= 0:
        return None
    return {"prompt": prompt, "completion": completion}
