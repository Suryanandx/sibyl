"""Pre-download FastEmbed / Hugging Face weights at Docker image build time.

Icon search uses AllMiniLML6V2 in ``PRESENTON_FASTEMBED_ICON_CACHE_DIR``.
Mem0 OSS uses ``BAAI/bge-small-en-v1.5`` and ``Qdrant/bm25`` in
``FASTEMBED_CACHE_PATH`` (default ``/tmp/fastembed_cache``, independent of ``HF_HOME``).
"""

from pathlib import Path
import os
import sys


FASTAPI_ROOT = Path(__file__).resolve().parents[1]
if str(FASTAPI_ROOT) not in sys.path:
    sys.path.insert(0, str(FASTAPI_ROOT))


from services.icon_finder_service import ICON_FINDER_SERVICE


def _warm_mem0_default_fastembed() -> None:
    provider = (os.getenv("MEM0_EMBEDDER_PROVIDER") or "fastembed").strip() or "fastembed"
    if provider != "fastembed":
        print(
            f"Skipping Mem0 embedder warmup (MEM0_EMBEDDER_PROVIDER={provider!r}, not fastembed)"
        )
        return
    model = (os.getenv("MEM0_EMBEDDER_MODEL") or "BAAI/bge-small-en-v1.5").strip() or (
        "BAAI/bge-small-en-v1.5"
    )
    from fastembed import TextEmbedding

    embedder = TextEmbedding(model_name=model)
    next(embedder.embed(["warmup"]))
    print(f"Mem0 default fastembed model warmed: {model}")


def main() -> None:
    if not ICON_FINDER_SERVICE.ensure_initialized():
        raise RuntimeError("Failed to prepare fastembed cache for icon search")

    print(
        f"Fastembed cache prepared at {ICON_FINDER_SERVICE.cache_directory}"
    )
    _warm_mem0_default_fastembed()
    # Qdrant uses BM25 even when Mem0's dense embedder is a different provider.
    from fastembed import SparseTextEmbedding

    sparse_embedder = SparseTextEmbedding(model_name="Qdrant/bm25")
    next(sparse_embedder.embed(["warmup"]))
    print("Mem0 BM25 model warmed: Qdrant/bm25")


if __name__ == "__main__":
    main()
