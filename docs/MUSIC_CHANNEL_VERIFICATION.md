# Channel/private-administrator follow-up — 20 October 2026

## Release boundary

Feature branch: `engineering/lancy-music-v2-20261020`, following the full-song checkpoint `7e575a3`. This is source-branch work, **not a permanent production deployment**. The original production checkout's 22 tracked changes and five untracked files were preserved. Controlled tests briefly paused only the identified original service/bridge; an independent restoration guard was armed. The original service was verified online afterwards. No further broadcast was created after the one explicitly authorized diagnostic creation.

## Implemented

- `/channel @name` (also a Telegram link or channel ID) validates the bot and initiating administrator against Telegram, then opens and pins the dashboard **in that administrator's own bot DM**, never as a channel post. Non-owner channel administrators are supported without opening unrelated private AI, login or account-pool features. The existing ForceJoin gate remains in the route.
- Multiple administrators can have distinct private views of the same canonical channel queue. View, page, preview and pin state are local; playback and queue state are shared. Compact callback tokens bind bot, administrator, DM, message and original destination. Changing a DM binding cannot redirect an older dashboard or search submission.
- Replying directly to one's dashboard with a title/artist, `add track …`, `queue …` or `/addq …` opens canonical track selection for that exact channel. Add-tracks ForceReply input also retains its original panel. Select recordings, then **Add selected**; searches alone never broadcast guessed first matches. Explicit `/play` and plain `play …` retain standalone listen/download semantics.
- Group mutations, queue additions, dashboard access and playlist loading require fresh administrator checks. Public listen/download remains separate. Native Telegram slash suggestions publish public, administrator and private-channel command scopes, including per-chat custom-prefix scopes. Personal custom command prefixes work through scoped private music routing.
- Permission loss locks private views; actions recheck membership. Closing a private dashboard does not stop shared channel playback. No automatic account joining, promotion, channel broadcast creation, login-code capture or owner-pool exposure was added.

## Native publisher correction

The initial listener acceptance **failed**: the user heard no channel audio and their reply added nothing. That diagnostic's manual poller handled dashboard callbacks but not text/search replies. Its 110 Hz source also measured only −49.0 dB mean / −45.5 dB peak before 60% call volume. Neither advancing native time nor a successful upload proved audible broadcasting.

A corrected check then identified the playback account actually **joined but muted**. The bridge now:

1. Reads fresh, self-only Telegram participant state through the installed Pyrogram raw API.
2. Checks actual NTgCalls capture mute state, avoiding unnecessary native unmute transitions on source replacements.
3. Self-unmutes only during an explicit permitted start/resume/seek or eligible recovery; refuses a cannot-self-unmute participant. It does not promote accounts or override a moderator lock.
4. Confirms an unmuted publisher with a real audio source before reporting successful playback. Live call references are reused; verification/API waits are bounded, with safe stage/type diagnostics and immediate visibility of flood waits rather than silently sleeping past the verification deadline.
5. Rechecks publisher state during playing status. A later mute stops claiming successful playback, retains the current recording/queue and does not automatically fight the mute or advance through/discard the queue. Natural EOF is checked first so completion is not mistaken for a moderator mute. Failed resume verification re-pauses the decoder; paused seeks do not force an unmute.

The diagnostic calibration was replaced with a moderate 440 Hz recording measuring **−23.6 dB mean / −19.9 dB peak**, not with a permanent production loudness boost.

## Live acceptance result

Final controlled test: `@pappytest`, existing diagnostic broadcast preserved.

| Check | Observed result |
|---|---|
| Administrator's dashboard | Pinned DM message; no dashboard channel post |
| Native publisher | Present, unmuted, nonzero audio source |
| Native transport/control checks | Advancing time, pause/resume, volume/seek, skip/previous, natural advance and leave/rejoin passed |
| Same-message views | Queue, volume, settings and player retained the private message ID |
| Full-audio DM widget | Complete generated 360-second attachment accepted; separate from channel listening |
| Actual Telegram interaction | One administrator text message and 15 callbacks processed, including pick/submit |
| Actual canonical submission | One successful multi-selection submission; five queue entries appeared, with subsequent skip actions reducing the queue |
| Human channel listening | User selected **“Yes, channel audio is audible”** |
| Human reply/addition | User selected **“Reply and addition worked”** |
| Temporary dashboard | Unpinned/deleted at shutdown; only test-owned bot messages targeted |
| Original service | Verified online after independent restoration; production source not replaced |

The operator-only generated-query adapter was available for a rights-cleared test recording; ordinary queries continued through actual installed providers. This does not certify availability, licensing or download permission for an unrestricted music catalog. The human confirmation is stored separately from native harness events: a harness's intentionally conservative `listener_audio_confirmed: false` is not retroactively rewritten as if it had measured a listener.

Several earlier diagnostic attempts stopped before the human window, including native publisher-verification timeouts during rapid source replacement. Their failures are retained as failures, not counted as successful acceptance. The final source-state-aware implementation passed the automatic checks and the real interaction above.

## Automated verification of final source

- **193/193** expanded Node feature, music, rich-message, routing and AI-isolation tests passed.
- **27/27** Python bridge tests passed.
- Full bounded Node regression: **520 total; 517 passed, one failed, two cancelled by the 45-second file timeout**. This is not a fully green suite. Remaining known issues are the existing `/setprefix` suggestion assertion in `channelPostAndPrefix.test.js`, and timeouts in `inlineSearchAndHotReload.test.js` and `liveSearchAndNoDuplicates.test.js`.
- `git diff --check` passed.

Representative commands:

```sh
node --test tests/channelMusic.test.js tests/musicEngineering.test.js tests/musicPreviewUi.test.js tests/musicIntentAndLinkPreview.test.js tests/musicPlayLyricsAndRecognition.test.js tests/voiceChatAndMusicSystem.test.js tests/rich.test.js tests/ai.test.js tests/aiAndSpotifyEnrichment.test.js tests/aiAssistantAndScheduler.test.js tests/conversationalAiAndClonedTriggers.test.js
service/voice/.venv/bin/python3 -m unittest discover -s service/voice/tests -v
node --test --test-timeout=45000 tests/*.test.js
```

## Explicitly not certified

No permanent rollout, two-real-administrator live concurrency, two-account simultaneous live calls, uninterrupted 600-second idle departure, multi-day soak/network endurance, restart playback resumption, mobile visual certification or listener video synchronization is claimed. Earlier idle-test limitations still apply. A source push does not change the original production bot; deployment needs separate authorization.
