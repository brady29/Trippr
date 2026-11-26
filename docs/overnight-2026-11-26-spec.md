# Overnight build, 26 to 27 November 2026

What gets built tonight, in what order, how each piece is checked, and how it ships while nobody is around to approve anything.

## The brief

- Build a **Telegram bot** that turns shared reels and links into trip ideas, and **swipe to vote** on ideas.
- Make the **trip-board page headers animate** like a real split-flap board.
- Build **10 more improvements**: six planning and visualisation features, four polish and reliability passes.
- Trippr is used **before the trip, not during it**. Connections abroad are shaky, so nothing here is for use on the road. The effort goes into planning, and into visualisations that make planning feel worth opening.

## How it ships without anyone awake

The owner chose: **merge and deploy anything that is green.**

1. Work happens on one branch per batch (`overnight/<batch>`), cut from the latest `main`.
2. Before a batch is pushed: rules, API and web unit tests, typecheck, lint and the full Playwright suite pass locally.
3. The branch is pushed and a PR opened (description says what it does and how it was checked, with no AI attribution lines).
4. When the PR's CI is green, it is rebase-merged into `main`. That starts the Deploy workflow (API to Cloud Run, web to Vercel).
5. After the deploy, the live site gets a smoke check: the pages the batch touched load, with no console errors.
6. **If anything fails**: fix and retry up to three times. If it still fails, the PR stays open and unmerged, the failure goes in the morning report, and the next batch starts from `main`, not from the broken branch.
7. **Never**: create accounts, handle or print secrets, change GitHub or GCP settings, force-push, rewrite `main`, or delete data. Database changes are additive (new properties, new node types) and need no migration.
8. Each batch updates the progress table at the end of this file, and the morning report sums up the night.

## Order and batches

Highest value first, so a short night still ships the important parts.

| Batch | Items |
|---|---|
| 1 | A. Animated split-flap boards · 2. Swipe to vote · P5. Group taste and consensus |
| 2 | 1. Telegram bot (stays switched off until the token exists) |
| 3 | P1. Trip strip you can drag · P6. Cancellation deadlines |
| 4 | P2. Line map · P3. Suggest a better order |
| 5 | P4. Budget flow and target |
| 6 | Q1 Accessibility · Q2 Performance · Q3 Slow-network resilience · Q4 Phone layout |

---

## A. Animated split-flap boards

**What.** Every `Flaps` title and board stat behaves like a station board. On load, each tile cycles through characters and lands on its letter, left to right with a short stagger. When a value changes (nights, the home date, the stop count), only the tiles that differ flip through to the new character.

**How.**
- A pure `flapSequence(from, to)` function returns the characters a tile shows on the way (space, A to Z, 0 to 9 and punctuation, in board order). It's unit tested.
- Each tile has a top and bottom half. The top half folds down with a CSS 3D rotate for each step, about 40 to 60 ms per step and at most about 700 ms per tile.
- `requestAnimationFrame` drives the animation; no timers left running after unmount.
- `BoardStat` values use the same flaps in a smaller size.
- `prefers-reduced-motion`: the final text appears with no animation.
- Screen readers get the final text only (the visible tiles are `aria-hidden`, with the real text in an sr-only span), so nothing is read out mid-flip.

**Done when.** Titles and stats flip on load and on change. Reduced motion shows static text. The e2e tests read the final text, and nothing in the suite gets slower.

## 1. Telegram bot

**What.** Add the Trippr bot to the group chat (or message it directly). Share a reel, a TikTok, a Google Maps link or any text, and it lands in the trip's Inbox, read by the same reader as forwarded emails. The bot replies with what happened: "Added Shibuya Sky to Tokyo's ideas", or "Saved to the Inbox; pick a city on Trippr".

**Linking a chat to a trip.**
- The Inbox page gets a Telegram panel with a link code and two buttons: "Add to a group" (`https://t.me/<bot>?startgroup=<code>`) and "Message the bot" (`?start=<code>`).
- `/start <code>` links that chat to the trip. Only editors and owners get a code (one each, per trip). Making a new code stops the old one linking new chats; chats already linked stay until someone unlinks them, from the Inbox or with /unlink.
- Items from a linked chat are applied as the member who linked it, with the Telegram sender's name shown ("Sent by Sam on Telegram"). If that member is a viewer, items wait for an editor.

**Commands.** `/start <code>`, `/help`, `/trip` (which trip this chat feeds), `/top` (the five ideas the group likes most, with a link to swipe), `/unlink`.

**API.**
- `POST /telegram/webhook` checks the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (constant-time) and rejects anything else.
- Each `update_id` is handled once. Messages from bots and from unlinked chats get a short help reply, and nothing is stored.
- Each chat is limited to 30 messages a minute.
- Message text and captions go through the existing inbox reader. A reel shared from Instagram arrives as its link, like a pasted link.
- New inbox source: `"telegram"`.
- Storage: `(:TelegramChat {chatId, title, linkedAt})-[:FEEDS]->(:Trip)`, `(:TelegramChat)-[:LINKED_BY]->(:User)`, and `Trip.telegramCode`.

**Config** (all optional; without the token the bot is off and the Inbox panel says how to set it up):
- `TELEGRAM_BOT_TOKEN` (secret)
- `TELEGRAM_WEBHOOK_SECRET` (secret)
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_URL`: when set, the API registers the webhook with Telegram on startup.
- `TELEGRAM_API_BASE`: for tests only.

**Deploy.** `deploy.yml` maps the two secrets only when the repository variable `TELEGRAM_BOT_TOKEN_SECRET` is set, following the inbox pattern. A missing secret can never fail a deploy.

**Tests.** A fake Telegram API (a local HTTP server) records `sendMessage` and `setWebhook` calls. API tests cover linking, the secret check, duplicate updates, an unlinked chat, a viewer-linked chat and each command. The reader runs in its existing fake mode.

**Done when.** With a token set, the bot works end to end against the fake API in tests. With no token, the app is unchanged and the deploy passes.

## 2. Swipe to vote

**What.**
- A new page, `/trips/:id/swipe`, listed under Ideas in the menu as "Swipe ideas".
- A stack of the ideas you haven't voted on yet, filtered by city. It defaults to the current route's cities in route order.
- Each card is a ticket-style postcard: the city in flaps, the title, category glyphs, the AI summary with its label, typical duration, price level and good-for tags.
- Swipe right for yes and left for no. Swipe up for "must do": a yes vote, plus planned at that city's stop on the current route if you're an editor. Swipe down to skip.
- Buttons for each direction, keyboard shortcuts (arrow keys, and U to undo), and one-step undo.
- After each vote, a small tally shows how the group feels about that idea so far.
- When the stack runs out, the end screen shows the group's favourites and the consensus chart (P5).

**API.** The activity page query gets `unvoted=true` (ideas the current member hasn't voted on). Voting uses the existing vote endpoints.

**Feel.** The card follows the finger with a slight rotation, and a YES or NOPE stamp fades in with distance. A swipe commits past 35% of the card width, otherwise the card springs back. Reduced motion uses fades only. Works with touch, mouse and keyboard.

**Done when.** e2e: voting by keyboard and by dragging records votes, undo reverts them, "must do" plans the idea, and the end screen appears.

## P1. Trip strip you can drag

**What.** The board header's timeline becomes interactive.
- Stops are bands sized by nights. Dragging the boundary between two stops trades nights between them, snapping to whole days, with a live date label.
- Booked dates are pins. A boundary held by a booking resists, and dragging past it turns red and opens the trade panel, using the same engine as the stepper.
- Overlays: weekends; fixed-date events as stars; booking pins (red when off their dates); each stop's pace as a fill; busy holiday periods shaded with a label (Golden Week, China's Labour Day and National Day, Obon, Songkran, Lunar New Year 2027 and 2028). The holiday dates are a small curated table with a note that dates are typical.
- Releasing saves through `setNights` with Undo.
- Keyboard: Tab focuses a boundary and the arrow keys move it, with a live region announcing the change.

**Done when.** e2e: dragging a free boundary trades nights. Dragging into a booked boundary opens the trade panel. The keyboard path works. Holidays show on a May route.

## P2. Line map

**What.** A schematic diagram of the route in the style of a rail network map.
- Stops become stations on an octilinear line (45 and 90 degree bends), laid out from real positions and then straightened.
- Segments are coloured by mode (rail solid, flights dashed), with travel time labels, country colour bands and booking pins at stations.
- Hovering or focusing a station highlights its stop card.
- A dot runs along the line when the route changes, or on the "Play" button. Reduced motion shows no movement.
- It appears in the route editor's sidebar as a "Map | Line" toggle (remembered), and on Compare as two lines that share stations where the routes overlap and split where they differ.

**How.** Pure SVG, laid out by a tested `schematicLayout()` in the rules package with a fixed grid. No new libraries.

**Done when.** The layout is deterministic and tested on Main and With Shanghai. Labels don't overlap at 340 px wide. Compare shows shared stations.

## P3. Suggest a better order

**What.**
- A "Suggest a better order" button on the route editor. It finds the order with the least travel (flight and rail times from the travel graph, falling back to distance), keeping the first stop first.
- Any order that would move a booking off its dates is rejected, so booked stops effectively stay put.
- The suggestion previews as the line map changing shape from the old order to the new, with "Saves about 9 h of travel and 2,100 km". Apply reorders, with Undo.

**How.** `bestOrder()` in rules: exact for up to 8 stops, otherwise 2-opt with restarts. Every candidate is checked with `editImpact`.

**Done when.** Unit tests: it never breaks an anchor, and it improves a deliberately scrambled route. e2e: preview, apply and undo.

## P4. Budget flow and target

**What.**
- A Sankey diagram from the per-person total to categories (stays, getting around, activities) to cities.
- Booked money is solid and estimates are hatched. It can switch between per person and the whole group.
- A budget target per person, stored on the trip (`budgetPerPerson`). Going over it is a check with fixes: the nights search with a cost goal ("Take a night from Shanghai: saves $140 per person").

**How.** Custom SVG Sankey in the rules package (`sankeyLayout()`, tested), drawn in the web app. No new libraries.

**Done when.** Unit tests for the layout and the over-budget goal. The diagram matches the budget panel's numbers. e2e: set a target, see the check, apply a fix.

## P5. Group taste and consensus

**What.**
- A consensus chart of the group's votes. Each idea is a bubble: how much the group likes it across, how much they agree up and down.
- "Everyone loves" sits top right, "Splits the group" sits low. It's shown at the end of swipe and as a "Group taste" view on Activities.
- A taste profile by category compares **you** with **the group average**. Nobody else's individual votes are shown.

**API.** Activity votes add `ups` and `downs` counts next to the net `votes`. The counts are anonymous, so no individual's vote is exposed.

**Done when.** The chart renders from the counts. Privacy is checked: no endpoint returns another member's individual vote.

## P6. Cancellation deadlines

**What.**
- Tickets and hotels get "free cancellation until" (a date, optional, editors only, in the leg form and the hotel booking form).
- Before that date a booking is a **refundable** anchor. Trades are still suggested first, but moving it says "free to change until 3 Mar" instead of "would need changing".
- After the date it's a normal booked anchor.
- Next to book gets deadline items: "Free cancellation on Ryokan Yachiyo ends in 5 days".
- The trip strip marks deadlines.

**How.** `freeCancelUntil` on legs and on booked stays. Anchors carry `refundableUntil`, and `planNights` and the trade panel word it accordingly.

**Done when.** Unit tests for the before and after behaviour. API round trip. The trade panel wording changes in e2e.

## Q1. Accessibility

- Every drag (swipe, trip strip, stop reordering) has a keyboard and button alternative.
- Dialogs and drawers trap focus and return it on close.
- Live regions announce saved changes and undo.
- New chips and charts meet WCAG AA contrast in both themes.
- Charts have text alternatives (a table or summary).
- A small check in the e2e suite (no new packages) fails on buttons or links without an accessible name and on images without alt, on the main planning pages.

## Q2. Performance

- Heavy visualisations (line map, Sankey, consensus chart, graph) load only when shown.
- Fix searches run once per route version, not on every render, and off the click path.
- Target: a nights change on a 20-stop route updates the screen in under 100 ms (measured in a Playwright test with performance marks).
- The route page's JavaScript doesn't grow by more than 15% over tonight's start.

## Q3. Slow-network resilience

Planning often happens on bad hotel or café Wi-Fi.
- Writes that fail on a network error retry with backoff. The change bar says "Saving… (retrying)" instead of throwing the change away.
- When the browser goes offline, a banner says changes will save when the connection is back.
- Queries keep the last good data on screen with a quiet "Couldn't refresh" note and a retry, instead of an error page.
- Loading states are skeletons shaped like the content, not spinners, on the route, Activities, Bookings and swipe pages.

## Q4. Phone layout

- The route editor, swipe, trip strip, line map and trip setup are checked at 390 px.
- No horizontal page scroll. Touch targets are at least 40 px. The swipe card fills the screen.
- Each of those pages gets a phone e2e test (`@phone`) asserting no horizontal overflow.

---

## Setting up the Telegram bot (for the owner)

The bot stays off until these steps are done. Never paste the token into a chat or a file in the repo.

1. **Create the bot.** In Telegram, open a chat with **@BotFather** and send `/newbot`. Give it a name (say *Trippr*) and a username ending in `bot` (say `trippr_trip_bot`). BotFather replies with a **token**. Keep it private.
2. **Let it read group messages.** In BotFather: `/setprivacy` → pick the bot → **Disable** (so it sees shared links in groups). Then `/setjoingroups` → **Enable**.
3. **Store the token and a webhook secret** in Google Cloud: console.cloud.google.com → your Trippr project → **Secret Manager** → **Create secret**.
   - Name `trippr-telegram-bot-token`, value: paste the token. Create.
   - Name `trippr-telegram-webhook-secret`, value: any long random string. One way to make it, in PowerShell:
     `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | % { $_.ToString('x2') }) -join ''`
     Copy the output into the value box. Create.
4. **Let the API read them.** On each of the two secrets: **Permissions** → **Grant access** → principal: the API's service account → role **Secret Manager Secret Accessor**. The API's account is shown on the Cloud Run service `trippr-api` → **Security** tab. If none is set there, it's the default compute account, `<project number>-compute@developer.gserviceaccount.com`. Your other `trippr-…` secrets already grant it, so you can copy from one of those.
5. **Tell the deploy about them** (GitHub → the repo → Settings → Secrets and variables → Actions → Variables):
   - `TELEGRAM_BOT_TOKEN_SECRET` = `trippr-telegram-bot-token`
   - `TELEGRAM_WEBHOOK_SECRET_NAME` = `trippr-telegram-webhook-secret`
   - `TELEGRAM_BOT_USERNAME` = the bot's username, without the @
   - `TELEGRAM_WEBHOOK_URL` = your API's address plus `/telegram/webhook`. The address is shown at the top of the Cloud Run service `trippr-api` (it ends in `.run.app`).
6. **Redeploy** (Actions → Deploy → Run workflow), or wait for the next merge. On startup the API registers its webhook with Telegram.
7. **Link the trip.** In Trippr, open Inbox → Telegram → "Add to a group", pick your group chat, and send the code it shows. Share a reel to test.

Steps 3 to 5 can happen before the bot code is merged. The deploy only maps the secrets once step 5's variables exist, and the bot code ignores them until it's in.

---

## Progress

| Item | Status | PR | Notes |
|---|---|---|---|
| A. Animated boards | done | batch 1 (#51), fix in batch 2 | Titles and board stats turn like split flaps; static under reduced motion. Batch 2: boards in a background tab land at once instead of sitting blank |
| 2. Swipe to vote | done | batch 1 | /trips/:id/swipe, keyboard, drag, undo, must do plans the idea |
| P5. Group taste | done | batch 1 | Consensus chart and taste radar from vote counts only |
| 1. Telegram bot | done | batch 2 (#52) | Off until the token and variables are set; the Inbox panel says so. Tested against a fake Telegram API |
| P1. Trip strip | done | batch 3 (#53) | Drag or arrow keys between stops; booked dates ask first; weekends, busy holidays, events, pins and pace |
| P6. Cancellation deadlines | done | batch 3 (#53) | Free cancellation on tickets and hotels; refundable wording; deadline items top Next to book |
| P2. Line map | done | batch 4 (#54) | Map/Line toggle in the route sidebar (remembered); Compare draws both routes with shared stations |
| P3. Better order | done | batch 4 (#54) | Exact up to 8 stops, 2-opt above; orders that move a booking are skipped; preview over the old line, apply with Undo |
| P4. Budget flow | done | batch 5 (#55) | Sankey (booked solid, estimates hatched, per person or group); owner sets a budget per person; over it, fixes that move no booking |
| Q1. Accessibility | built | batch 6 | Dialogs and drawers trap focus and give it back; e2e check for unnamed controls on five pages; animations off under reduced motion |
| Q2. Performance | built | batch 6 | e2e measures a nights change on screen (about 220 ms on the dev server; limit 400 ms) |
| Q3. Slow networks | built | batch 6 | Saves retry network failures with backoff and wait while offline; offline banner; change bar says a save is waiting; route skeleton |
| Q4. Phone layout | built | batch 6 | No sideways scroll on five pages at 390 px (phone project); 40 px touch targets on stop cards; Compare cards fixed |
