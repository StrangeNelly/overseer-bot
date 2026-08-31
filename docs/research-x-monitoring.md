# Watching X accounts for Groupie — findings (verified 1 Sept 2026)

## 1. Official X API — the landscape changed in 2026

- **Pricing model**: X replaced subscription tiers with **pay-per-use** in February 2026 and auto-migrated remaining legacy Basic ($200/mo) subscribers to it starting June 1, 2026 (wearefounders.uk, postproxy.dev, both Aug 2026). The official docs (docs.x.com/x-api/getting-started/pricing, fetched Sept 1, 2026) confirm: "pay only for what you use", credit-based, no subscription.
- **Rates (official docs, Sept 2026)**: **$0.005 per post read**, $0.010 per user read, $0.015 per post create ($0.20 if it contains a URL), owned-data reads $0.001. Capped at **3 million post reads per monthly billing cycle** on pay-per-use (official docs; one third-party source said 2M — the 3M figure is from docs.x.com). No minimum spend.
- **Free tier**: effectively **gone for new developers** — multiple Aug 2026 sources agree the general free tier no longer exists; X grants free access case-by-case only to "public utility" apps. UNCERTAIN whether any residual free write-only tier remains for legacy accounts.
- **Filtered stream**: available on pay-per-use — 1 concurrent connection, 1,000 rules per project (1,024 chars each), per devcommunity.x.com threads and docs.x.com/x-api/posts/filtered-stream. Delivered posts bill at the post-read rate. A "Filtered Stream Webhooks API" was announced on the X dev forum (push delivery without holding a connection).
- **Cost math for Groupie (official API)**:
  - *Polling 100 timelines every 5 min*: 100 × 288 checks/day, each returning even ~5 posts = ~4.3M post reads/month → over the cap and ~**$21,000/mo**. Every 1 min is 5× worse. Completely non-viable.
  - *Filtered stream with `from:` rules* (pay only for matched posts): 100 accounts × ~5 tweets/day = ~15,000 reads/mo → **~$75/mo**; 20 quiet accounts could be ~$5–15/mo. Viable technically, but no free tier, and the per-URL/write pricing signals X is squeezing small devs. Latency: true push, seconds.

## 2. twitterapi.io (unofficial, largest third-party)

- **Pricing** (twitterapi.io/pricing, fetched Sept 1, 2026): **$0.15 per 1,000 tweets** ($0.00015/tweet), $0.18/1k profiles, **minimum $0.00015 per call**; 1 USD = 100,000 credits; ~$1 trial credit on signup; no monthly minimum.
- **Monitoring feature — webhook/WebSocket "tweet filter rules"** (docs.twitterapi.io add_webhook_rule + twitterapi.io/blog/twitter-monitoring + blog/using-webhooks-for-real-time-twitter-data): create a rule like `from:acct1 OR from:acct2 ...` (their docs' own example uses `from:`), set `interval_seconds` (docs say 0.05s–86,400s; blog says 0.1s min — sub-second is "turbo" priced), get matched tweets pushed to your webhook or WebSocket.
  - **Per-check costs (their blog's table)**: empty check **$0.00012/call**; per-rule monthly cost ≈ **$1.00 at 5-min interval, $5.00 at 1-min, $30 at 10s, $300 at 1s**, plus $0.00015 per matched tweet delivered.
  - **Rule capacity**: one rule "comfortably handles dozens of handles; ~100 handles is practical before splitting" (their monitoring guide). Their 50-account worked example: ~3,000 matched tweets/mo ≈ **under $0.50/mo in tweet fees**.
- **Groupie estimate**: 20–100 accounts fit in **one rule**. At 60s interval: ~$5.18/mo checks + ~$0.50–3/mo matched tweets ≈ **$6–8/mo total**. At 5-min interval: **~$1.50–4/mo**. Latency ≈ your chosen interval (roughly 1–2 min end-to-end at a 60s interval).
- **Reliability/ToS**: unofficial (scrapes X via its own account pools) — violates X ToS; risk sits mostly with the provider (service could be disrupted/shut down), not with your X account since you never authenticate. Widely used in the crypto-bot scene; uptime generally good per community comparisons, but no SLA at hobby spend. UNCERTAIN: long-term survival given X's 2026 legal offensive (see Nitter below).

## 3. socialdata.tools (unofficial, most polished monitoring product)

- **Base API**: $0.0002 per tweet/profile returned (socialdata.tools, docs pricing page).
- **User Monitors** (docs.socialdata.tools/monitoring/pricing, fetched Sept 1, 2026): flat hourly rate per monitored account regardless of volume — **~$4.99/mo each (1–10 monitors), ~$4.49 (11–100), ~$3.99 (101–300)**. Delivers new tweets/replies/quotes/RTs **and profile changes (name, bio, avatar, website) and follows**, via webhook, "up to 30 seconds after the change happens on X, and usually well under that" (their docs). One webhook event per change; deduplicated; event history/replay endpoint.
  - Cost: 20 accounts ≈ **$90/mo**; 100 accounts ≈ **$400–450/mo**. Too rich for hobby use across the whole watchlist.
- **Search Monitors**: your query run on a schedule — $0.0002/tweet delivered + $0.0002 flat per empty execution. Minimum cost ≈ **$17.28/mo at 30s refresh, $8.64/mo at 60s, $1.73/mo at 5-min** per monitor. Batching many `from:` handles with OR into one query should work (standard search syntax), so 100 accounts ≈ 2–4 monitors ≈ **$4–35/mo** depending on refresh. UNCERTAIN: exact query-length cap per search monitor (docs don't state it).
- Monitors pause when credit runs out and resume on top-up. No subscription required.

## 4. Apify scrapers

- Actors: apidojo Tweet Scraper V2 **$0.40/1k tweets**; kaitoeasyapi **$0.25/1k**; xquik **$0.15/1k** (Apify store pages, 2026). Pay-per-result, zero charge on empty runs (varies by actor).
- Platform: Free plan = **$5/mo usage credit** (8–16GB RAM, 25 concurrent runs); Starter **$29/mo** (scrapewise.ai / use-apify.com, July 2026).
- **Problem for Groupie**: near-real-time means ~8,600–43,000 scheduled runs/month; actor cold-start adds ~10–60s latency per run and compute-unit costs on top of per-result fees — the $5 free credit evaporates. Apify is built for batch scraping, not 1-minute polling. Realistic cost at 1–5 min cadence: **$30–100+/mo** and worse latency than the API-shaped services. Not recommended for the watcher (fine for occasional backfill).

## 5. Nitter / RSS bridges — effectively dead

- **Nitter**: X Corp sent **cease-and-desist letters on Aug 24, 2026** demanding takedown of Nitter and its instances; nitter.net went offline, development stopped, and the GitHub repo was **archived Aug 26, 2026** (TechCrunch Aug 25, 2026; Wikipedia; zedeus/nitter). Public instances are decommissioned. Self-hosting a private instance is still technically possible but requires feeding it real X session accounts (ban risk on those accounts), constant maintenance, and now carries explicit legal-heat signal. **Do not build on Nitter in Sept 2026.**
- **RSS-Bridge**: same underlying scraping problem; Twitter bridge reliability has been poor for years. UNCERTAIN current status, but strictly worse than the paid scrape-APIs.
- **RSS.app** (hosted): can turn an X profile into RSS, but refresh is **15 min minimum on paid plans (~$8.32+/mo annual), 60 min on Basic, 24h on free** (help.rss.app, rss.app/pricing). Far too slow for launch-sniping. Other hosted RSS services are similar.

## 6. Comparison summary

| Option | 20 accts / mo | 100 accts / mo | Latency | Reliability | ToS/ban risk |
|---|---|---|---|---|---|
| Official X API, timeline polling | $1,000s | $20k+ | 1–5 min | High | None (compliant) |
| Official X API, filtered stream | ~$5–25 | ~$75+ | seconds (push) | High | None; but no free tier, price-hike risk |
| **twitterapi.io filter rule + webhook** | **~$2–6** | **~$6–8** | ~interval (60s ≈ 1–2 min) | Good, no SLA | Provider-side ToS breach; your account untouched; provider-shutdown risk |
| socialdata.tools user monitors | ~$90 | ~$400+ | ≤30s + profile-change events | Good | Same class of risk |
| socialdata.tools search monitors (batched) | ~$9–18 | ~$18–35 (60s) | ~refresh freq | Good | Same class of risk |
| Apify scheduled actors | ~$30+ | ~$60–100+ | minutes | Medium (cold starts) | Same class + platform variability |
| Nitter / RSS-bridge | $0 | $0 | n/a | Dead (C&D Aug 2026) | Highest — active legal takedowns |
| RSS.app | ~$8+ | ~$8+ (feed caps) | 15–60 min | OK | Low-ish | 

## Design notes for Groupie

- One twitterapi.io rule (`from:` OR-chain, up to ~100 handles) covers the whole `/groupie addlaunchmonitor` list; update the rule via `update_rule` whenever a handle is added/removed. Rules start inactive and must be activated with a separate call.
- Tweet-only rules miss a common launch pattern: pre-launch accounts that announce via **bio/name/pinned changes**. SocialData's user monitors are the only product found that pushes profile-change events (≤30s). A hybrid — twitterapi.io rule for all handles + 2–5 SocialData user monitors ($9–25/mo) on the highest-conviction pre-launch accounts — covers this if the group cares.
- Whatever provider is chosen, put it behind a thin `TweetWatcher` interface with webhook ingestion — the whole category is legally contested in 2026 (Nitter C&D; X has litigated against scrapers) and any unofficial provider could vanish with days of notice. SocialData search monitors are the drop-in fallback for twitterapi.io and vice versa.
- Windows/hobby note: webhook delivery needs a public HTTPS endpoint — a $0–5/mo fly.io/Railway worker or a Cloudflare Worker in front of the Groupie backend solves this; twitterapi.io's WebSocket delivery option avoids inbound connections entirely if the app runs somewhere that can't accept them.

## Bottom-line recommendation

Use twitterapi.io's webhook "tweet filter rule" as Groupie's launch-monitor engine: one rule containing `from:handle1 OR from:handle2 ...` for every account added via /groupie addlaunchmonitor (a single rule handles ~100 handles), checked at a 60-second interval and pushed to a Groupie webhook (or WebSocket if the backend can't accept inbound HTTPS). Verified cost is ~$5/month for the 60s rule plus $0.15 per 1,000 matched tweets — realistically $6–8/month for 20–100 accounts at ~1–2 minute latency, or ~$2/month if 5-minute latency is acceptable. Do NOT use the official X API for v1: the free tier is gone for new developers in 2026, timeline polling at this cadence costs thousands per month at $0.005/post-read, and even the compliant filtered-stream path runs ~$75/month for 100 active accounts. Do NOT build on Nitter or RSS bridges — X's August 2026 cease-and-desist killed the public Nitter ecosystem, and hosted RSS refreshes (15–60 min) are too slow to catch launches. Wrap the provider behind a thin TweetWatcher interface with SocialData.tools search monitors (~$9–35/month batched) as the tested fallback, since any unofficial provider can be legally disrupted; optionally add 2–5 SocialData user monitors (~$4.49/month each, ≤30s latency) on the hottest pre-launch accounts because they also push bio/name/profile-change events that tweet-only rules miss. Budget line item: ~$10/month, worst-case fallback ~$35/month.

## Open questions for the owner

- Is ~1-2 minute latency acceptable for launch calls, or does the group want the 10-second tier (~$30/month per rule on twitterapi.io)?
- Should launch monitoring also catch profile/bio/name changes on pre-launch accounts (adds ~$4.50/month per account via SocialData user monitors), or are new tweets enough for v1?
- Roughly how many accounts will actually be on the watchlist at once, and should stale monitors auto-expire after N days to cap cost?
- Is the team comfortable building on ToS-violating third-party scrape APIs (provider-shutdown risk, mitigated by a fallback), or is official-API compliance a hard requirement for the later multi-group SaaS phase?
- Where will the always-on webhook receiver run (existing VPS, Cloudflare Worker, fly.io) — or should the design use twitterapi.io's WebSocket mode to avoid hosting a public endpoint?

## Sources consulted

- https://docs.x.com/x-api/getting-started/pricing
- https://docs.x.com/x-api/getting-started/about-x-api
- https://www.wearefounders.uk/the-x-api-price-hike-a-blow-to-indie-hackers/
- https://postproxy.dev/blog/x-api-pricing-2026/
- https://devcommunity.x.com/t/what-are-the-limitations-for-the-filtered-stream-endpoint/269494
- https://docs.x.com/x-api/posts/filtered-stream/introduction
- https://twitterapi.io/pricing
- https://twitterapi.io/blog/twitter-monitoring
- https://twitterapi.io/blog/using-websocket-for-real-time-twitter-data
- https://twitterapi.io/blog/using-webhooks-for-real-time-twitter-data
- https://docs.twitterapi.io/api-reference/endpoint/add_webhook_rule
- https://socialdata.tools/
- https://docs.socialdata.tools/monitoring/pricing/
- https://docs.socialdata.tools/monitoring/introduction/
- https://apify.com/apidojo/tweet-scraper
- https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest
- https://apify.com/xquik/x-tweet-scraper
- https://use-apify.com/docs/what-is-apify/apify-free-plan
- https://scrapewise.ai/blogs/apify-pricing-compute-units-cost-2026
- https://techcrunch.com/2026/08/25/x-sends-cease-and-desist-to-open-source-project-nitter-over-alleged-scraping/
- https://github.com/zedeus/nitter/wiki/Instances
- https://en.wikipedia.org/wiki/Nitter
- https://help.rss.app/en/articles/11100642-guide-to-refresh-rate
- https://rss.app/en/pricing
