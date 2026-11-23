"""Optional upload of a run to gs://$DATA_BUCKET, mirroring the local out/ layout.

Uses the gcloud CLI (already signed in on the GitHub runner by google-github-actions/auth), so the
package needs no Google Cloud client library.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

from .layout import latest_json, matched_dir, raw_dir, raw_sources, report_json, report_md, staging_dir

log = logging.getLogger(__name__)


def run_paths(out: Path, date: str) -> list[Path]:
    """Everything one run wrote: raw/<source>/<date>/, staging/<date>/, matched/<date>/ and its reports."""
    paths = [raw_dir(out, s, date) for s in raw_sources(out, date)]
    paths += [staging_dir(out, date), matched_dir(out, date)]
    paths += [report_md(out, date), report_json(out, date)]
    if latest_json(out).is_file():
        paths.append(latest_json(out))
    return [p for p in paths if p.exists()]


def upload(out: Path, date: str, bucket: str) -> list[str]:
    gcloud = shutil.which("gcloud")
    if not gcloud:
        raise RuntimeError("DATA_BUCKET is set but the gcloud CLI is not installed")
    uploaded = []
    for path in run_paths(out, date):
        rel = path.relative_to(out).as_posix()
        dest = f"gs://{bucket}/{rel}"
        if path.is_dir():
            cmd = [gcloud, "storage", "rsync", "--recursive", str(path), dest]
        else:
            cmd = [gcloud, "storage", "cp", str(path), dest]
        log.info("uploading %s -> %s", rel, dest)
        subprocess.run(cmd, check=True)
        uploaded.append(dest)
    return uploaded
