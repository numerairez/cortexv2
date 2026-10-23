"""Data feeds: tables fetched by code rather than read from a file the user picked.

Each feed is one module in this folder (files starting with ``_`` are ignored).
To add a feed, copy ``example.py``, give it a new file name, set its ``NAME`` and
``DESCRIPTION``, and put the fetch code in ``fetch``. It shows up in "Add a source"
and "Add data" after the app restarts; the file name is the feed's id, so keep it
stable once sources use it.

A feed module defines:
- ``NAME``: how the feed is shown in the app (and the default name of its sources),
- ``DESCRIPTION`` (optional): one line shown under the name,
- ``fetch(params: dict) -> pandas.DataFrame``: ``params`` is what was given when
  the source was added (may be empty). Raise ``FeedError`` with a short,
  user-readable message on failure (no credentials or stack traces).

The app saves what ``fetch`` returns as a CSV snapshot, so the rest of the app
reads a feed like any other CSV source. Refreshing the source calls ``fetch`` again.
"""

from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from types import ModuleType


class FeedError(Exception):
    pass


@dataclass
class Feed:
    id: str
    name: str
    description: str = ""
    module: ModuleType | None = None
    error: str | None = None  # the module could not be loaded (e.g. a library missing on this PC)

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description, "error": self.error}


def available() -> list[Feed]:
    feeds = []
    for m in pkgutil.iter_modules(__path__):
        if m.name.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"{__name__}.{m.name}")
        except Exception as e:  # a broken feed must not take the others down
            feeds.append(Feed(m.name, m.name, error=f"Could not load: {e.__class__.__name__}: {e}"))
            continue
        if not callable(getattr(mod, "fetch", None)):
            feeds.append(Feed(m.name, getattr(mod, "NAME", m.name), error="Has no fetch() function"))
            continue
        feeds.append(Feed(m.name, getattr(mod, "NAME", m.name), getattr(mod, "DESCRIPTION", ""), mod))
    return sorted(feeds, key=lambda f: f.name.lower())


def get(feed_id: str) -> Feed:
    for f in available():
        if f.id == feed_id:
            if f.error:
                raise FeedError(f"{f.name}: {f.error}")
            return f
    raise FeedError(f"Data feed '{feed_id}' is not set up on this PC")
