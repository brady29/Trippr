"""Does a hosted endpoint serve the same model as the one that embedded the places?

The hybrid design (place vectors computed locally, query vectors from a hosted call) only works when the
two sides agree. Run this before relying on a hosted query path. It embeds the labelled queries locally
and through the endpoint and reports the cosine between the two vectors of each query (should be
above 0.98; a different model gives about 0) and how often each query's top-10 places agree.

    CF_ACCOUNT_ID=... CF_API_TOKEN=... python eval/search/parity_check.py st-bge-m3 \\
        --endpoint cloudflare:@cf/baai/bge-m3 --doc-vectors vec-st-bge-m3.npy --corpus places.parquet \\
        --queries eval/search/queries_bundle.yaml

Credentials come from the environment only. The Cloudflare request shape (`{"text": [...]}` in,
`result.data` out) is from its documentation and has not been run by the author: no account was set up
while the spike was written. It sends only the short query strings in the labelled set.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "src"))


def hosted_vectors(endpoint: str, texts: list[str]):
    import numpy as np

    kind, _, model = endpoint.partition(":")
    if kind != "cloudflare":
        raise SystemExit("only cloudflare:<model> is implemented; add the provider's request shape here")
    account, token = os.environ.get("CF_ACCOUNT_ID"), os.environ.get("CF_API_TOKEN")
    if not account or not token:
        raise SystemExit("set CF_ACCOUNT_ID and CF_API_TOKEN in the environment")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
    request = urllib.request.Request(
        url,
        data=json.dumps({"text": texts}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = json.load(response)
    vectors = np.array(body["result"]["data"], dtype=np.float32)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def main() -> int:
    import numpy as np

    from trippr_data.embed.embedders import make_embedder
    from trippr_data.embed.evaluate import load_queries, rank_all
    from trippr_data.embed.inputs import read_places

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("model", help="the local model that made the place vectors")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--doc-vectors", required=True, help=".npy of the place vectors")
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--queries", required=True)
    parser.add_argument("--limit", type=int, default=30, help="how many queries to send")
    args = parser.parse_args()

    queries = load_queries(Path(args.queries), args.corpus)[: args.limit]
    ids = [p.place_id for p in read_places(args.corpus)]
    matrix = np.load(args.doc_vectors)
    texts = [q.text for q in queries]
    local = make_embedder(args.model).embed_queries(texts)
    remote = hosted_vectors(args.endpoint, texts)
    cosines = (local * remote).sum(axis=1)
    local_top = rank_all(local, matrix, ids, 10)
    remote_top = rank_all(remote, matrix, ids, 10)
    overlap = [len(set(a) & set(b)) / 10 for a, b in zip(local_top, remote_top, strict=True)]
    print(f"queries {len(texts)}  cosine min {cosines.min():.4f} mean {cosines.mean():.4f}")
    print(
        f"top-10 overlap mean {np.mean(overlap):.2f}  top-1 agree {np.mean([a[0] == b[0] for a, b in zip(local_top, remote_top, strict=True)]):.2f}"
    )
    return 0 if cosines.min() >= 0.98 else 1


if __name__ == "__main__":
    sys.exit(main())
