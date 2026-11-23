# Flight prices: provider spike and decision

Spike for Feature 6 of the [data platform spec](data-platform-spec.md) (build plan PR 9). Researched 23 Nov 2026 from each provider's public documentation and news coverage. Nothing was scraped, no account was created and no key was used.

## What the feature needs

- Prices for one origin, one destination and one departure date, in CAD, with the airline and number of stops.
- Cheap enough to run daily for every flight hop of every trip (about 7 dates per hop with a +/-3 day window).
- Free for a small personal project that is not a booking site.
- Terms that allow keeping a daily snapshot to draw a price history, and showing it to the trip's members.
- No scraping. Google Flights and Skyscanner's website both forbid it, so the "Search on Google Flights" deep link already in the app stays the way to check live prices and book.

## Options compared

| | Travelpayouts / Aviasales Data API | Amadeus Self-Service | Duffel | Kiwi.com Tequila | Kayak Price Insights |
|---|---|---|---|---|---|
| Still open to new developers | Yes: sign up as an affiliate, connect the Aviasales programme | **No.** New registrations were paused in early 2026 and the Self-Service portal and its keys were switched off on 17 July 2026; the replacement is request-based Enterprise access | Yes, but live data needs a business onboarding | **No** for individuals: partner-only since 2024 | Partner programme |
| Free quota | No stated price; rate limit of 600 requests a minute on `prices_for_dates` | n/a | Test mode is free; live searches are free until a search-to-order ratio above 1500:1, then a per-search fee | n/a | n/a |
| Test or sandbox data | None needed: the real endpoint is the free tier | n/a | Test mode returns only the fictional "Duffel Airways" with unrealistic schedules and prices, so it cannot show a real price history | n/a | n/a |
| What the price is | A **cached** price: the cheapest ticket Aviasales users searched for in the last 48 hours (entries kept 2 to 7 days). Per person, any currency (`currency=cad`) | Live shopping prices | Live bookable offers | Live | Aggregated price insights |
| Group size | Not a parameter (prices are per person, so the group total is a multiplication) | Yes | Yes | Yes | n/a |
| Coverage of the trip's routes | Strong on popular routes (Toronto to Tokyo, Tokyo to Hong Kong). Thin or empty on quiet routes and on dates far out | Good | Depends on airlines connected | Good | Good |
| Storing daily snapshots | The docs describe the data as a cache and recommend it for static pages; no clause against storing was found. The affiliate agreement forbids unauthorised software and misuse of the tools, and the full terms must be read when the account is created (see "Needs a person") | Was allowed for the test environment | Offers expire; terms restrict redistribution | n/a | n/a |
| Fit | Matches the spec and is the only free, open option | Gone | Right for **bookable** offers later, wrong for history | Closed | Closed |

Sources: [Amadeus statement and shutdown coverage](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers), the [Aviasales Data API article](https://support.travelpayouts.com/hc/en-us/articles/203956163), [API rate limits](https://support.travelpayouts.com/hc/en-us/articles/4402565416594), [Travelpayouts Data Access API reference](https://travelpayouts-data-api.readthedocs.io/), [Duffel test mode](https://duffel.com/docs/api/overview/test-mode) and [Duffel pricing](https://duffel.com/pricing), and secondary coverage of Kiwi.com's partner-only change. The Travelpayouts help centre returned HTTP 403 to automated fetches, so its rate-limit and requirement pages were read through search summaries and the community reference; **re-check them when signing up.**

## Decision

**Travelpayouts Data API (`/aviasales/v3/prices_for_dates`)**, as the spec already recommended. It is the only option that is free, open to a new personal project, and returns real (if cached) fares with an airline and stop count. The spike removed Amadeus (shut down) and Kiwi (closed) from the "later" list in the spec, so the later option is Duffel, for bookable offers only.

Why not simply Duffel: its test mode has no real prices, and live mode is built for businesses that book tickets.

### What the data is, and is not

- It is "the cheapest fare people recently searched for", not a live quote. A day can have no price at all. The chart therefore shows gaps and the feature is labelled **estimates, check the airline** everywhere.
- Prices are per person. The group total is computed in the app from the trip's traveller count.
- Fares can disappear from the cache, so the booking signal needs enough history before it says anything (see `bookingSignal` in `packages/rules/src/flight-signal.ts`).

### How it is called

```
GET https://api.travelpayouts.com/aviasales/v3/prices_for_dates
    ?origin=YYZ&destination=NRT&departure_at=2027-05-12
    &one_way=true&currency=cad&sorting=price&limit=1&unique=false
X-Access-Token: <TRAVELPAYOUTS_TOKEN>
```

One request per departure date, 7 per hop per day with the default window. The adapter keeps to a minimum gap between requests (default 250 ms, well under the 600 a minute limit), stops the run on a 429 and honours a per-day request budget. The response field names used are `data[].price`, `airline`, `transfers`, `departure_at`; the adapter is written to tolerate missing fields, and the **first real run should be checked against a live response** (this spike had no token, so the live API was never called).

## Settings

| Setting | Where | Meaning |
|---|---|---|
| `FLIGHT_PRICES_ENABLED` | API | Turns the feature on (endpoints return data, the web shows the chart). Off by default |
| `FLIGHT_PRICES_PROVIDER` | API and job | `travelpayouts` (default) or `demo` |
| `TRAVELPAYOUTS_TOKEN` | Secret Manager, job only | The real adapter is used only when this is set; the job does nothing without it |
| `FLIGHT_PRICES_DAILY_BUDGET` | job | Most provider requests per UTC day (default 300) |
| `FLIGHT_PRICES_WINDOW_DAYS` | job | Days either side of the planned date (default 3) |
| `FLIGHT_PRICES_MIN_INTERVAL_MS` | job | Minimum gap between requests (default 250) |
| `FLIGHT_PRICES_DROP_PCT` | job | A snapshot this far below the previous low raises a notice (default 15) |

## Needs a person

1. Create a Travelpayouts account, connect the Aviasales programme, and read the current Terms and the Data API terms for storing and showing cached prices. If the terms forbid keeping snapshots, set `FLIGHT_PRICES_PROVIDER=demo` (sample data only) or stop at the live endpoint.
2. Put the API token in Secret Manager as `TRAVELPAYOUTS_TOKEN` and pass it to the Cloud Run Job.
3. Run one manual job (`--dry-run` first) and compare a stored price with the same fare on the Aviasales site.
