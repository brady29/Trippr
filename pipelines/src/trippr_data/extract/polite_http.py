"""A polite HTTP client for the extractors that read public web endpoints (no scraping, no parallelism).

- One request at a time, with a minimum pause between requests to the same client.
- A generic User-Agent that names the project's kind of traffic, not a person.
- Retries with backoff on 429 and 5xx (honouring Retry-After) and on network errors.
- Downloads stream to a temporary file and are checked against Content-Length before they replace the target.
- robots.txt of the host is read once and obeyed.
"""

from __future__ import annotations

import hashlib
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from collections.abc import Callable
from pathlib import Path

log = logging.getLogger(__name__)

USER_AGENT = "TrippRData/0.1 (open-data pipeline; one request at a time; obeys robots.txt)"
RETRY_STATUS = {429, 500, 502, 503, 504}
CHUNK = 1 << 20


class HttpError(RuntimeError):
    pass


class RobotsDisallowedError(HttpError):
    pass


def quote_url(url: str) -> str:
    """Percent-encode non-ASCII characters in the path (Inside Airbnb has regions like "kantō")."""
    parts = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(parts.path, safe="/%:@+,;=-._~!$&'()*")
    query = urllib.parse.quote(parts.query, safe="=&%+:,;/-._~")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


class PoliteClient:
    def __init__(
        self,
        *,
        user_agent: str = USER_AGENT,
        min_interval_s: float = 2.0,
        timeout_s: float = 120.0,
        retries: int = 4,
        backoff_s: float = 5.0,
        check_robots: bool = True,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.user_agent = user_agent
        self.min_interval_s = min_interval_s
        self.timeout_s = timeout_s
        self.retries = retries
        self.backoff_s = backoff_s
        self.check_robots = check_robots
        self._sleep = sleep
        self._monotonic = monotonic
        self._last_request: float | None = None
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self.requests = 0

    # -- pacing and robots ---------------------------------------------------------------------------

    def _pause(self) -> None:
        if self._last_request is not None:
            wait = self.min_interval_s - (self._monotonic() - self._last_request)
            if wait > 0:
                self._sleep(wait)
        self._last_request = self._monotonic()

    def _open(self, url: str, *, accept: str = "*/*"):
        request = urllib.request.Request(
            quote_url(url), headers={"User-Agent": self.user_agent, "Accept": accept}
        )
        self.requests += 1
        return urllib.request.urlopen(request, timeout=self.timeout_s)  # noqa: S310 (http(s) URLs only)

    def robots_allows(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            parser: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
            try:
                self._pause()
                with self._open(origin + "/robots.txt", accept="text/plain") as resp:
                    parser.parse(resp.read().decode("utf-8", "replace").splitlines())  # type: ignore[union-attr]
            except urllib.error.HTTPError as err:
                # No robots.txt (404 and friends) means no restrictions; a 401/403 is treated the same way
                # by the robots.txt standard (RFC 9309: unavailable = allowed, unreachable = disallowed).
                parser = None if err.code < 500 else _disallow_all()
            except (urllib.error.URLError, TimeoutError, OSError):
                parser = _disallow_all()
            self._robots[origin] = parser
        parser = self._robots[origin]
        return True if parser is None else parser.can_fetch(self.user_agent, url)

    def _guard(self, url: str) -> None:
        if self.check_robots and not self.robots_allows(url):
            raise RobotsDisallowedError(f"robots.txt disallows {url} for {self.user_agent}")

    # -- requests ------------------------------------------------------------------------------------

    def _with_retries(self, url: str, fn: Callable[[], object], *, method: str = "GET") -> object:
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            self._pause()
            try:
                return fn()
            except urllib.error.HTTPError as err:
                if err.code not in RETRY_STATUS:
                    raise HttpError(f"{method} {url}: HTTP {err.code}") from err
                last = err
                delay = _retry_after(err) or self.backoff_s * (3**attempt)
            except (urllib.error.URLError, TimeoutError, OSError, HttpError) as err:
                last = err
                delay = self.backoff_s * (3**attempt)
            if attempt < self.retries:
                log.warning("%s %s failed (%s); retrying in %.0fs", method, url, last, delay)
                self._sleep(delay)
        raise HttpError(f"{method} {url} failed after {self.retries + 1} attempts: {last}")

    def get_bytes(self, url: str, *, accept: str = "*/*") -> bytes:
        self._guard(url)

        def fetch() -> bytes:
            with self._open(url, accept=accept) as resp:
                return resp.read()

        return self._with_retries(url, fetch)  # type: ignore[return-value]

    def get_text(self, url: str, *, accept: str = "text/html") -> str:
        return self.get_bytes(url, accept=accept).decode("utf-8", "replace")

    def post_form(self, url: str, data: dict[str, str]) -> bytes:
        """A form POST (the Overpass API takes its query this way)."""
        self._guard(url)
        body = urllib.parse.urlencode(data).encode()

        def send() -> bytes:
            request = urllib.request.Request(
                quote_url(url),
                data=body,
                headers={"User-Agent": self.user_agent, "Accept": "application/json"},
            )
            self.requests += 1
            with urllib.request.urlopen(request, timeout=self.timeout_s) as resp:  # noqa: S310
                return resp.read()

        return self._with_retries(url, send, method="POST")  # type: ignore[return-value]

    def download(self, url: str, target: Path) -> tuple[int, str]:
        """Stream url to target (atomically); returns (bytes, sha256). Raises when the size is short."""
        self._guard(url)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".part")

        def fetch() -> tuple[int, str]:
            digest = hashlib.sha256()
            size = 0
            with self._open(url) as resp, open(tmp, "wb") as fh:
                expected = resp.headers.get("Content-Length")
                for chunk in iter(lambda: resp.read(CHUNK), b""):
                    fh.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            if expected is not None and int(expected) != size:
                raise HttpError(f"GET {url}: got {size} bytes, expected {expected}")
            return size, digest.hexdigest()

        try:
            size, sha = self._with_retries(url, fetch)  # type: ignore[misc]
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        tmp.replace(target)
        return size, sha


def _disallow_all() -> urllib.robotparser.RobotFileParser:
    parser = urllib.robotparser.RobotFileParser()
    parser.parse(["User-agent: *", "Disallow: /"])
    return parser


def _retry_after(err: urllib.error.HTTPError) -> float | None:
    value = err.headers.get("Retry-After") if err.headers else None
    try:
        return min(float(value), 300.0) if value else None
    except ValueError:
        return None
