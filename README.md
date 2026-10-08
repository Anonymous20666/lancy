<div align="center">

# ✦ LANCY BOT ✦

**A premium, feminine Telegram control center for multi-account WhatsApp publishing.**

Deep Pinterest search · quality-obsessed sticker engine · AI caption assistant · clean, split-safe delivery

[![CI](https://github.com/Anonymous20666/lancy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Anonymous20666/lancy/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Telegram Bot API](https://img.shields.io/badge/Telegram%20Bot%20API-10.3-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![plogme](https://img.shields.io/badge/WhatsApp-plogme%202.0.7-25D366?logo=whatsapp&logoColor=white)](https://www.npmjs.com/package/plogme)
[![License: MIT](https://img.shields.io/badge/license-MIT-ff6b9d.svg)](LICENSE)

</div>

---

## ✨ Why Lancy

Lancy turns a Telegram chat into a polished production console: search Pinterest deeply, build sticker sets that respect every platform limit, and publish to any number of WhatsApp channels — while WhatsApp itself stays quiet and pristine. Every operation runs in bounded queues, every flow lives in an explicit state machine, and nothing ever spams: **one live progress message, edited in place.**

Telegram is the control center. WhatsApp is the output layer — it only ever receives packs, albums and captions.

## 🎀 Feature tour

| | Feature | What it actually does |
| --- | --- | --- |
| 🔍 | **Deep Pinterest search** | normalize → paginate → discover → resolve → validate (magic bytes, MIME, dimensions, decodability) → highest quality → dedupe → rank. Modes: Mixed / Images / Videos / Random · Depths: Quick / Deep / Very Deep |
| 🚫 | **Global no-duplicate system** | pin ID + canonical URLs + SHA-256 + perceptual hash (DCT pHash), per-user persistent history — the same content is never delivered twice |
| 🖼 | **HD media preservation** | content-addressed cache, quality scoring, exact + perceptual duplicate detection |
| ✦ | **Telegram sticker engine** | static (≤120/set) + video (≤50/set) with limits resolved dynamically; sets are created with **one** sticker and filled one-by-one — never one giant request |
| ✏️ | **Manual selection** | send images yourself, with partial-collection handling (7/10 → *Send more / Convert these / Cancel*) |
| 📱 | **WhatsApp pairing** | plogme pairing codes: session name → number normalization → code → wait for online; many isolated sessions, credentials in 0700/0600 storage |
| 📦 | **Clean pack splitting** | plogme enforces 60 stickers/pack — Lancy splits instead of bypassing: `61 → [60, 1]` · `100 → [60, 40]` · `150 → [60, 60, 30]` |
| 📡 | **Channel publishing** | discovery filtered to channels the paired account can publish to, permissions revalidated before every send, multi-select, POST-gated final preview |
| 💌 | **Caption engine** | `{{title}} {{query}} {{stickers}} {{packs}} {{creator}} {{date}} {{pack_name}} {{source}} {{telegram_link}} {{session_name}} {{cta}} {{footer}}` + a Default / AI / Edit / Custom step |
| 🤖 | **AI assistant** | separate worker thread, 10 styles (Girly, Soft, Cute, Elegant, Gen-Z, Gothic, Anime, Minimal, Premium, Chaotic), builtin / ollama / OpenAI-compatible providers with graceful fallback — never touches critical ops without confirmation |
| ⚙️ | **Settings, honestly** | 13 categories; safe values hot-reload live, dangerous ones trigger a controlled restart — never faked |
| 🧭 | **Explicit state machine** | 18 states, each with timeout / cancel / back / cleanup, persisted across restarts |
| ⏱ | **Queues everywhere** | concurrency limits, backoff retries, AbortSignal cancellation, backpressure — the Telegram handler never blocks |

## 🏗 Architecture

```
Telegram Bot API 10.3 (Rich Messages)           WhatsApp · plogme 2.0.7
┌────────────────────────────────┐              ┌─────────────────────────┐
│ TelegramController             │              │ WASession × N           │
│  ├─ 7 screens (Rich UI)        │   job        │  ├─ pairing codes       │
│  ├─ StateMachine (18 states)   │   queues     │  ├─ backoff reconnect   │
│  └─ ProgressTracker (1 msg)    │ ───────────► │  └─ isolated creds      │
└───────────────┬────────────────┘              └────────────┬────────────┘
                │                                            │
      ┌─────────▼─────────┐   ┌────────────────┐   ┌─────────▼──────────┐
      │ DeepSearch        │   │ MediaPipeline  │   │ ChannelService     │
      │ Pipeline          │──►│ validate →     │──►│ discovery +        │
      │ (dedupe · rank)   │   │ hash → cache   │   │ permission checks  │
      └───────────────────┘   └───────┬────────┘   └─────────┬──────────┘
                                      │                      │
                              ┌───────▼────────┐     ┌───────▼──────────┐
                              │ Sticker engine │     │ Publisher        │
                              │ (TG sets)      │     │ split ≤60 ·      │
                              └────────────────┘     │ retry · report   │
                                                     └──────────────────┘
              + AI worker thread (captions · chat · styles · fallback)
```

**Media pipeline (every item, no exceptions):**
`DOWNLOAD → VALIDATE → HASH → DEDUP → QUALITY → NORMALIZE → CACHE → CONVERT → TARGET VALIDATION → PUBLISH`

## 🚀 Quick start

```bash
git clone https://github.com/Anonymous20666/lancy.git
cd lancy
npm install
cp .env.example .env     # set BOT_TOKEN + OWNER_IDS
npm start                # or: npm run dev (auto-reload)
```

Open your bot in Telegram and send **/start**.

## ⚙️ Configuration

| Env | Purpose |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather) — **required** |
| `OWNER_IDS` | Comma-separated Telegram user IDs allowed to use the bot — **required** |
| `ADMIN_IDS` | Extra admin IDs (optional) |
| `DATA_DIR` | Database, sessions and cache location (default `./data`) |
| `FFMPEG_PATH` | ffmpeg binary for video; auto-detected otherwise (`ffmpeg-static` → `vendor/ffmpeg` → `PATH`) |
| `AI_PROVIDER` | `builtin` (offline, default) · `ollama` · `openai-compatible` |
| `PINTEREST_PROVIDER` | `web` (public search) · `fixture` (offline demo) |

Everything else lives in the in-bot **Settings** screen — 13 categories with honest hot reload: safe settings apply instantly, dangerous ones tell you a restart is required (and never pretend otherwise).

## 🗺 Core flows

**1 · Pair a WhatsApp account**
`WhatsApp → Pair` → name the session → send the phone number (normalized + validated, E.164) → Lancy displays the pairing code → connect the device → session comes online and is restored automatically on every boot.

**2 · Search → sticker set**
`Pinterest → Search` → send a query → one live progress message while Lancy paginates, validates, dedupes and ranks → pick results → choose a count (10–100 or custom) → About/Caption step → **Done**: a Telegram sticker set created with one initial sticker and filled one-by-one, live progress all the way.

**3 · Publish to WhatsApp channels**
`WhatsApp → session → Post Stickers` → multi-select packs → caption step → channel multi-select (only channels this account can publish to) → final preview (media, title, per-pack split, caption, destinations) → **POST** → job-queue publishing with one live progress message and a clean per-channel report.

## 🔒 Safety, privacy & legal

- Only **publicly accessible** Pinterest content — no bypassing private content, login walls, access controls or DRM.
- **No WhatsApp protocol exploits.** Physical pack limits are respected by splitting cleanly, never bypassed.
- WhatsApp credentials live in isolated 0700/0600 storage and **never** leave the machine — not to Telegram, not to logs, not to the AI, not to git.
- The AI can suggest, never act: no publishing, no security changes without your explicit confirmation.
- Stack traces stay in logs; Telegram only ever sees friendly, human-readable errors.

## 🧪 Testing & CI

```bash
npm test
```

**144 tests** across 16 files — unit, integration and a full end-to-end smoke test that boots the real app against a scripted mock Telegram API:

number normalization · pairing · reconnect · session isolation · dedup (SHA-256 + perceptual) · image/video conversion · TG sticker create/add · **WA splitting (the 10 / 30 / 50 / 60 / 61 / 100 / 120 / 150 matrix)** · caption variables · multi-channel selection · permission validation · retry · cancellation · timeout · hot reload · AI fallback · DB persistence · state machine · queues · Rich Message limits · the full `/start → search → settings → AI chat` flow.

CI runs the whole suite on every push and pull request — the badge at the top of this README is **live**.

## 📁 Project structure

```
src/
├── index.js            entrypoint (env guards, graceful shutdown)
├── app.js              composition root — wires every service
├── core/               db (node:sqlite) · state machine · queues · bus · errors · logger
├── config/             defaults (13 categories) · settings (hot reload) · env
├── utils/              phone · text · hash · phash · retry · paths · time
├── telegram/           Bot API 10.3 client · Rich builder · controller · 7 screens
├── media/              validate · convert · cache · dedup · pipeline
├── pinterest/          provider interface · web provider · deep search · fixtures
├── whatsapp/           sessions (plogme) · manager · channels · publisher · split
├── stickers/           emoji · limits · telegram sticker service · pack service
├── captions/           template engine + built-ins + store
└── ai/                 worker thread + providers (builtin / ollama / openai) + service
```

## 🧰 Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | **Node.js ≥ 22.5** (ESM) | `node:sqlite` + `node:test` built in — zero native DB drivers |
| Telegram | **custom fetch client** | exact Bot API 10.3 `sendRichMessage` / sticker methods, no library lag |
| WhatsApp | **plogme ^2.0.7** | current Baileys-based library, APIs verified against installed source |
| Images | **sharp ^0.34** | fast conversion + raw pixels for the DCT perceptual hash |
| Video | **ffmpeg** (optional) | auto-detected from `FFMPEG_PATH` → `ffmpeg-static` → `vendor/ffmpeg` → `PATH` |
| Logging | **pino ^9** | structured logs, separate error stream |

## 📄 License

[MIT](LICENSE) — Copyright © 2026 Anonymous20666

<div align="center">

*made with love ♡*

</div>
