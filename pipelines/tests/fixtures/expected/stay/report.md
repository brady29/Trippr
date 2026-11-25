## Stay analytics

Stay checks: **passed**

Inside Airbnb has data for 2 of Trippr's 108 cities (SIN, TYO); the other 106 cities have no market layer. 15 of 39 units have a stay score (units: city 2, area 19, neighbourhood 7, h3 11). Score weights: value 25%, centrality 30%, walkability 20%, quiet 15%, reviews 10%.

### Inside Airbnb

| City | Snapshot | Currency | CAD per unit | Listings | Inside city radius | No price | Outliers dropped | Long-stay (min nights) | Used for prices | Median CAD/night | Reviews, last 12 months |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SIN | 2026-09-23 | SGD | 1.1054 (2026-09-23) | 28 | 28 | 3 | 2 | 4 | 19 | 129 | 66 |
| TYO | 2026-09-25 | JPY | 0.00901 (2026-09-25) | 117 | 115 | 3 | 2 | 4 | 108 | 135 | 255 |

Prices are in each city's local currency and converted at the Bank of Canada rate on or before the snapshot date. Dropped as outliers: below CAD 10, or above the city's 99% percentile. Long-stay means a minimum stay over 28 nights (left out of price statistics).

### Headline numbers by city

| City | Median CAD/night | Entire home | Private room | Median CAD per person | Entire-home share | Rating | Unavailable next year | Multi-listing hosts | Hotels (open data) | Areas | Neighbourhoods | H3 cells |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SIN Singapore | 129 | 119 | 129 | 47 | 54% | 4.61 | 41% | 0% | 0 | 0 | 3 | 2 |
| TYO Tokyo | 137 | 144 | 119 | 38 | 63% | 4.415 | 42% | 10% | 13 | 3 | 4 | 9 |

- **TYO** best-scoring neighbourhoods: Taito Ku (62.2, CAD 113), Shinjuku Ku (58.2, CAD 140), Shibuya Ku (49.6, CAD 197)

### Hotels from open data

| Source | Version | Lodging rows | Closed | Outside cities | Excluded kind | No name | Staged | Kind other |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| foursquare | fixture | 7 | 1 | 0 | 1 | 0 | 5 | 1 |
| osm_lodging | 2026-11-17T22:00:00Z | 11 | 0 | 1 | 1 | 1 | 8 | 0 |
| overture | 2026-11-18.0 | 17 | 1 | 0 | 1 | 0 | 15 | 0 |

21 hotels after merging 28 source records (5 found in more than one source; 10 merged pairs). 7 fall in a Trippr Area, 3 have a star rating, 9 have a website. Kinds: apartment 2, guest_house 2, hostel 3, hotel 11, inn 1, motel 1, other 1.

38 seeded Areas have no coordinates yet and cannot be scored.

### Stay checks

| Check | Result | Detail |
|---|---|---|
| stay.hotel.schema | pass | 20 columns match |
| stay.hotel.required | pass | no nulls in hotel_id, name, kind, lat, lon, city_code, sources, licences |
| stay.hotel.unique_id | pass | hotel ids are unique |
| stay.hotel.city_radius | pass | all hotels are inside their city's radius |
| stay.hotel.country_bbox | pass | 0 hotels (0.00%) outside their country's bounding box |
| stay.hotel.licence | pass | every record has a licence listed in sources.yaml |
| stay.hotel.duplicates | pass | no same-name hotels within 50 m |
| stay.hotel.kinds | pass | 0 unknown kinds; 4.8% of hotels are kind 'other' |
| stay.airbnb.schema | pass | 37 columns match |
| stay.airbnb.required | pass | no nulls in city_code, listing_id, snapshot_date, room_type, currency, price_status, stats_ok |
| stay.airbnb.unique_ids | pass | listing ids are unique per city |
| stay.airbnb.coordinates | pass | at least 99.5% of listings have valid coordinates in every city |
| stay.airbnb.in_city_radius | pass | at least 90% of listings are inside the city radius |
| stay.airbnb.country_bbox | pass | 0 listings outside their country's bounding box |
| stay.airbnb.price_coverage | pass | at least 80% of listings have a price in every city |
| stay.airbnb.price_sanity | pass | every city's median price is within CAD 15..1000 a night |
| stay.airbnb.room_types | warn | unrecognised room types: {'SIN': 1} |
| stay.airbnb.fx | pass | every city has a Bank of Canada rate on or before its snapshot date |
| stay.airbnb.snapshot_age | pass | all snapshots are within 200 days of the run |
| stay.airbnb.neighbourhoods | pass | every listing's neighbourhood is in the city's neighbourhood list |
| stay.airbnb.calendar | pass | calendars cover nearly every listing |
| stay.airbnb.reviews_consistency | pass | the reviews summary matches reviews_ltm in the listings within 10% |
| stay.airbnb.licence | pass | licence and attribution recorded in _meta.json match sources.yaml |
| stay.airbnb.checksums | pass | 10 raw files match their recorded checksums |
| stay.unit.schema | pass | 48 columns match |
| stay.unit.unique_ids | pass | unit ids are unique per kind |
| stay.unit.scores_in_range | pass | all scores are within 0..100 |
| stay.unit.shares_in_range | pass | all shares are within 0..1 |
| stay.unit.privacy | pass | no unit under 3 listings shows listing statistics |
| stay.unit.explained | pass | every scored unit lists its parts and an explanation |
| stay.unit.coverage | info | 15 of 37 units have a stay score |
| stay.counts.vs_previous | info | no previous stay run; counts recorded as the baseline |

### Stay attribution

- **Inside Airbnb**: Data from Inside Airbnb (insideairbnb.com), CC BY 4.0. Location and snapshot date are shown with every figure.
- **Bank of Canada exchange rates (Valet API)**: Exchange rates from the Bank of Canada (bankofcanada.ca), daily average rates; converted prices are approximations.
- **OpenStreetMap lodging (tourism=hotel|hostel|guest_house|apartment|motel)**: © OpenStreetMap contributors, available under the Open Database Licence (openstreetmap.org/copyright).

