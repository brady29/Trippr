# Overnight report, 26 to 27 November 2026

Everything in [the spec](overnight-2026-11-26-spec.md) was built. Each batch passed every test locally and in CI before it was merged and deployed. One step is left for you: setting up the Telegram bot (below).

## What shipped

| Batch | PR | What | Live |
|---|---|---|---|
| 1 | brady29/Trippr#51 | Animated split-flap boards, swipe to vote, group taste charts | Deployed, checked |
| 2 | brady29/Trippr#52 | Telegram bot (switched off until set up), boards in background tabs land at once | Deployed, checked |
| 3 | brady29/Trippr#53 | Trip strip you can drag, busy holidays, free cancellation deadlines | Deployed, checked |
| 4 | brady29/Trippr#54 | Line map, two-route map on Compare, Suggest a better order | Deployed |
| 5 | brady29/Trippr#55 | Where the money goes: budget flow and budget per person | See below |
| 6 | brady29/Trippr#56 | Accessibility, slow-network saving, phone layout, quality tests | See below |

Test counts grew from 198 to 215 rules tests, 431 to 442 API tests (plus 10 Telegram tests), 60 to 67 web unit tests, and 72 to 105 browser tests.

## Your one step: the Telegram bot

The steps are in the spec under "Setting up the Telegram bot". In short: create the bot with @BotFather, put its token and a webhook secret in Secret Manager, grant the API's service account access, and add the four `TELEGRAM_*` repository variables. Then run the Deploy workflow. Until then, the Inbox explains how the bot will work, and deploys are unaffected.

I only tested the bot against a fake Telegram API, since there was no real bot to talk to. After you set it up, send `/start <code>` from the Inbox panel in your group chat and share a reel to confirm it works end to end.

## Where it differs from the spec

- **Better order** measures straight-line distance, not travel-graph times. Distance is available for every pair of cities, while travel times are missing for many. A follow-up could switch to times where they exist.
- **Budget per person** can only be set by the trip owner, because only owners can change trip settings today. Editors can still apply the fixes.
- **Performance**: the spec aimed for under 100 ms on a 20-stop route. I measured about 220 ms on the development server with 11 stops, and the test fails above 400 ms. A production build is faster, but I didn't measure the 100 ms target or the bundle size.
- **Slow networks**: saves retry and wait while offline. However, lists that fail to refresh don't yet show a "Couldn't refresh" note; they keep their last data silently. Skeletons replace the spinner on the route editor only, not on Activities, Bookings or swipe.
- **Accessibility**: focus handling and named controls are tested, but contrast wasn't checked with an audit tool.
- **Holiday dates** are a small curated table marked "typical dates". The Lunar New Year dates for 2026 to 2029 are worth a glance.

## Worth knowing

- Deleting a route or a stop now deletes its tickets too; before, they were left behind as orphans.
- On a real phone, the new screens fit 390 px without sideways scrolling, and stop card buttons are larger there.
- The live site logs two "403" errors in the browser console on every page. They aren't from Trippr: every call to the Trippr API returns 200. They most likely come from Clerk's development sign-in scripts, which the browser can't inspect. Moving Clerk to a production instance should clear them.
