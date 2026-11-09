"""
Sibyl: first-slide thumbnails for the deck library.

The thumbnail is rendered by the export runtime that already produces PDFs
(the same /slides/pdf-maker page, so it matches the editor exactly): export a
PDF, rasterize page 1 with pypdfium2, and cache the PNG under
``APP_DATA_DIRECTORY/thumbnails``. The cache key is a fingerprint of the deck's
layout and slide 1, so editing slide 1 (or the theme) renders a fresh one.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import uuid
from typing import Any, Awaitable, Callable

from utils.get_env import get_app_data_directory_env

LOGGER = logging.getLogger(__name__)

THUMBNAIL_WIDTH = 640
_locks: dict[str, asyncio.Lock] = {}


def thumbnail_directory() -> str:
    root = get_app_data_directory_env() or os.path.join(os.getcwd(), "app_data")
    path = os.path.join(root, "thumbnails")
    os.makedirs(path, exist_ok=True)
    return path


def thumbnail_fingerprint(presentation: Any, first_slide: Any | None) -> str:
    """Stable hash of what slide 1 looks like."""
    parts = {
        "layout": getattr(presentation, "layout", None),
        "theme": getattr(presentation, "theme", None),
        "slide": None
        if first_slide is None
        else {
            "content": getattr(first_slide, "content", None),
            "ui": getattr(first_slide, "ui", None),
            "html": getattr(first_slide, "html_content", None),
            "layout": getattr(first_slide, "layout", None),
            "properties": getattr(first_slide, "properties", None),
        },
    }
    encoded = json.dumps(parts, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()[:16]


def cached_thumbnail_path(presentation_id: uuid.UUID, fingerprint: str) -> str:
    return os.path.join(thumbnail_directory(), f"{presentation_id}-{fingerprint}.png")


def render_pdf_first_page(pdf_path: str, png_path: str, width: int = THUMBNAIL_WIDTH) -> None:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf_path)
    try:
        page = document[0]
        scale = width / max(1.0, float(page.get_width()))
        image = page.render(scale=scale).to_pil()
        tmp_path = f"{png_path}.tmp"
        image.save(tmp_path, format="PNG", optimize=True)
        os.replace(tmp_path, png_path)
    finally:
        document.close()


def _remove_stale(presentation_id: uuid.UUID, keep: str) -> None:
    prefix = f"{presentation_id}-"
    directory = thumbnail_directory()
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        if name.startswith(prefix) and path != keep:
            try:
                os.remove(path)
            except OSError:
                pass


async def ensure_thumbnail(
    presentation_id: uuid.UUID,
    fingerprint: str,
    export_pdf: Callable[[], Awaitable[str]],
) -> str:
    """Path of slide 1's PNG, rendering (and caching) it when missing or stale."""
    target = cached_thumbnail_path(presentation_id, fingerprint)
    if os.path.isfile(target):
        return target
    lock = _locks.setdefault(str(presentation_id), asyncio.Lock())
    async with lock:
        if os.path.isfile(target):
            return target
        pdf_path = await export_pdf()
        try:
            await asyncio.to_thread(render_pdf_first_page, pdf_path, target)
        finally:
            # The PDF was only a means to the PNG; downloads export their own.
            try:
                os.remove(pdf_path)
            except OSError:
                pass
        _remove_stale(presentation_id, target)
        LOGGER.info("[sibyl.thumbnail] rendered %s", target)
        return target


def delete_thumbnails(presentation_id: uuid.UUID) -> None:
    _remove_stale(presentation_id, keep="")
