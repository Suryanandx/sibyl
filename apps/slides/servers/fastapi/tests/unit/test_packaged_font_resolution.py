import base64
import sys

import pytest

from templates.fonts_and_slides_preview import _preview_asset_url_to_data_uri
from utils import asset_directory_utils


@pytest.mark.parametrize("frozen", [False, True])
def test_preview_embeds_bundled_fonts_in_source_and_frozen_layouts(
    monkeypatch, tmp_path, frozen
):
    # Match Electron's resources/{fastapi,nextjs} tree, including spaces and
    # PyInstaller's _internal module location in installed APPX builds.
    servers = tmp_path / "Presenton Open Source" / "resources"
    backend = servers / "fastapi"
    module_root = backend / "_internal" if frozen else backend
    monkeypatch.setattr(
        asset_directory_utils,
        "__file__",
        str(module_root / "utils" / "asset_directory_utils.py"),
    )
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    monkeypatch.setattr(sys, "executable", str(backend / "fastapi.exe"))
    # Resolution must not depend on the caller's working directory.
    monkeypatch.chdir(tmp_path)
    font = servers / "nextjs" / "public" / "vendor" / "fonts" / "DM Sans[wght].ttf"
    font.parent.mkdir(parents=True)
    font.write_bytes(b"bundled-font")

    url = "/vendor/fonts/DM Sans[wght].ttf"
    assert asset_directory_utils.resolve_app_path_to_filesystem(url) == str(font.resolve())
    embedded = _preview_asset_url_to_data_uri(url)
    assert embedded.startswith("data:font/ttf;base64,")
    assert base64.b64decode(embedded.split(",", 1)[1]) == b"bundled-font"

    # Keep the existing containment check when selecting a packaged root.
    secret = servers / "nextjs" / "private.txt"
    secret.write_bytes(b"private")
    assert asset_directory_utils.resolve_app_path_to_filesystem(
        "/vendor/fonts/../../../private.txt"
    ) is None
