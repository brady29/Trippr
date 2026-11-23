"""A small polite HTTP client for the public APIs (Overpass, Wikidata) and the Wikimedia dumps.

- Identifies the app in the User-Agent (Wikimedia and OSM both ask for this).
- Waits at least `min_interval` seconds between requests, and longer after a slow one.
- Retries 429, 502, 503 and 504 with backoff (honouring Retry-After) and gives up after `retries`.
- Sends Accept-Encoding: gzip and decodes the response.

Only the standard library is used, so the package needs no HTTP dependency.
"""

from __future__ import annotations

import gzip
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

log = logging.getLogger(__name__)

USER_AGENT = "TripprDataPipeline/0.2 (https://github.com/brady29/Trippr; open-data place catalogue)"
RETRY_STATUS = {429, 500, 502, 503, 504}


class HttpError(RuntimeError):
    pass


class PoliteClient:
    def __init__(
        self,
        *,
        min_interval: float,
        timeout: float = 120.0,
        retries: int = 5,
        backoff: float = 30.0,
        user_agent: str = USER_AGENT,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.min_interval = min_interval
        self.timeout = timeout
        self.retries = retries
        self.backoff = backoff
        self.user_agent = user_agent
        self._sleep = sleep
        self._clock = clock
        self._next_allowed = 0.0
        self.requests = 0

    def _wait(self) -> None:
        delay = self._next_allowed - self._clock()
        if delay > 0:
            self._sleep(delay)

    def request(
        self,
        url: str,
        *,
        data: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        retries: int | None = None,
    ) -> bytes:
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        hdrs = {"User-Agent": self.user_agent, "Accept-Encoding": "gzip", **(headers or {})}
        last: Exception | None = None
        attempts = retries or self.retries
        for attempt in range(1, attempts + 1):
            self._wait()
            started = self._clock()
            self.requests += 1
            wait_more = 0.0
            try:
                req = urllib.request.Request(url, data=body, headers=hdrs)
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        raw = gzip.decompress(raw)
                self._next_allowed = self._clock() + max(self.min_interval, 1.0 * (self._clock() - started))
                return raw
            except urllib.error.HTTPError as err:
                last = err
                if err.code not in RETRY_STATUS:
                    raise HttpError(f"{url}: HTTP {err.code}") from err
                retry_after = err.headers.get("Retry-After") if err.headers else None
                wait_more = float(retry_after) if retry_after and retry_after.isdigit() else 0.0
            except (TimeoutError, urllib.error.URLError, ConnectionError) as err:
                last = err
            wait = max(wait_more, self.backoff * attempt)
            log.warning("%s failed (%s); retry %d/%d in %.0fs", url, last, attempt, attempts, wait)
            self._next_allowed = self._clock() + wait
        raise HttpError(f"{url}: gave up after {attempts} attempts: {last}")
