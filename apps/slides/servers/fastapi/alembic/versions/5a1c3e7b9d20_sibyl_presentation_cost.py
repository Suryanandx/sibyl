"""Sibyl: actual model cost per presentation (USD, from OpenRouter usage accounting)

Revision ID: 5a1c3e7b9d20
Revises: 026c0ba8b35c
Create Date: 2026-11-09 18:00:00

"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "5a1c3e7b9d20"
down_revision: str | None = "026c0ba8b35c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return True  # nothing to change (partial schemas in migration tests)
    return any(item["name"] == column for item in inspector.get_columns(table))


def upgrade() -> None:
    if not _has_column("presentations", "cost_usd"):
        op.add_column("presentations", sa.Column("cost_usd", sa.Float(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("presentations") and _has_column("presentations", "cost_usd"):
        with op.batch_alter_table("presentations") as batch:
            batch.drop_column("cost_usd")
