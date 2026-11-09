from unittest.mock import Mock

import fastembed
import pytest

from scripts import warm_fastembed_cache


@pytest.mark.parametrize("provider", ["fastembed", "openai"])
def test_warmup_includes_qdrant_bm25_for_every_dense_provider(monkeypatch, provider):
    monkeypatch.setenv("MEM0_EMBEDDER_PROVIDER", provider)
    monkeypatch.delenv("MEM0_EMBEDDER_MODEL", raising=False)
    monkeypatch.setattr(
        warm_fastembed_cache.ICON_FINDER_SERVICE, "ensure_initialized", lambda: True
    )
    dense_model = Mock()
    sparse_model = Mock()
    dense_model.embed.return_value = iter([object()])
    sparse_model.embed.return_value = iter([object()])
    dense_factory = Mock(return_value=dense_model)
    sparse_factory = Mock(return_value=sparse_model)
    monkeypatch.setattr(fastembed, "TextEmbedding", dense_factory)
    monkeypatch.setattr(fastembed, "SparseTextEmbedding", sparse_factory)

    warm_fastembed_cache.main()

    if provider == "fastembed":
        dense_factory.assert_called_once_with(model_name="BAAI/bge-small-en-v1.5")
        dense_model.embed.assert_called_once_with(["warmup"])
    else:
        dense_factory.assert_not_called()
    sparse_factory.assert_called_once_with(model_name="Qdrant/bm25")
    sparse_model.embed.assert_called_once_with(["warmup"])
    # FastEmbed returns lazy iterators; warmup must execute the embedding work.
    assert list(sparse_model.embed.return_value) == []


def test_warmup_fails_when_bm25_embedding_fails(monkeypatch):
    monkeypatch.setenv("MEM0_EMBEDDER_PROVIDER", "openai")
    monkeypatch.setattr(
        warm_fastembed_cache.ICON_FINDER_SERVICE, "ensure_initialized", lambda: True
    )

    def failed_embedding(_texts):
        raise RuntimeError("BM25 cache is incomplete")
        yield  # Make failure lazy, like FastEmbed's embedding iterator.

    sparse_model = Mock()
    sparse_model.embed.side_effect = failed_embedding
    monkeypatch.setattr(fastembed, "SparseTextEmbedding", Mock(return_value=sparse_model))

    with pytest.raises(RuntimeError, match="BM25 cache is incomplete"):
        warm_fastembed_cache.main()
