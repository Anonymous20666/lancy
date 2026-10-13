# Plogme Baileys API Reference & Explorer Manual
**Package Version:** `plogme@2.0.7`  
**Audit Status:** Complete Exhaustive Audit  
**Audit Timestamp:** `2026-10-13T06:50:30Z`  
**Discovered Exports:** 396 top-level exports  
**Discovered Socket Methods:** 669 methods on `WASocket`  
**Catalogued Features:** 26 Core Verified Capabilities  

---

## 1. Overview & Architecture

The **Plogme Baileys Explorer** is an owner-only, single-message interactive laboratory integrated directly into the WhatsApp bot session. It enables deep inspection, code copying, and testing of every capability provided by `plogme@2.0.7` (a modern TypeScript/ESM fork of Baileys).

### Key Architectural Highlights
* **Single-Message Master Index**: `.tmenu` renders the entire category index, version diagnostics, and **multiple genuine native copy buttons** inside **ONE single WhatsApp message**.
* **Real Native Copy Buttons (`cta_copy`)**: Uses WhatsApp's official `nativeFlowMessage` with `cta_copy` action buttons. Tapping a button directly copies the reference ID, method signature, working code, or AI implementation prompt to the user's mobile or desktop clipboard.
* **Owner Security**: Strict authentication via `isOwnerSender(m)`. Every query, navigation action, and test execution verifies that the sender is the authenticated session owner (`fromMe === true` or phone/JID/LID match). Non-owner requests are dropped silently with zero leakage.
* **Test Lab**: Built-in test execution engine supporting `STATIC`, `LOCAL`, and `LIVE` verification of features without memory leaks or duplicate listener registrations.

---

## 2. Command Index & Syntax

| Command | Action | Example |
| :--- | :--- | :--- |
| `.tmenu` | Display master category index with 4 native copy buttons | `.tmenu` |
| `.tmenu <category>` | Browse features in a category | `.tmenu rich`, `.tmenu media`, `.tmenu polls` |
| `.tmenu <ref_id>` | Deep dive specification for a feature | `.tmenu PLOG-RCH-001`, `.tmenu PLOG-POL-001` |
| `.tmenu search <query>` | Search registry by keyword or signature | `.tmenu search copy button`, `.tmenu search album` |
| `.tmenu test <ref_id>` | Run Test Lab verification | `.tmenu test PLOG-RCH-001` |
| `.tmenu test <ref_id> --live` | Run Live Outbound test to current chat | `.tmenu test PLOG-RCH-001 --live` |
| `.tmenu audit` | Display complete symbol and coverage diagnostics | `.tmenu audit` |

*Note: All commands respect the bot's active prefix (e.g., `!tmenu`, `#tmenu`, or `.tmenu`).*

---

## 3. Native Copy Button Implementation Specification

### How WhatsApp Native Copy Buttons Work
In WhatsApp protocol (and implemented in `plogme/lib/Utils/messages.js:531-540`), interactive buttons are transmitted as `interactiveMessage.nativeFlowMessage`:
```json
{
  "interactiveMessage": {
    "body": { "text": "✦ PLOGME BAILEYS EXPLORER ✦" },
    "footer": { "text": "Tap buttons below to copy code" },
    "nativeFlowMessage": {
      "buttons": [
        {
          "name": "cta_copy",
          "buttonParamsJson": "{\"display_text\":\"📋 Copy Ref ID\",\"copy_code\":\"PLOG-RCH-001\"}"
        },
        {
          "name": "cta_copy",
          "buttonParamsJson": "{\"display_text\":\"📋 Copy Signature\",\"copy_code\":\"sock.sendMessage(jid, { text, nativeFlow })\"}"
        },
        {
          "name": "cta_copy",
          "buttonParamsJson": "{\"display_text\":\"📋 Copy Example Code\",\"copy_code\":\"await sock.sendMessage(jid, { text: \\\"Hello\\\", nativeFlow: [...] });\"}"
        },
        {
          "name": "cta_copy",
          "buttonParamsJson": "{\"display_text\":\"📋 Copy AI Prompt\",\"copy_code\":\"Implement WhatsApp native copy buttons in plogme 2.0.7...\"}"
        }
      ]
    }
  }
}
```

### Sending via `plogme`
```javascript
await sock.sendMessage(jid, {
  text: "My message body",
  footer: "My footer text",
  nativeFlow: [
    { text: "📋 Copy ID", copy: "PLOG-RCH-001" },
    { text: "📋 Copy Code", copy: "const code = 123;" }
  ]
});
```

---

## 4. Audited Categories & Feature Registry

### Category 1: Messaging & Quoting (`PLOG-MSG`)
* **`PLOG-MSG-001`**: Send Plain Text Message  
  * **Signature**: `sock.sendMessage(jid: string, content: { text: string }, options?): Promise<proto.WebMessageInfo>`  
  * **Source**: `lib/Socket/messages-send.js:250`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MSG-002`**: Quoted Reply Message  
  * **Signature**: `sock.sendMessage(jid, content, { quoted: incomingMsg })`  
  * **Source**: `lib/Socket/messages-send.js:310`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MSG-003`**: Edit Sent Message (`ProtocolMessage.MESSAGE_EDIT`)  
  * **Signature**: `sock.sendMessage(jid, { text: string, edit: messageKey })`  
  * **Source**: `lib/Socket/messages-send.js:410`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MSG-004`**: Delete Message for Everyone (`ProtocolMessage.REVOKE`)  
  * **Signature**: `sock.sendMessage(jid, { delete: messageKey })`  
  * **Source**: `lib/Socket/messages-send.js:440`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MSG-005`**: React to Message (Emoji Reaction)  
  * **Signature**: `sock.sendMessage(jid, { react: { text: string, key } })`  
  * **Source**: `lib/Socket/messages-send.js:480`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MSG-006`**: Group Invisible & Visible Mentions  
  * **Signature**: `sock.sendMessage(jid, { text: string, mentions: string[] })`  
  * **Source**: `lib/Utils/messages.js:1270`  
  * **Status**: `VERIFIED-LOCAL`

### Category 2: Media & Attachments (`PLOG-MED`)
* **`PLOG-MED-001`**: Send Image with Caption  
  * **Signature**: `sock.sendMessage(jid, { image: Buffer | { url }, caption?: string })`  
  * **Source**: `lib/Socket/messages-send.js:280`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MED-002`**: Send Video or GIF  
  * **Signature**: `sock.sendMessage(jid, { video: Buffer | { url }, caption?: string, gifPlayback?: boolean })`  
  * **Source**: `lib/Socket/messages-send.js:290`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-MED-003`**: Send Media Album (Multiple Media Items)  
  * **Signature**: `sock.sendAlbumMessage(jid, medias: Array<{ image?, video?, caption? }>)`  
  * **Source**: `lib/Socket/messages-send.js:2205`  
  * **Status**: `VERIFIED-STATIC`
* **`PLOG-MED-004`**: Download Inbound Media Stream  
  * **Signature**: `downloadContentFromMessage(message: proto.IMediaMessage, type: MediaType)`  
  * **Source**: `lib/Utils/messages-media.js:635`  
  * **Status**: `VERIFIED-LOCAL`

### Category 3: Stickers & Packs (`PLOG-STK`)
* **`PLOG-STK-001`**: Send Single WebP Sticker  
  * **Signature**: `sock.sendMessage(jid, { sticker: Buffer | { url } })`  
  * **Source**: `lib/Socket/messages-send.js:300`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-STK-002`**: Send Native Sticker Pack Message  
  * **Signature**: `sock.sendMessage(jid, { name, publisher, cover, stickers: Array<{ data, emojis }> })`  
  * **Constraint**: `stickers.length <= 60` (physical WhatsApp limit)  
  * **Source**: `lib/Utils/messages.js:485`  
  * **Status**: `VERIFIED-LOCAL`

### Category 4: Polls & Interactive Voting (`PLOG-POL`)
* **`PLOG-POL-001`**: Create Interactive Poll  
  * **Signature**: `sock.sendMessage(jid, { poll: { name, values: string[], selectableCount?: number } })`  
  * **Source**: `lib/Utils/messages.js:1245`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-POL-002`**: Aggregate & Decrypt Poll Votes  
  * **Signature**: `getAggregateVotesInPollMessage({ message, pollUpdates }, meId)`  
  * **Source**: `lib/Utils/messages.js:1922`  
  * **Status**: `VERIFIED-LOCAL`

### Category 5: Rich Messages & Native Flow (`PLOG-RCH`)
* **`PLOG-RCH-001`**: Native Flow Multiple Copy Buttons (`cta_copy`)  
  * **Signature**: `sock.sendMessage(jid, { text, footer?, nativeFlow: Array<{ text, copy }> })`  
  * **Source**: `lib/Utils/messages.js:531`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-RCH-002`**: GenAI Rich Response Copy-to-Clipboard  
  * **Signature**: `sock.sendRichTextCopy(jid, { text?, copyText, copyLabel?, alignment? })`  
  * **Source**: `lib/Socket/messages-send.js:2308`  
  * **Status**: `VERIFIED-STATIC`
* **`PLOG-RCH-003`**: Multi-Card Button Grid (Carousel)  
  * **Signature**: `sock.sendRichButtonGrid(jid, { text?, cards: Array<{ title?, buttons }> })`  
  * **Source**: `lib/Socket/messages-send.js:2748`  
  * **Status**: `VERIFIED-STATIC`

### Category 6: Events & Stream Listeners (`PLOG-EVT`)
* **`PLOG-EVT-001`**: Inbound Messages Upsert Listener  
  * **Signature**: `sock.ev.on('messages.upsert', ({ messages, type }) => void)`  
  * **Source**: `lib/Types/Events.d.ts:25`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-EVT-002`**: Connection Lifecycle & QR Listener  
  * **Signature**: `sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => void)`  
  * **Source**: `lib/Types/Events.d.ts:15`  
  * **Status**: `VERIFIED-LOCAL`

### Category 7: Group Administration (`PLOG-GRP`)
* **`PLOG-GRP-001`**: Fetch Group Metadata & Subject  
  * **Signature**: `sock.groupMetadata(jid: string): Promise<GroupMetadata>`  
  * **Source**: `lib/Socket/groups.js:52`  
  * **Status**: `VERIFIED-STATIC`
* **`PLOG-GRP-002`**: Group Participants Management (Add/Remove/Promote)  
  * **Signature**: `sock.groupParticipantsUpdate(jid, participants, action)`  
  * **Source**: `lib/Socket/groups.js:124`  
  * **Status**: `VERIFIED-STATIC`

### Category 8: Channels & Newsletters (`PLOG-CHN`)
* **`PLOG-CHN-001`**: Fetch Newsletter / Channel Metadata  
  * **Signature**: `sock.newsletterMetadata(type: "jid" | "invite", key: string): Promise<NewsletterMetadata>`  
  * **Source**: `lib/Socket/newsletter.js:42`  
  * **Status**: `VERIFIED-STATIC`
* **`PLOG-CHN-002`**: Publish Post to Newsletter  
  * **Signature**: `sock.sendMessage(channelJid, { text: string })`  
  * **Source**: `lib/Socket/messages-send.js:350`  
  * **Status**: `VERIFIED-LOCAL`

### Category 9: Profile & Privacy (`PLOG-PRF`)
* **`PLOG-PRF-001`**: Send Presence Indicator (Composing/Recording/Paused)  
  * **Signature**: `sock.sendPresenceUpdate(type: "composing" | "paused", toJid?: string)`  
  * **Source**: `lib/Socket/presence.js:28`  
  * **Status**: `VERIFIED-LOCAL`

### Category 10: Protobuf & JID Utilities (`PLOG-UTL`)
* **`PLOG-UTL-001`**: JID Identification & Normalization  
  * **Signature**: `isJidGroup(jid), isJidNewsletter(jid), jidNormalizedUser(jid)`  
  * **Source**: `lib/WABinary/jid-utils.js:20`  
  * **Status**: `VERIFIED-LOCAL`
* **`PLOG-UTL-002`**: Low-Level Message Content Generator  
  * **Signature**: `generateWAMessageContent(content, options): Promise<proto.IMessage>`  
  * **Source**: `lib/Utils/messages.js:1255`  
  * **Status**: `VERIFIED-LOCAL`

---

## 5. Test Lab Verification Matrix

All catalogued feature routines were audited and executed via `lab.runTest(refId)`:
* **`PLOG-RCH-001` (Native Copy Buttons)**: `PASS` — Validated interactiveMessage with `cta_copy` buttons and exact `copy_code` JSON.
* **`PLOG-POL-001` & `PLOG-POL-002` (Polls & Vote Tally)**: `PASS` — Validated pollCreationMessage schema and voter vote hash tallying.
* **`PLOG-MSG-001` & `PLOG-MSG-006` (Text & Mentions)**: `PASS` — Validated `extendedTextMessage` contextInfo with mentioned JID arrays.
* **`PLOG-STK-002` (Sticker Pack Limits)**: `PASS` — Enforces physical ≤ 60 limit correctly.
* **`PLOG-EVT-001` & `PLOG-EVT-002` (Listeners)**: `PASS` — Verified zero listener leak on `off()`.
* **`PLOG-UTL-001` (JID Helpers)**: `PASS` — Verified normalized user and group/newsletter checks.
* **`PLOG-UTL-002` (Protobuf Content Generator)**: `PASS` — Generates valid `proto.IMessage`.
