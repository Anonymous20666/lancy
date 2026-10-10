import { logger } from '../core/logger.js';
import { isJidNewsletter } from 'plogme';

/**
 * ChannelService — discovers WhatsApp channels/newsletters accessible to a
 * paired session and answers the only question that matters:
 *
 *     "can THIS session publish to that channel?"
 *
 * We never list random channels and never trust a cached permission:
 * every publish revalidates. If the metadata response does not expose a
 * definitive role, we mark the channel 'unknown' and verify at send time
 * (send errors are caught and reported per channel).
 */
export class ChannelService {
  constructor({ db, settings, log } = {}) {
    this.db = db;
    this.settings = settings;
    this.log = log ?? logger().child({ module: 'wa-channels' });
  }

  /**
   * Discover channels for a session: subscribed newsletters + metadata.
   * @returns {Promise<Array<{ jid, name, status, canPublish, checkedAt }>>}
   */
  async discover(session) {
    this.log.info({ sessionId: session.sessionId }, 'discovering newsletters/channels...');
    let list = [];
    try {
      const raw = await session.listSubscribedNewsletters();
      this.log.info({ sessionId: session.sessionId, rawType: typeof raw, isArray: Array.isArray(raw) }, 'raw newsletterSubscribed response');
      list = normalizeSubscribedResponse(raw);
    } catch (err) {
      this.log.warn({ sessionId: session.sessionId, err: err?.message }, 'listSubscribedNewsletters query failed — checking cached channels');
    }

    const cacheTtlMs = (this.settings?.get('whatsapp.channelCacheMinutes') ?? 10) * 60 * 1000;
    const now = new Date().toISOString();
    const channels = new Map();

    // 1. Process discovered list from live query
    for (const entry of list) {
      const jid = entry.jid;
      if (!jid || !isJidNewsletter(jid)) continue;
      let name = entry.name ?? null;
      let status = entry.status ?? null;
      let canPublish = detectPublishPermission(entry.raw ?? entry, session.jid);
      let meta = entry.raw ?? {};

      // If permission is still unknown, try fetching fresh metadata
      if (canPublish === 'unknown') {
        try {
          const metadata = await session.getNewsletterMetadata(jid);
          const parsed = normalizeMetadataResponse(metadata);
          name = name ?? parsed.name ?? null;
          status = status ?? parsed.status ?? null;
          meta = { ...meta, ...parsed };
          canPublish = detectPublishPermission(metadata, session.jid);
        } catch (error) {
          this.log.warn({ err: error?.message, jid }, 'channel metadata fetch failed');
        }
      }

      channels.set(jid, { jid, name, status, canPublish, checkedAt: now, meta });
      this.db.run(
        `INSERT INTO wa_channels (session_id, channel_jid, name, status, can_publish, can_publish_checked_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, channel_jid) DO UPDATE SET
           name = excluded.name, status = excluded.status,
           can_publish = excluded.can_publish,
           can_publish_checked_at = excluded.can_publish_checked_at,
           meta_json = excluded.meta_json`,
        session.sessionId, jid, name, status, canPublish, now, JSON.stringify(meta)
      );
    }

    // 2. Also include any previously cached / manually added channels for this session
    const cachedRows = this.cached(session.sessionId);
    for (const r of cachedRows) {
      if (!channels.has(r.channel_jid)) {
        let meta = {};
        try { meta = JSON.parse(r.meta_json ?? '{}'); } catch {}
        channels.set(r.channel_jid, {
          jid: r.channel_jid,
          name: r.name,
          status: r.status,
          canPublish: r.can_publish,
          checkedAt: r.can_publish_checked_at,
          meta
        });
      }
    }

    this.log.info({ sessionId: session.sessionId, total: channels.size }, 'channels discovery complete');
    return [...channels.values()];
  }

  /** Cached channel list (fast path for the UI). */
  cached(sessionId) {
    return this.db.all('SELECT * FROM wa_channels WHERE session_id = ?', sessionId);
  }

  /**
   * Resolve and register a channel by invite link, code, or JID.
   * e.g.: https://whatsapp.com/channel/0029Va... or 1203631234567890@newsletter
   */
  async resolveChannel(session, input) {
    if (!input || typeof input !== 'string') throw new Error('Channel link or JID is required');
    const cleaned = input.trim();
    let meta = null;
    let jid = null;
    let name = null;

    if (cleaned.includes('whatsapp.com/channel/') || cleaned.includes('wa.me/channel/') || (!cleaned.includes('@') && cleaned.length < 35 && !/^\d+$/.test(cleaned))) {
      // Invite link or invite code
      meta = await session.getNewsletterInviteInfo(cleaned);
      jid = meta?.id ?? meta?.jid ?? null;
      if (jid && !jid.includes('@')) jid = `${jid}@newsletter`;
      const parsed = normalizeMetadataResponse(meta);
      name = parsed.name ?? meta?.thread_metadata?.name?.text ?? meta?.name ?? 'WhatsApp Channel';
    } else {
      // Direct JID or numeric ID
      jid = cleaned.includes('@') ? cleaned : `${cleaned}@newsletter`;
      meta = await session.getNewsletterMetadata(jid);
      const parsed = normalizeMetadataResponse(meta);
      name = parsed.name ?? meta?.thread_metadata?.name?.text ?? meta?.name ?? 'WhatsApp Channel';
    }

    if (!jid) throw new Error('Could not resolve channel JID from input');
    const canPublish = detectPublishPermission(meta, session.jid);
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO wa_channels (session_id, channel_jid, name, status, can_publish, can_publish_checked_at, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, channel_jid) DO UPDATE SET
         name = excluded.name, status = excluded.status,
         can_publish = excluded.can_publish,
         can_publish_checked_at = excluded.can_publish_checked_at,
         meta_json = excluded.meta_json`,
      session.sessionId, jid, name, 'ACTIVE', canPublish, now, JSON.stringify(meta ?? {})
    );

    return { jid, name, status: 'ACTIVE', canPublish, checkedAt: now, meta: meta ?? {} };
  }

  /**
   * Revalidate publishing permission for the selected channels RIGHT BEFORE
   * publishing. Never assume cached permissions are still valid.
   */
  async revalidate(session, channelJids) {
    const results = [];
    for (const jid of channelJids) {
      let canPublish = 'unknown';
      let name = null;
      try {
        const metadata = await session.getNewsletterMetadata(jid);
        canPublish = detectPublishPermission(metadata, session.jid);
        name = normalizeMetadataResponse(metadata)?.name ?? null;
      } catch (error) {
        canPublish = 'unknown';
        this.log.warn({ err: error, jid }, 'permission revalidation failed');
      }
      this.db.run(
        `UPDATE wa_channels SET can_publish = ?, can_publish_checked_at = ?, name = COALESCE(?, name)
         WHERE session_id = ? AND channel_jid = ?`,
        canPublish, new Date().toISOString(), name, session.sessionId, jid
      );
      results.push({ jid, name, canPublish });
    }
    return results;
  }
}

/** The subscribed-newsletters mex response can arrive in a few shapes. */
export function normalizeSubscribedResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizeChannelEntry).filter(Boolean);

  if (typeof raw === 'object') {
    const list = [
      raw.result,
      raw.data,
      raw.newsletters,
      raw.threads,
      raw.xwa2_newsletter_subscribed,
      raw.result?.newsletters,
      raw.result?.threads,
      raw.data?.newsletters,
      raw.data?.xwa2_newsletter_subscribed,
      raw.subscribed
    ].find(Array.isArray);

    if (list) return list.map(normalizeChannelEntry).filter(Boolean);

    // Deep search any array in raw
    for (const val of Object.values(raw)) {
      if (Array.isArray(val) && val.length > 0) {
        return val.map(normalizeChannelEntry).filter(Boolean);
      }
    }
  }
  return [];
}

export function normalizeChannelEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const jid = entry.includes('@') ? entry : `${entry}@newsletter`;
    return { jid, name: null, status: null, canPublish: 'unknown', meta: {} };
  }
  const rawJid = entry.jid ?? entry.id ?? entry.newsletter_jid ?? entry.key?.remoteJid;
  if (!rawJid) return null;
  const jid = String(rawJid).includes('@') ? String(rawJid) : `${rawJid}@newsletter`;

  const thread = entry.thread_metadata ?? entry;
  const name = thread?.name?.text ?? thread?.name ?? entry.name?.text ?? entry.name ?? null;
  const status = entry.state ?? entry.status ?? null;
  const viewer = entry.viewer_metadata ?? thread?.viewer_metadata ?? null;

  return {
    jid,
    name: typeof name === 'string' ? name : null,
    status: typeof status === 'string' ? status : null,
    viewer,
    thread,
    raw: entry
  };
}

/** Normalize a newsletterMetadata response. */
export function normalizeMetadataResponse(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const result = raw.result && typeof raw.result === 'object' ? raw.result : raw;
  const thread = result.thread_metadata ?? {};
  return {
    id: result.id ?? null,
    name: thread.name?.text ?? thread.name ?? null,
    description: thread.description?.text ?? thread.description ?? null,
    subscribers: thread.subscribers_count ?? null,
    creationTime: thread.creation_time ?? null,
    invite: thread.invite ?? null,
    verification: thread.verification ?? null,
    picture: thread.picture ?? null,
    participants: thread.participants ?? result.participants ?? null,
    settings: thread.settings ?? result.settings ?? null,
    viewer: result.viewer_metadata ?? null,
    raw: result
  };
}

/**
 * Detect whether `sessionJid` may publish to a channel, from the metadata
 * response. WhatsApp exposes role information in different places depending
 * on client version; we check every known location and stay honest:
 * 'yes' | 'no' | 'unknown' (unknown → verified at send time).
 */
export function detectPublishPermission(metadata, sessionJid) {
  if (!metadata || typeof metadata !== 'object') return 'unknown';
  const result = metadata.result && typeof metadata.result === 'object' ? metadata.result : metadata;
  const thread = result.thread_metadata ?? {};
  const me = String(sessionJid ?? '').split('@')[0];

  // 1. Explicit viewer role fields.
  const viewer = result.viewer_metadata ?? {};
  const role = viewer.role ?? viewer.publish_role ?? thread.viewer_role ?? null;
  if (role) {
    const r = String(role).toLowerCase();
    if (['owner', 'admin', 'publisher', 'editor', 'author'].includes(r)) return 'yes';
    if (['subscriber', 'member', 'viewer', 'follower', 'muted'].includes(r)) return 'no';
  }

  // 2. Participants list with per-user admin flags.
  const participants = thread.participants ?? result.participants ?? null;
  if (Array.isArray(participants)) {
    const mine = participants.find((p) => String(p.id ?? p.jid ?? '').split('@')[0] === me);
    if (mine) {
      if (mine.is_admin === true || mine.is_super_admin === true || mine.admin === true) return 'yes';
      if (mine.role && ['admin', 'owner', 'superadmin'].includes(String(mine.role).toLowerCase())) return 'yes';
      if (mine.is_admin === false || mine.role === 'subscriber' || mine.role === 'member') return 'no';
    }
  }

  // 3. Channel settings: some responses mark who may post.
  const settings = thread.settings ?? result.settings ?? null;
  if (settings && typeof settings === 'object') {
    const posting = settings.posting ?? settings.who_can_post ?? settings.send_messages ?? null;
    if (posting) {
      const p = String(posting).toLowerCase();
      if (['all', 'everyone', 'anyone'].includes(p)) return 'yes';
      if (['admins', 'admins_only', 'owner'].includes(p)) return 'unknown'; // could be us — verify at send
    }
  }

  // 4. react/send capability flags on viewer metadata.
  if (viewer.can_send === true || viewer.can_post === true || viewer.can_publish === true) return 'yes';
  if (viewer.can_send === false || viewer.can_post === false || viewer.can_publish === false) return 'no';

  return 'unknown';
}
