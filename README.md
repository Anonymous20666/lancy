# ✦ LANCY BOT ✦

A polished, girly Telegram control center connected to **multiple WhatsApp
accounts** (via [plogme](https://www.npmjs.com/package/plogme), the current
Baileys-based library). Telegram is the control center; WhatsApp is the
output layer — it only ever receives packs, albums and captions.

```
Telegram (Rich Messages control center)
   │
   ├─ Deep Pinterest search ──► validated, deduped, ranked media
   │
   ├─ Sticker engine ────────► Telegram sticker sets (static + video)
   │
   ├─ WhatsApp pairing ──────► pairing codes, many isolated sessions
   │
   ├─ WA publishing ─────────► sticker packs → channels (split cleanly ≤ 60)
   │
   ├─ AI assistant ──────────► captions, titles, chat (separate worker)
   └─ Settings ──────────────► 13 categories, honest hot reload
```

## Features

- **/start dashboard** with live stats, built with Telegram Bot API 10.3
  **Rich Messages** (blocks, tables, buttons — not inline keyboards).
- **Deep Pinterest search** — normalize → paginate → discover → resolve →
  validate (magic bytes, MIME, dimensions, decodability) → highest quality →
  dedupe → rank. Modes: Mixed / Images / Videos / Random. Depths: Quick /
  Deep / Very Deep.
- **Global no-duplicate system** — pin ID, canonical URLs, SHA-256,
  perceptual hash (DCT pHash), per-user persistent history. The same content
  is never shown twice to the same user, and never twice inside one search.
- **HD media preservation** — content-addressed cache, quality scoring,
  exact-byte and perceptual duplicate detection.
- **Telegram sticker creation** — static + video sets, dynamic API limits
  (static ≤ 120, video/animated ≤ 50), created with one initial sticker and
  filled one-by-one. Never all in one request.
- **Pinterest → Sticker flow** — count picker (10–100 + custom), one live
  progress message, zero spam.
- **Manual image selection** with partial-collection handling
  (7/10 → Send more / Convert these / Cancel).
- **WhatsApp pairing** via plogme pairing codes — session name → number
  normalization/validation → code display → wait for online.
- **Many isolated WA sessions** with a manager dashboard, secure per-session
  credential storage (never in Telegram, logs, AI or git).
- **WA sticker posting** — multi-pack selection, **clean pack splitting**
  (plogme enforces a hard 60-sticker limit; we split, never bypass:
  61 → [60, 1], 100 → [60, 40], 150 → [60, 60, 30]).
- **Template caption engine** — `{{title}} {{query}} {{stickers}} {{packs}}
  {{creator}} {{date}} {{pack_name}} {{source}} {{telegram_link}}
  {{session_name}} {{cta}} {{footer}}` + About/Caption step
  (Default / AI / Edit / Custom).
- **AI assistant in a separate worker thread** — caption generation, rewrite,
  10 styles (Girly, Soft, Cute, Elegant, Gen-Z, Gothic, Anime, Minimal,
  Premium, Chaotic), chatable. Falls back to a builtin provider when the
  configured one is unavailable. **Never** controls critical operations
  without confirmation.
- **WA channel discovery** — only channels the paired account can publish to,
  multi-select, permissions revalidated before every publish.
- **Final publish preview** — media, title, counts, per-pack split, caption,
  destinations, session — with a POST gate.
- **Job-queue publishing** — one live progress message, clean final report,
  per-channel retry, human-readable errors (stack traces stay in the logs).
- **Settings** — 13 categories (General, Telegram, WhatsApp, Pinterest,
  Stickers, Captions, AI, Media, Performance, Storage, Security, Logging,
  Advanced). Safe settings hot-reload live; dangerous ones honestly trigger
  a controlled restart — never faked.
- **Explicit state machine** — 18 states, each with timeout, cancel, back and
  cleanup, persisted so a restart never leaves you stuck.
- **Queues everywhere** — concurrency limits, backoff retries, AbortSignal
  cancellation and backpressure. The Telegram handler never blocks.

## Design rules

Elegant headers, dividers, cards, pagination, progressive disclosure, tasteful
emojis. Text is never shrunk; screens split instead. One live progress message
is edited — never duplicated. **No regressions**: every feature preserves the
buttons and metadata of the ones before it.

## Legal & safety

- Only publicly accessible Pinterest content. No bypassing private content,
  login walls, access controls or DRM.
- No WhatsApp protocol exploits. Physical pack limits are respected by
  splitting cleanly.
- WhatsApp credentials are stored isolated (0700 dirs / 0600 files) and never
  leave the machine — not to Telegram, logs, the AI or git.
- The AI cannot publish anything or change security settings without your
  explicit confirmation.

## Quick start

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN and OWNER_IDS
npm start              # or: npm run dev (auto-reload)
```

Open your bot in Telegram and send `/start`.

### Configuration

Everything is in `.env` (see `.env.example`) and editable live in
**Settings** — 13 categories with honest hot reload.

| Env | Purpose |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token from @BotFather (required) |
| `OWNER_IDS` | Comma-separated allowed Telegram user IDs (required) |
| `ADMIN_IDS` | Extra admin IDs (optional) |
| `DATA_DIR` | Where the database, sessions and cache live (default `./data`) |
| `FFMPEG_PATH` | ffmpeg binary for video; auto-detected otherwise |
| `AI_PROVIDER` | `builtin` (offline, default) / `ollama` / `openai-compatible` |
| `PINTEREST_PROVIDER` | `web` (public search) / `fixture` (offline demo) |

## Development

```bash
npm test          # 144 tests: unit + integration + end-to-end smoke
```

The suite covers: number normalization, pairing, reconnect, session
isolation, dedup (SHA-256 + perceptual), image/video conversion, TG sticker
create/add, **WA splitting (the 10/30/50/60/61/100/120/150 matrix)**, caption
variables, multi-channel selection, permission validation, retry,
cancellation, timeout, hot reload, AI fallback, DB persistence, the state
machine, the queues, Rich Message limits — plus a full end-to-end smoke test
that boots the real app against a scripted mock Telegram API.

### Layout

```
src/
  index.js          entrypoint (env guards, graceful shutdown)
  app.js            composition root — wires every service
  core/             db (node:sqlite), state machine, queues, bus, errors, logger
  config/           defaults (13 categories), settings manager (hot reload), env
  utils/            phone, text, hash, phash, retry, paths, time
  telegram/         Bot API 10.3 client, Rich builder, controller, screens
  media/            validate, convert, cache, dedup, pipeline
  pinterest/        provider interface, web provider, deep search, fixtures
  whatsapp/         sessions (plogme), manager, channels, publisher, split
  stickers/         emoji, limits, telegram sticker service, pack service
  captions/         template engine + built-ins + store
  ai/               worker thread + providers (builtin/ollama/openai) + service
```

## Stack

- **Node.js ≥ 22.5** (ESM, `node:sqlite`, `node:test`)
- **plogme ^2.0.7** — WhatsApp (verified against the installed source)
- **sharp ^0.34** — image conversion, pHash pixels
- **pino ^9** — structured logging
- **ffmpeg** (optional) — video processing; auto-detected from
  `FFMPEG_PATH` → `ffmpeg-static` → `vendor/ffmpeg` → `PATH`

## License

MIT
