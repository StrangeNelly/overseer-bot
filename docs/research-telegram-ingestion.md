# Reading Telegram group messages for Groupie (verified 1 Sep 2026)

Current Bot API version: **10.3, released 24 Aug 2026** (core.telegram.org/bots/api). All facts below were checked against live official docs unless marked otherwise.

## (a) Bot API bot added to the group

### Privacy mode — what the bot can see
From the official Bots FAQ and Features pages (core.telegram.org/bots/faq, /bots/features):
- **Privacy mode ON (default):** the bot receives only: commands explicitly addressed to it (`/command@this_bot`), general commands (e.g. `/start`) if it was the last bot to post in the group, inline messages sent via the bot, and replies to its own messages. Also all service messages and everything in private chats regardless of mode. Note: "Each particular message can only be available to one privacy-enabled bot at a time" — relevant since the group already runs Rick and Phanes.
- **Privacy mode OFF, or bot is admin:** "Bot admins and bots with privacy mode disabled will receive all messages **except messages sent by other bots**." Toggling privacy via BotFather (/setprivacy) requires re-adding the bot to the group to take effect. Making the bot a (rights-less) admin always grants full visibility.
- **CRITICAL LIMITATION for Groupie:** even as admin, a Bot API bot **never receives other bots' messages**. Rick/Phanes replies (the "SLUICE @ 128.9K ... 12.8x" updates that contain call-time market cap) are invisible to a Bot API bot. Groupie's bot would see the humans' messages (contract addresses, /groupie commands) but not the bot-generated call cards. Groupie can still work by extracting the raw contract address from the human message and fetching market data itself, but it cannot piggyback on Rick's parsed output via the Bot API.
- **Guest mode (new, Bot API 10.0, 8 May 2026):** a bot mentioned by username can receive that one message and issue one reply without joining the group (`SentGuestMessage`, `answerGuestQuery`); it explicitly "does not grant access to a chat's message history or participant list" — not useful for Groupie's firehose ingestion, but shows Telegram is actively evolving group-bot access.

### History before joining
- The Bot API has **no history method at all** — nothing like getHistory exists in the API reference; this is confirmed repeatedly by maintainers of pyTelegramBotAPI/python-telegram-bot/node-telegram-bot-api in issue threads. A bot only sees messages from the moment it's in the group (and correctly configured) onward. **Groupie's board starts empty on day 0** unless you backfill once with a userbot session or a Telegram Desktop chat export (JSON export is a practical one-time backfill path).
- Update queue: "Incoming updates are stored on the server until the bot receives them either way, but they will not be kept longer than **24 hours**" — so if your ingester is down for less than a day, getUpdates catches up; longer outages lose messages.

### getUpdates vs webhooks
- Two mutually exclusive modes: long polling (getUpdates) or webhooks; "it's not possible to get updates via long polling while an outgoing Webhook is set."
- **getUpdates:** batches of 1–100 updates, `allowed_updates` filter (default excludes `chat_member`, `message_reaction`, `message_reaction_count` — request `chat_member` explicitly if you want join/leave tracking). No public HTTPS endpoint needed — ideal for a solo dev on a Windows box or cheap VPS.
- **Webhooks:** HTTPS URL on ports 443/80/88/8443, valid SSL cert, `max_connections` 1–100 (default 40), and a `secret_token` (1–256 chars) echoed in the `X-Telegram-Bot-Api-Secret-Token` header so you can authenticate Telegram's calls.
- For Groupie v1 (one group, read-mostly), **long polling is the pragmatic choice**; webhooks matter later at multi-group SaaS scale.

### Rate limits (these are SEND limits; receiving updates is not the bottleneck)
Official numbers (Bots FAQ): max ~1 message/second per chat, **20 messages/minute per group**, ~30 messages/second global broadcast cap. Paid Broadcasts (BotFather opt-in, since Bot API 7.11) raises broadcast to 1,000 msg/s at **0.1 Telegram Stars per message above the free 30/s** — irrelevant for a read-only dashboard. Third-party monitoring (pipsync.io blog, 2026) claims enforcement has tightened since 2025 with more 429s — plausible but secondary-source; treat as a reason to build retry/backoff. Since Groupie mostly listens and only replies to /groupie commands, limits are a non-issue in v1.

### Commands and multi-group serving
- In groups, commands arrive as `/groupie` or `/groupie@GroupieBot`; commands addressed to the bot are delivered **even with privacy mode on**. Official docs warn: updates "will not contain any information about the scope of a command" and "may contain commands that don't exist at all in your bot. Your backend should always verify that received commands are valid" — so parse `/groupie addlaunchmonitor @project51` defensively.
- **One bot, many groups is the standard model:** every update carries `chat.id`; key all storage by chat id from day one and the same bot token scales to the multi-group SaaS phase with zero Telegram-side changes (groups toggle joinability via BotFather /setjoingroups; default is joinable).

## (b) MTProto user-account session ("userbot": Telethon / GramJS)

### What it adds over a Bot API bot
- Sees **everything a human member sees**: all messages including **other bots' messages** (Rick/Phanes call cards), full **message history from before it joined** (messages.getHistory), edits/deletes, member list (subject to newer anti-scrape restrictions), reactions — no privacy-mode concept.
- This directly solves both Bot API gaps: historical backfill and reading Rick's market-cap-at-call posts.

### ToS position and ban risk
- Obtaining api_id/api_hash at my.telegram.org is free: "We welcome all developers to use our API ... free of charge." But: "All accounts that log in using unofficial Telegram API clients are **automatically put under observation** to avoid violations of the Terms of Service," and "If you use the Telegram API for flooding, spamming, faking subscriber and view counters of channels, you will be **banned forever**" (core.telegram.org/api/obtaining_api_id).
- The API Terms (core.telegram.org/api/terms) don't explicitly ban read-only userbots; they ban spam-adjacent behavior, acting "on behalf of the user without the user's knowledge and consent," ghost-mode tricks, and (notably, added recently) using Telegram data to train AI models.
- Telethon's own FAQ (docs.telethon.dev): any third-party library "is prone to cause accounts to appear banned"; risk factors are fresh accounts, VoIP/virtual numbers, numbers from high-spam countries (Iran/Russia), and rapid request bursts. Advice: use a **well-established account**, keep request rates human-like. Community consensus: with a bot account "the risk of a ban is either zero or very close to it"; a passive read-only userbot in one group is comparatively low-risk but never zero, and appeal (recover@telegram.org) is slow/uncertain.
- Practical stance: a userbot that only *reads* one private group it legitimately belongs to is the mildest possible use, but it ties Groupie to a real phone number and session file that can be flagged — a bad foundation for a multi-group SaaS (customers won't add your personal account; they'll add a bot).

## Verifying that a web visitor is a member of the group

- **Login Widget — MAJOR 2026 CHANGE:** core.telegram.org/widgets/login now documents a **new OpenID Connect flow** (Authorization Code + PKCE; JWT ID tokens signed RS256/ES256/EdDSA/ES256K; JWKS endpoint; issuer `https://oauth.telegram.org`; audience = your bot's Client ID; Client ID/Secret and Allowed URLs configured in BotFather's "Login Widget" section). The legacy iframe widget with `hash = HMAC-SHA256(data_check_string, SHA256(bot_token))` is explicitly archived at /widgets/login-legacy — still documented, but new builds should use OIDC (any OIDC library / Auth0 / Keycloak works). UNCERTAIN: whether/when the legacy widget will be switched off — no sunset date found.
- **Mini App initData** (core.telegram.org/bots/webapps): unchanged and current — server-side validate with `secret_key = HMAC_SHA256(bot_token, "WebAppData")`, data-check-string = all fields except hash, sorted alphabetically, joined by \n, then `hex(HMAC_SHA256(data_check_string, secret_key)) == hash`; check `auth_date` freshness. initData includes `user.id`, `auth_date`, `hash`, plus a newer `signature` field (Ed25519) letting third parties validate without the bot token. A Mini App gives you the visitor's Telegram user id for free if Groupie is (also) surfaced as a Mini App.
- **getChatMember** completes the loop: after Login Widget/Mini App yields a trusted user id, call `getChatMember(chat_id, user_id)`; status `creator`/`administrator`/`member`/`restricted` = in the group; `left`/`kicked` = not. Per current docs (mirrored at gramio.dev and aiogram docs), the method "is only guaranteed to work for other users if the bot is an administrator in the chat" — one more reason to run the Groupie bot as admin. (The Bot API cannot enumerate the full member list; per-user lookup is the pattern.)
- Recommended gate: OIDC login (or Mini App initData) → verified user id → getChatMember against the group's chat id → issue your own session cookie/JWT. Free, no passwords, and generalizes per-group for the SaaS phase.

## Frameworks (health as of Sep 2026)
- **grammY (TypeScript/Node/Deno): healthiest JS option.** Latest v1.46.0 implements Bot API 10.3 within days of its release. Rich plugin ecosystem (incl. a chat-members plugin), excellent docs.
- **Telegraf (Node): effectively stagnant** — last release v4.16.3 on 29 Feb 2024, supporting only Bot API 7.1 (~9 API versions behind); v5 has been "upcoming" for years. Avoid for new projects.
- **python-telegram-bot: healthy** — v22.8 (docs dated 4 Aug 2026), Bot API 10.0 supported natively.
- **aiogram (Python, async-only since v3): healthy** — docs at 3.29.0, fast Bot API tracking, popular for high-throughput bots.
- Userbot libraries: Telethon (v2 in long alpha; stable v1 maintained) for Python; GramJS for JS. Use only for the optional one-time backfill / Rick-message reading, isolated from the main bot.

## Costs — confirmed
- Bot API: **free** ("bots are able to message their users at no cost"), including getUpdates, webhooks, getChatMember, unlimited groups. No paid tier exists for *receiving* messages.
- The only paid Telegram bot mechanism found: **Paid Broadcasts** (0.1 Stars/msg beyond 30 msg/s broadcast) — opt-in, send-side only, irrelevant to Groupie.
- MTProto api_id/api_hash: **free**.
- OIDC login / Mini Apps / initData validation: free.
- (Optional) self-hosted Bot API server is open source and free if you ever need bigger file downloads.

## Bottom-line recommendation

Build Groupie on a Bot API bot added to the group as a rights-less admin (guarantees it sees all human messages regardless of privacy mode, and makes getChatMember reliable), consuming updates via getUpdates long polling in v1 — free, ToS-safe, and the same bot token scales to multi-group SaaS since every update carries chat.id. Accept two hard Bot API limits and design around them: (1) no history before joining — backfill once via a Telegram Desktop JSON export or a short-lived Telethon session on the dev's own established account; (2) bots never see other bots' messages, so Groupie cannot read Rick/Phanes call cards — instead extract contract addresses from members' own messages and compute call-time market cap from your own market-data feed (which you need anyway for live prices). Keep a persistent userbot out of the product: it is the only way to read Rick's messages and old history, but it rides on a real phone number under automatic observation with nonzero ban risk and cannot be onboarded by future customer groups. Gate the web dashboard with the new (2026) Telegram OIDC login flow (or Mini App initData validation if you ship it as a Mini App) to get a verified Telegram user id, then authorize with getChatMember status in (creator, administrator, member, restricted). Framework: grammY if you build in TypeScript (tracks Bot API 10.3; avoid the stagnant Telegraf), aiogram or python-telegram-bot if Python. Total Telegram-side cost: $0 — the only paid mechanism (Paid Broadcasts, 0.1 Stars/msg above 30/s) does not apply to a read-only dashboard.

## Open questions for the owner

- Do the group's calls always include the raw contract address in a human member's message, or are some calls only visible in Rick/Phanes bot replies? (If the latter, Groupie needs the userbot compromise or must ask members to always paste the CA.)
- Is the group's owner willing to add Groupie's bot as an admin (even with no rights), and is having another bot in the group acceptable to members?
- How much history should the launch version show — is a one-time backfill (Desktop export or brief Telethon run on your own account) wanted, or is starting the board from day 0 acceptable?
- Will Groupie's web app be a plain website (use the new OIDC login flow) or a Telegram Mini App (use initData validation) — or both?
- For the future SaaS phase: are customer groups expected to self-serve add the bot and run /setup, and do you want membership-gated dashboards per group from day one (affects schema keying by chat_id now)?
- TypeScript or Python for the backend? (Determines grammY vs aiogram/python-telegram-bot.)

## Sources consulted

- https://core.telegram.org/bots/faq
- https://core.telegram.org/bots/features
- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/api-changelog
- https://core.telegram.org/widgets/login
- https://core.telegram.org/bots/webapps
- https://core.telegram.org/api/obtaining_api_id
- https://core.telegram.org/api/terms
- https://docs.telethon.dev/en/stable/quick-references/faq.html
- https://grammy.dev/resources/comparison
- https://github.com/telegraf/telegraf/releases
- https://github.com/grammyjs/grammY/releases
- https://pypi.org/project/python-telegram-bot/
- https://docs.aiogram.dev/en/latest/api/methods/get_chat_member.html
- https://gramio.dev/telegram/methods/getchatmember
- https://github.com/python-telegram-bot/python-telegram-bot/discussions/2977
- https://github.com/eternnoir/pyTelegramBotAPI/issues/639
- https://pipsync.io/en/blog/telegram-rate-limits
- https://kulikovd.medium.com/how-to-add-telegram-login-to-the-website-with-new-oidc-flow-4a1bb8ad03c4
