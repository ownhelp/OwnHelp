"""Database-name resolution for development, training and evaluation code.

MONGODB_DB_NAME is the production database. Everything used for training, synthetic data and
evaluation must read MONGODB_TRAINING_DB_NAME instead, and must never fall back to production.

Inputs: an environment mapping (defaults to ``os.environ``). Output: the database name string.
Callers: dev/eval/training scripts under ``scripts/``. Note that the runtime retriever and ingestor
resolve ``MONGODB_DB_NAME`` (default ``rag_knowledge_base``) themselves; the URI always comes from
``MONGODB_URI``. The hard failure here is deliberate so a missing variable can never silently
point evaluation or training at the demo database.
"""

import os
from typing import Mapping, Optional


def resolve_training_db_name(env: Optional[Mapping[str, str]] = None) -> str:
    """Return MONGODB_TRAINING_DB_NAME, or raise if it is unset or empty."""
    source = os.environ if env is None else env
    name = (source.get("MONGODB_TRAINING_DB_NAME") or "").strip()
    if not name:
        raise ValueError(
            "MONGODB_TRAINING_DB_NAME is not set. Dev, training and evaluation code must use it "
            "and never fall back to the production MONGODB_DB_NAME."
        )
    return name
