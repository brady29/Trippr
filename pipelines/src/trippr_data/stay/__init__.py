"""Stay analytics (docs/data-platform-spec.md, Feature 5): open-data hotels, Inside Airbnb market data,
per-area aggregates and stay scores. Pipeline half only; the graph, map layer and app come with PR 3's bundle.

hotels.py     lodging places from Overture, Foursquare and OSM -> staging/<date>/stay/hotel.parquet
airbnb.py     Inside Airbnb snapshots -> normalised listings, calendar and review summaries
scoring.py    the documented, unit-tested formulas (value, reviews, centrality, walkability, quiet, blend, explanation)
analytics.py  aggregates by Trippr Area, Inside Airbnb neighbourhood and H3 cell, plus the scores
checks.py     data quality checks for the stay tables;  report.py  the report section
"""
