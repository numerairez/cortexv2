"""Example feed — a template to copy for each real feed (see ``__init__.py``).

PLACEHOLDER: returns a few example rows so the flow can be tried end to end.
Delete this file once real feeds are added.
"""

from __future__ import annotations

import pandas as pd

from . import FeedError  # noqa: F401  (raise it with a short message when fetching fails)

NAME = "Example feed"
DESCRIPTION = "Example rows to try data feeds; replace with real fetch code."


def fetch(params: dict) -> pd.DataFrame:
    # TODO: replace with the real fetch code.
    return pd.DataFrame({
        "Date": ["2026-01-31", "2026-02-28", "2026-03-31"],
        "Item": ["Example A", "Example B", "Example C"],
        "Amount": [100.0, 250.5, 75.25],
    })
