# Lancy music v2 — setup, operations, and release gate

## Channel administrators: private control and track replies

See [channel verification and rollout boundary](MUSIC_CHANNEL_VERIFICATION.md). Source changes are not deployed automatically.

1. Start the channel live stream yourself. Add both the bot and an approved playback account with the necessary administrator/speaking rights. Lancy will not create a call, join membership or promote an account automatically.
2. The main owner approves a registered account for that exact destination using the existing private `/accounts` controls. Channel administrators cannot manage the encrypted pool.
3. The channel administrator sends `/channel @channelname` in their own bot DM. The verified administrator's dashboard is pinned there; it is not posted to the channel.
4. Reply to that dashboard with a title and artist (or tap **Add tracks** and answer its prompt). Select exact recordings, then **Add selected**. Old panels and searches retain their original channel even after a different DM binding is selected. Multiple verified admins share playback/queue but have separate private views.
5. `/play` remains standalone listen/download; it does not silently add to VC. Actual stream and download permissions, provider enablement and cache/file limits remain enforced.
6. If Telegram mutes the publisher, allow it to speak and stop/retry playback. Lancy does not override a locked moderator mute or discard the queue merely because publisher verification failed.
7. `/channel close` closes only that administrator's view; it does not stop the shared queue. Use explicit Stop/Leave controls for shared playback.

Group VC controls and queue changes require administrators. Public listen/download commands remain available under the existing access policy. Native command suggestions separate public and administrator scopes, with custom-prefix descriptions for scoped chats. Private channel music access does not open unrelated AI or owner account/session management, and retains the existing ForceJoin gate.

See [MUSIC_ENGINEERING.md](MUSIC_ENGINEERING.md) for the audit, numbered requirements and architecture. This feature branch is staged separately from the running VPS checkout. It does **not** include the unrelated changes that were already uncommitted on that VPS. Do not replace the running checkout with this branch without reviewing those differences.

## Runtime and installation

- Node.js >=22.5, npm dependencies from the existing `package-lock.json`. No unrelated Node dependencies were upgraded.
- Python >=3.10; inspected production is Python 3.12.3. Use a **clean** venv: importing `pyrogram` must resolve the pinned `pyrogrammod` distribution, not an overlapping Pyrogram installation.
- System `ffmpeg` and `ffprobe`, with AAC, libmp3lame and libx264 encoders. `FFMPEG_PATH` overrides the FFmpeg executable; `ffprobe` must still be on PATH.
- Exact inspected versions are in `service/voice/requirements.txt`: py-tgcalls 3.0.0, ntgcalls 3.0.4, pyrogrammod 2.4.1, aiohttp 3.14.5, python-dotenv 1.2.4, TgCrypto 1.2.5. All six installed versions were confirmed, without exposing credentials.

```sh
# In a separate reviewed checkout, never over the dirty production working tree:
npm ci
python3 -m venv service/voice/.venv
service/voice/.venv/bin/python3 -m pip install -r service/voice/requirements.txt
node --version
ffmpeg -version
ffprobe -version
```

Keep the existing private `.env` and service manager configuration protected. See `docs/MUSIC_ENV.example` for names only; it contains no usable credentials. Do not commit `.env`, session files, the database, secrets, logs or a venv. Start from the repository root (`node src/index.js`); bridge paths deliberately follow that working directory. The application starts its authenticated bridge lazily when music accounts are needed. Do not start a competing standalone bridge.

### Configuration

Existing names: `BOT_TOKEN`, `OWNER_IDS`, `DATA_DIR`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `FFMPEG_PATH`. A bot token cannot play in a call without an authorized **user-account** session.

| Name / setting | Default | Meaning |
|---|---:|---|
| `MUSIC_IDLE_SECONDS` | 600 | Overrides `music.idleLeaveSeconds`; positive 1–86400 seconds |
| `MUSIC_YTDLP_ENABLED` | false | Owner opt-in to an existing `yt-dlp` executable; equivalent enablement also available through `music.allowYtDlp` |
| `MUSIC_LYRICS_FULL_TEXT` | false | Player full-text pagination only when operator has appropriate display rights; otherwise an excerpt |
| `VOICE_BRIDGE_HOST` | 127.0.0.1 | Loopback only; public binding is rejected |
| `VOICE_BRIDGE_PORT` | 3056 | Private local sidecar port; no firewall exposure required |
| `VOICE_BRIDGE_TOKEN` | random per Node process | Optional protected 32+ character token for deliberate reattachment; never send it in chat |
| `MUSIC_SESSION_KEY` | generated locally | Optional 64-hex-character AES-256 key; otherwise `DATA_DIR/secrets/music-session.key`, mode 600 |
| `music.maxCacheMiB` | 512 | Shared music cache quota; downloads serialized and space reserved for source/output work |
| `music.maxFileMiB` | 48 | Maximum source/output file size; at most 150 MiB, and quota must cover at least three files |
| `music.cacheTtlMinutes` | 1440 | Unreferenced media TTL |

`music.*` values are settings in Lancy's existing settings store, not invented environment variables. These music configuration changes require a controlled application restart; they are not advertised as live hot-reload. Existing media/other feature settings are unchanged. Preserve the generated key separately from database backups: losing it prevents decrypting stored sessions. A supplied environment key must remain stable between restarts.

## Secure account onboarding

1. The owner uses their own legitimately controlled Telegram user account, with permission to operate it in the destination. Obtain API credentials through Telegram's official account tooling.
2. On a trusted interactive terminal in the checkout, run:
   ```sh
   service/voice/.venv/bin/python3 service/voice/generate_session.py player_one
   ```
   The helper prompts privately; it never prints a session, login code, API hash or password. It writes an exclusively created mode-600 file under `DATA_DIR/music-inbox/`. Do not run this over chat or paste credentials into a bot.
3. In the **main bot owner's private Telegram chat**:
   ```text
   /accounts register player_one
   /accounts allow player_one <negative-group-or-channel-id>
   /accounts health
   ```
4. The registered session is encrypted in the existing settings database; the staging file is removed after successful persistence. A failed persistence attempts to unregister the transient backend account and retains the protected staging file for operator recovery.
5. Other owner-private actions:
   ```text
   /accounts list
   /accounts enable player_one
   /accounts disable player_one
   /accounts deny player_one <negative-id>
   /accounts remove player_one
   ```

Aliases are lowercase letters/numbers/underscore/hyphen, 1–24 characters. Maximum eight accounts. Busy accounts cannot be disabled, removed or reconfigured. One account leases one call destination at a time; it is not silently stolen by another group. Explicit health checks call `get_me` for idle enabled accounts, with bounded timeouts. Active leases report busy, not an invented independent health result. Group administrators and cloned-bot owners cannot manage the global pool.

An existing `TELEGRAM_STRING_SESSION` is migrated once as alias `legacy` with **no approved destinations**. The owner must explicitly allow the test destination. Removing that alias does not silently reimport the environment session. Old Telegram OTP/password states reset and redirect to terminal setup. No automatic credential replacement takes place.

## Permissions and destinations

- The bot must be able to receive commands, send/edit its own messages and send audio files. Pinning requires the bot's pin permission and the caller to be an authorized administrator/owner.
- The playback user account must already belong to the destination and be permitted to speak/stream. The bridge never joins a Telegram group or promotes an account automatically.
- Start the group call/channel live stream first. `auto_start=False` is deliberate. A broadcast channel may require administrator/speaker rights. Merely giving the **bot** administrator rights is insufficient for the **user account**.
- Fresh string sessions lack peer/access-hash caches. On a cache miss, the bridge searches at most 500 existing account dialogs within a bounded timeout; it does not autojoin a destination. A dedicated account with too many dialogs may need operator attention.
- Members may select/add tracks; destructive controls (pause/resume/skip/previous/seek/volume/stop/leave/remove/clear/shuffle/repeat/bass/account selection) require verified group administrator or main-owner authority. Permission lookup failure denies the operation.
- Channel control is main-owner-private: `/destination <negative-channel-id>`, then `/addq`, `/vplay`, `/player`. The binding is scoped to owner and bot. Its account still needs the destination allowlist and channel rights. Another bot/chat cannot take over an existing destination's dashboard.

## User workflows

- `/play <title artist>` or `/music <query>`: canonical search, one selected recording, then **download**. It never automatically queues or joins a call. Replying `/play` to audio/video retains the existing recognition entry, with recognized queries routed into canonical selection.
- `/addq <title artist>`: five results per page, up to 20 selected recordings across pages; one batch goes to the search's fixed, displayed destination. Duplicate submissions and stale revisions are rejected.
- `/vplay <query>`: requests a real video+audio call stream. A provider that cannot supply both streams fails explicitly; sending a video file is not used as a substitute.
- `audius: <query>` and, when opted in, `youtube: <query-or-exact-url>` select a provider. A selected provider reference is immutable; the engine does not search a different recording when resolution fails.
- `/lyrics <title artist>`: select the canonical recording, then strict matched lyrics without joining a call or downloading media. `/lyrics` without text uses the current track when available, otherwise prompts for a recording. Standalone display is an excerpt; player full text remains opt-in.
- `/player`: one destination dashboard. Player, queue, lyrics, volume and accounts replace its content rather than generating a new status message for every poll. Deleted/uneditable dashboard recovery is not automatically proven; see limitations.
- `/pause`, `/resume`, `/skip` (`/next`), `/previous`, `/queue` (`/q`), `/shuffle`, `/loop` (`/repeat`), `/seek <absolute-seconds>`, `/volume <0–150>`, `/stop`, `/leave`. `/volume` without a value opens presets. Queue entries have stable IDs; removal targets an entry rather than a shifting row index.
- `/stop` clears playback and stays connected idle; ten minutes later it leaves the **call**, never the group. `/leave` exits immediately. Paused playback is not idle. New queue work invalidates an old idle timer under the destination lock.
- `/playlist list`, `/playlist save <name>`, `/playlist load <name>`, `/playlist remove <name>` use the existing database. Names exclude reserved prototype properties. Restart does not resume live playback automatically.
- Group general AI is off: names, tags and casual replies do not invoke the LLM. Plain `play <query>` replying to **this bot's** message goes directly to canonical download search, before stale interaction states. Replies to another bot/person do not trigger it. DM AI remains available, serialized per user, with actual history and honest tool errors.

## Source quality, matching and rights

Audius stream permission is separate from file-download permission. Gated/unavailable recordings are not treated as freely downloadable. YouTube is disabled by default; opt-in is only for material the owner has permission to use, without imported cookies or access-control bypass. No provider can guarantee arbitrary commercial songs are available. Keep the optional `yt-dlp` tool updated separately under your normal operational policy; this change does not install it silently.

Audio is prepared as 48 kHz stereo when supported. That is a sample format, **not** a promised Telegram bitrate or recovered source quality. Neutral audio is default. Gentle bass adds headroom, a modest 100 Hz boost and a limiter on the **next** track; no DJ mix, beatmatching or crossfade is claimed. Video is bounded to modest resolution/frame rate. The installed-library probe actually decodes generated fixtures with and without bass, plus video and seek offset, but cannot prove Telegram synchronization or listener quality.

Lyrics require normalized exact title/artist agreement, compatible duration when available, and an unambiguous candidate. No arbitrary first result is substituted. LRCLIB requests are serialized with a cooldown and Retry-After handling. No exact lyrics, album art or durations are invented when absent.

## Recovery and operational limits

- Queue: 100 upcoming entries per destination, 25 history entries; 1,000 in-memory destination records with inactive eviction. Very old inactive dashboard callbacks can expire after eviction. Search: bounded sessions/pages/selections and expiring opaque callbacks. Lyrics cache: 200 records. Files are checked with ffprobe and incomplete outputs are rejected.
- Cache references protect playing/sending media. Local path containment and public-address/redirect validation keep arbitrary remote input away from FFmpeg. The media cache is bounded and partial files are cleaned. Download/transcode operations have time/size limits; shutdown may wait for a bounded in-flight transcode rather than abruptly corrupting it.
- Native media time drives progress. Missing clock data displays unknown progress, not a wall-clock estimate. A failed volume confirmation is labelled unconfirmed and reconciled from a later backend value; it does not silently skip a successfully started track.
- A stalled stream/clock outage gets at most two backend restart attempts from its last real position, with backoff. An uncertain call retains its account lease. Terminal source failure advances without relooping the broken recording. Other destinations retain their own locks and queues.
- The bridge watches parent death and attempts cleanup. Graceful shutdown cancels timers, closes queues, leaves calls and stops user clients. Stop/start is **not** seamless nonstop playback: queues and active positions are ephemeral, no durable playback checkpoint is implemented.
- A process manager and monitoring are still required. Multi-day reliability, automatic supervisor restart behavior, provider long-run failure rates and real listener quality are **not certified** by these offline tests.

## Full-song listening and quiet UI

`/play` never auto-joins a VC. Its selected recording is delivered through the same rich full-audio component as the existing downloader, replacing the search card in place. Tap the native Telegram audio to listen, or use its audio menu to save the MP3. “Search for VC” is a separate action requiring a group or an owner-bound destination; it does not guess a group from private chat.

The live `/player` dashboard also exposes full downloadable audio where the canonical source permits it. Its native audio widget is **not synchronized to the voice call**: the VC progress bar/volume/transport controls operate the shared call, while Telegram's player operates the listener's local playback. Unsupported or creator-restricted full-file preview is labelled honestly; the authorized VC stream continues. More → Retry full preview is available after temporary preparation failures.

Routine views and settings edit the current dashboard. Bot input prompts are scoped to the requester (including group selective ForceReply mentions), expire after two minutes, and are cleaned on completion/cancel. Unsubmitted search cards expire after ten minutes; completed VC selection cards are deleted. `/play` audio cards and matched-lyrics results remain as useful deliverables. Transient error notices expire after one minute. Cleanup retains active submissions until their result is known, deletes only API-recorded bot message IDs, retries transient deletion failures at most twice, and respects flood waits. Deletion cannot be guaranteed when Telegram/network permissions prevent it; no user-message deletion or retroactive production-history sweep is performed by this routine cleanup.

Full-preview jobs are capped at two globally, single-flight per destination; explicit full-song deliveries have two concurrent fail-fast slots. Telegram file-ID cache: at most 100 bot/recording entries, six-hour TTL. Audio uploads for the same bot and recording are serialized/deduplicated. Audius download permission is checked even for cached media; complete audio-only VC files can then be reused without downloading/transcoding again. A video asset is never sent with a false MP3 label. Retain conservative file/cache limits (48 MiB/512 MiB defaults); native uploads and multipart buffers consume memory in addition to the disk cache.

## Verification commands

```sh
node --test --test-timeout=20000 tests/musicEngineering.test.js tests/voiceChatAndMusicSystem.test.js tests/assistantSessionAuth.test.js tests/aiAssistantAndScheduler.test.js tests/aiAndSpotifyEnrichment.test.js tests/groupAndDmInteraction.test.js tests/conversationalAiAndClonedTriggers.test.js tests/musicPreviewUi.test.js tests/musicIntentAndLinkPreview.test.js tests/musicPlayLyricsAndRecognition.test.js
python3 -m unittest discover -s service/voice/tests -v
service/voice/.venv/bin/python3 service/voice/tests/native_contract_probe.py
node --test --test-timeout=45000 tests/*.test.js
```

The native probe generates its own two-second media and runs installed MediaStream preparation plus the generated FFmpeg commands. It does **not** authorize a Telegram account, join a call or send a message. Unit-test fakes do not establish transport success.

## Controlled rollout / rollback gate

1. Review the feature diff against upstream and reconcile, rather than overwrite, the unrelated production edits. Back up SQLite using its online backup mechanism and back up the encryption key separately; preserve file permissions. Never print or upload credentials.
2. Approve a maintenance/test window: the authorized test group already has an active stream. Stopping its current process can interrupt playback and lose an in-memory queue. No competing bridge or bot polling process should be launched on the same token/session.
3. Prefer an isolated test data directory copied through a consistent SQLite backup. Reuse private credentials only through protected local configuration, not a commit. Pause the original service through its identified supervisor; do not kill unrelated processes. Confirm the old bridge exited before starting the test build.
4. Verify owner-private `/music`, actual rich-message rendering, `/accounts health`, allowlist, canonical search/download/lyrics, cross-page selection, `/play` not queueing, real group audio/video, pause/resume/seek/volume/previous, player/queue edits, pinning, denied user controls, unavailable sources and lost-network recovery.
5. Observe the **real 600-second** idle leave and cancellation by new work. Test an approved channel and a second independent account/destination before claiming channel/concurrency transport validation. Those require additional authorized resources beyond a single active test group.
6. Use rights-cleared continuous fixtures for a 24–72 hour soak; monitor CPU/RSS, FFmpeg child count, disk/cache growth, edits/rate limits, lease count and recovery events. No multi-day uptime claim until this finishes.
7. Stop the test build gracefully, confirm leases/native children are gone, and restore the original service if the window was test-only. Do not restore an old database over newer user writes. Deployment after successful testing is a separate explicit decision.

Verified group checks and the incomplete idle-only measurement are recorded in MUSIC_VERIFICATION.md. Remaining limitations include uninterrupted real idle departure, channel broadcast permissions, multi-account live interference, mobile/listener visual-quality inspection, prolonged network disruption and multi-day soak. Durable playback resumption, crossfade/beatmatching, arbitrary commercial-catalog availability, and automatic recreation of externally deleted dashboards are not implemented. An edit error is currently backed off; opening a deleted dashboard may require owner intervention rather than automatic message recreation.
