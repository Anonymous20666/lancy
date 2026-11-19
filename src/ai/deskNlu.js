/**
 * Deterministic Zero-Latency A-Z Desk Command NLU Parser.
 *
 * Parses single or chained English / Nigerian Pidgin desk commands cleanly into
 * exact structured `lancyTools` invocations without LLM tool-hallucination risk.
 * Returns `null` whenever any clause looks open-ended or conversational so the
 * Hybrid AI Brain handles reasoning cleanly.
 */

const CLAUSE_SPLIT_RE = /\s*(?:,|;|\band\s+then\b|\bthen\b|\bplus\b|\band\b)\s*/i;

function normalizeQualityValue(raw) {
  const s = String(raw || '').toLowerCase();
  if (/1080|full\s*hd|fhd|ultra|sharp|max/.test(s)) return '1080p';
  if (/720|smooth|\bhd\b|medium/.test(s)) return '720p';
  if (/480|360|low|fast|data\s*saver|\bsd\b/.test(s)) return '480p';
  return null;
}

function parseSingleClause(clause) {
  const clean = String(clause || '')
    .replace(/^(?:please|pls|plz|abeg|kindly|can\s+you|could\s+you|just|now|o|oh)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!clean || clean.length < 2) return null;

  // Reject conversational / open-ended questions so AI brain handles them naturally
  if (/^(?:why|how\s+(?:are|is|u|you|far|was)|who|tell\s+me|what\s+do\s+you\s+think|suggest|recommend)\b/i.test(clean)) {
    return null;
  }

  const lower = clean.toLowerCase();

  // Mute / Unmute / Volume
  if (/^(?:unmute(?:\s+(?:it|audio|call|sound|vc))?)$/i.test(lower)) {
    return { name: 'adjust_volume', args: { mode: 'unmute' } };
  }
  if (/^(?:mute(?:\s+(?:it|audio|call|sound|vc))?)$/i.test(lower)) {
    return { name: 'adjust_volume', args: { mode: 'mute' } };
  }
  const volExact = lower.match(/^(?:(?:lower|reduce|decrease|turn\s+down|raise|increase|turn\s+up|set)\s+)?(?:the\s+)?(?:vol|volume|sound)\s*(?:to|at|=)?\s*(\d{1,3})\s*%?$/i);
  if (volExact) {
    return { name: 'adjust_volume', args: { mode: 'set', value: Math.max(0, Math.min(200, Number(volExact[1]))) } };
  }
  const volDown = lower.match(/^(?:lower|reduce|decrease|turn\s+down|drop)\s+(?:the\s+)?(?:vol|volume|sound)(?:\s+(?:by\s+)?(\d{1,3}))?$/i);
  if (volDown) {
    return { name: 'adjust_volume', args: { mode: 'lower', value: Number(volDown[1] || 20) } };
  }
  const volUp = lower.match(/^(?:raise|increase|turn\s+up|boost|make)\s+(?:the\s+)?(?:vol|volume|sound)(?:\s+louder)?(?:\s+(?:by\s+)?(\d{1,3}))?$/i)
    || /^(?:louder|vol(?:ume)?\s+up)$/i.test(lower);
  if (volUp) {
    const by = Array.isArray(volUp) && volUp[1] ? Number(volUp[1]) : 20;
    return { name: 'adjust_volume', args: { mode: 'louder', value: by } };
  }

  // Transport controls
  if (/^(?:pause(?:\s+(?:it|playback|music|movie|video|this))?)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'pause' } };
  }
  if (/^(?:resume|unpause|continue|carry\s+on|play\s+on|start\s+again)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'resume' } };
  }
  if (/^(?:skip(?:\s+(?:this|song|track|movie|it))?|next(?:\s+(?:song|track|episode|one|queue))?|move\s+to\s+next(?:\s+queue)?)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'skip' } };
  }
  if (/^(?:vote\s+skip|skip\s+vote)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'vote_skip' } };
  }
  if (/^(?:previous|prev|go\s+back|last\s+(?:track|song|episode))$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'previous' } };
  }
  if (/^(?:stop(?:\s+(?:playing|playback|music|movie|vc|all))?)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'stop' } };
  }
  if (/^(?:leave(?:\s+(?:vc|call|voice\s+chat))?|disconnect)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'leave' } };
  }
  if (/^(?:shuffle(?:\s+(?:the\s+)?queue)?)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'shuffle' } };
  }
  if (/^(?:refresh(?:\s+(?:player|card|desk|dashboard))?|reload\s+player)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'refresh_player' } };
  }
  if (/^(?:pin(?:\s+(?:player|card|desk|dashboard))?)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'pin_player' } };
  }
  if (/^(?:hide|remove|dismiss)\s+(?:the\s+)?(?:vc\s+|cinema\s+)?guide(?:\s+forever|\s+permanently)?$|^(?:don'?t|do\s+not)\s+show\s+(?:the\s+)?(?:vc\s+|cinema\s+)?guide(?:\s+again)?$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'hide_guide' } };
  }
  if (/^(?:show|restore|enable)\s+(?:the\s+)?(?:vc\s+|cinema\s+)?guide$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'show_guide' } };
  }

  // Loop modes
  if (/^(?:loop|repeat)\s+(?:off|disable|none|stop)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'set_loop', loop_mode: 'off' } };
  }
  if (/^(?:loop|repeat)\s+(?:track|song|one|this|single)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'set_loop', loop_mode: 'track' } };
  }
  if (/^(?:loop|repeat)\s+(?:queue|all|list)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'set_loop', loop_mode: 'queue' } };
  }
  if (/^(?:toggle\s+loop|loop|repeat)$/i.test(lower)) {
    return { name: 'control_playback', args: { action: 'toggle_loop' } };
  }

  // Deck switch
  const deckSw = lower.match(/^(?:switch|change|go)(?:\s+deck)?\s+to\s+(music|audio|dj|movie|cinema|film)(?:\s+deck)?$/i);
  if (deckSw) {
    return { name: 'control_playback', args: { action: 'switch_deck', deck: /movie|cinema|film/.test(deckSw[1]) ? 'movie' : 'music' } };
  }

  // Seek controls
  const seekM = lower.match(/^(?:go\s+to|jump\s+to|seek(?:\s+to)?|skip\s+to|rewind(?:\s+by)?|forward(?:\s+by)?)\s+(?:the\s+)?(?:movie\s+|video\s+|song\s+)?(.+)$/i);
  if (seekM && /\b(?:middle|halfway|center|quarter|three\s*quarters?|start|beginning|end|climax|\d+:\d+|\d+%|\d+\s*(?:s|sec|seconds?|m|min|minutes?|h|hr|hours?))\b/i.test(seekM[1])) {
    const isBack = /^rewind/i.test(lower);
    const isFwd = /^(?:forward|skip)/i.test(lower) && !/to\b/i.test(lower);
    let target = seekM[1].trim();
    if (isBack && !target.startsWith('-')) target = `-${target}`;
    if (isFwd && !target.startsWith('+')) target = `+${target}`;
    return { name: 'seek_playback', args: { target } };
  }
  if (/^[+-]\d+\s*(?:s|sec|m|min)?$/i.test(lower)) {
    return { name: 'seek_playback', args: { target: lower } };
  }

  // Quality & stream mode
  const qualM = lower.match(/^(?:switch|change|set)?\s*(?:video\s+)?(?:quality(?:\s+to)?|to)\s*(1080p?|720p?|480p?|360p?|full\s*hd|fhd|smooth|low|high|data\s*saver)$/i)
    || lower.match(/^(1080p|720p|480p|360p)$/i);
  if (qualM) {
    const q = normalizeQualityValue(qualM[1]);
    if (q) return { name: 'tune_cinema_stream', args: { setting: 'quality', value: q } };
  }
  if (/^(?:rtmp(?:\s+on|\s+mode|\s+live)?|switch\s+to\s+rtmp|locked\s+rtmp)$/i.test(lower)) {
    return { name: 'tune_cinema_stream', args: { setting: 'stream_mode', value: 'rtmp' } };
  }
  if (/^(?:rtmp\s+off|interactive(?:\s+vc|\s+mode)?|webrtc|switch\s+to\s+interactive(?:\s+vc)?)$/i.test(lower)) {
    return { name: 'tune_cinema_stream', args: { setting: 'stream_mode', value: 'interactive' } };
  }

  // Audio language & Movie source & Subtitles
  const audM = lower.match(/^(?:switch|change|set)?\s*(?:the\s+)?(?:audio|sound|voice)\s*(?:language|track)?\s*(?:to)?\s*(original|orig|en|english|es|spanish|fr|french|hi|hindi|ko|korean|ja|japanese|next)$/i);
  if (audM) {
    return { name: 'tune_cinema_stream', args: { setting: 'audio_language', value: audM[1].toLowerCase() } };
  }
  if (/^(?:switch|change|next|alt(?:ernate)?)\s+source(?:\s+(\d+))?$/i.test(lower)) {
    const m = lower.match(/(\d+)/);
    return { name: 'tune_cinema_stream', args: { setting: 'switch_source', value: m ? m[1] : 'next' } };
  }
  if (/^(?:auto\s*(?:sync|align)\s*sub(?:titles?|s)?|fix\s+sub(?:title)?\s*(?:sync|timing)|subcheck)$/i.test(lower)) {
    return { name: 'tune_cinema_stream', args: { setting: 'auto_sync_subtitles', value: 'auto' } };
  }
  const subOffM = lower.match(/^(?:sub(?:title)?\s*(?:offset|sync|delay)|shift\s+sub(?:titles?|s)?)\s*(?:by|to)?\s*([+-]?\d+(?:\.\d+)?)\s*s?$/i);
  if (subOffM) {
    return { name: 'tune_cinema_stream', args: { setting: 'subtitle_offset', value: subOffM[1] } };
  }
  const subModeM = lower.match(/^(?:turn\s+)?(?:subtitles?|subs)\s*(screen|live|vc|off|on|enable|disable)$/i)
    || lower.match(/^(?:turn\s+(on|off)|enable|disable)\s+(?:the\s+)?(?:subtitles?|subs)$/i);
  if (subModeM) {
    const modeWord = String(subModeM[1] || 'screen').toLowerCase();
    const mapped = ['off', 'disable'].includes(modeWord) ? 'off' : (['live', 'vc'].includes(modeWord) ? modeWord : 'screen');
    return { name: 'tune_cinema_stream', args: { setting: 'subtitle_mode', value: mapped } };
  }
  const subTileM = lower.match(/^(?:turn\s+(on|off)|enable|disable|toggle)?\s*(?:dual\s+|secondary\s+)?sub(?:title)?\s+tile(?:\s+(on|off))?$/i);
  if (subTileM) {
    const val = (subTileM[1] || subTileM[2] || 'toggle').toLowerCase();
    return { name: 'tune_cinema_stream', args: { setting: 'dual_subtitle_tile', value: val } };
  }

  // Video search & numbered video playback ("search videos for...", "play video 2")
  const vidSearchM = clean.match(/^(?:search|find|look\s+up)\s+(?:youtube\s+)?videos?(?:\s+(?:for|of|about))?\s+(.+)$/i);
  if (vidSearchM && vidSearchM[1]?.trim().length >= 2) {
    return { name: 'search_videos', args: { query: vidSearchM[1].trim(), action: 'search' } };
  }
  const vidPickM = lower.match(/^(?:play|stream|watch|queue)\s+video\s*(?:number|#|no\.?)?\s*(\d+)$/i);
  if (vidPickM) {
    return { name: 'search_videos', args: { action: lower.startsWith('queue') ? 'queue' : 'play_now', result_index: Number(vidPickM[1]) } };
  }

  // Numbered movie search selection ("play #1", "pick number 2 season 3 episode 4", "play number 1")
  const mvResultPickM = lower.match(/^(?:play|select|pick|choose|load|open|stream)\s+(?:number|option|result|movie|series|no\.?|#)\s*(\d+)(?:\s+season\s*(\d+))?(?:\s+ep(?:isode)?\s*(\d+))?$/i);
  if (mvResultPickM) {
    return {
      name: 'search_movies_series',
      args: {
        action: 'play_now',
        target_scope: 'search_result',
        result_index: Number(mvResultPickM[1]),
        ...(mvResultPickM[2] ? { season: Number(mvResultPickM[2]) } : {}),
        ...(mvResultPickM[3] ? { episode: Number(mvResultPickM[3]) } : {})
      }
    };
  }

  // Direct season / episode loading on current or next movie ("i need episode 3 of this movie", "play season 3 episode 4", "load episode 2 of next movie")
  const nextEpM = lower.match(/^(?:i\s+need|give\s+me|play|load|queue|put\s+on|watch)\s+(?:season\s*(\d+)\s+)?ep(?:isode)?\s*(\d+)\s+of\s+(?:the\s+)?next(?:\s+(?:movie|series|show))?$/i);
  if (nextEpM) {
    return {
      name: 'search_movies_series',
      args: {
        action: lower.startsWith('queue') ? 'queue' : 'play_now',
        target_scope: 'up_next',
        ...(nextEpM[1] ? { season: Number(nextEpM[1]) } : {}),
        episode: Number(nextEpM[2])
      }
    };
  }
  const curEpM = lower.match(/^(?:i\s+need|give\s+me|play|load|queue|put\s+on|watch)\s+(?:season\s*(\d+)\s+)?ep(?:isode)?\s*(\d+)(?:\s+of\s+(?:this|the\s+current)(?:\s+(?:movie|series|show))?)?$/i);
  if (curEpM) {
    return {
      name: 'search_movies_series',
      args: {
        action: lower.startsWith('queue') ? 'queue' : 'play_now',
        target_scope: 'current',
        ...(curEpM[1] ? { season: Number(curEpM[1]) } : {}),
        episode: Number(curEpM[2])
      }
    };
  }

  // Queue management
  if (/^(?:list|show|what(?:'s|\s+is)\s+in)\s+(?:the\s+)?queue$/i.test(lower)) {
    return { name: 'manage_queue', args: { action: 'list' } };
  }
  const qClearM = lower.match(/^clear\s+(?:the\s+)?(?:(music|movie)\s+)?queue$/i);
  if (qClearM) {
    return { name: 'manage_queue', args: { action: 'clear', ...(qClearM[1] ? { deck: qClearM[1].toLowerCase() } : {}) } };
  }
  const qJumpM = lower.match(/^(?:play|jump\s+to)\s+(?:queue\s*)?#?(\d+)\b/i);
  if (qJumpM) {
    return { name: 'manage_queue', args: { action: 'jump', index: Number(qJumpM[1]) } };
  }
  const qPromoteM = lower.match(/^(?:promote|move\s+to\s+(?:top|next|#?1))\s+(?:queue\s*)?#?(\d+)\b/i);
  if (qPromoteM) {
    return { name: 'manage_queue', args: { action: 'promote', index: Number(qPromoteM[1]) } };
  }
  const qRemoveIdxM = lower.match(/^(?:remove|delete)\s+(?:queue\s*)?#(\d+)$/i);
  if (qRemoveIdxM) {
    return { name: 'manage_queue', args: { action: 'remove', index: Number(qRemoveIdxM[1]) } };
  }
  const qRemoveTitleM = lower.match(/^(?:remove|delete)\s+(.+?)\s+from\s+(?:the\s+)?(?:(music|movie)\s+)?queue$/i);
  if (qRemoveTitleM) {
    return { name: 'manage_queue', args: { action: 'remove', query: qRemoveTitleM[1].trim(), ...(qRemoveTitleM[2] ? { deck: qRemoveTitleM[2].toLowerCase() } : {}) } };
  }

  // Playlists
  const plSaveM = clean.match(/^save\s+(?:this\s+|current\s+)?(?:queue\s+as\s+)?playlist\s+(.+)$/i);
  if (plSaveM) {
    return { name: 'manage_queue', args: { action: 'playlist_save', query: plSaveM[1].trim() } };
  }
  const plLoadM = clean.match(/^(?:load|play)\s+playlist\s+(.+)$/i);
  if (plLoadM) {
    return { name: 'manage_queue', args: { action: 'playlist_load', query: plLoadM[1].trim() } };
  }
  if (/^(?:list|show)\s+(?:my\s+)?playlists$/i.test(lower)) {
    return { name: 'manage_queue', args: { action: 'playlist_list' } };
  }

  // AI DJ & Visual Desk controls
  if (/^(?:turn\s+on|enable|show)\s+(?:the\s+)?(?:visual\s+)?dj\s+desk$/i.test(lower) || /^dj\s+desk\s+on$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'visual_on' } };
  }
  if (/^(?:turn\s+off|disable|hide)\s+(?:the\s+)?(?:visual\s+)?dj\s+desk$/i.test(lower) || /^dj\s+desk\s+off$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'visual_off' } };
  }
  if (/^(?:next\s+(?:dj\s+)?chapter|drop\s+(?:the\s+)?next\s+chapter)$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'next_chapter' } };
  }
  const eqM = lower.match(/^(?:set\s+|turn\s+on\s+)?(?:eq|equalizer)\s*(?:to)?\s*(studio|bass|vocal|off)$/i);
  if (eqM) {
    return { name: 'ai_dj_control', args: { action: 'eq', value: eqM[1].toLowerCase() } };
  }
  if (/^(?:bass\s+(?:boost\s+)?on|turn\s+on\s+bass)$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'eq', value: 'bass' } };
  }
  if (/^(?:bass\s+off|eq\s+off)$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'eq', value: 'off' } };
  }
  const cfM = lower.match(/^(?:set\s+)?crossfade\s*(?:to)?\s*(\d{1,2})\s*s?$/i);
  if (cfM) {
    return { name: 'ai_dj_control', args: { action: 'crossfade', value: cfM[1] } };
  }
  if (/^(?:lyrics?\s+on|show\s+lyrics?)$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'lyrics_on' } };
  }
  if (/^(?:lyrics?\s+off|hide\s+lyrics?)$/i.test(lower)) {
    return { name: 'ai_dj_control', args: { action: 'lyrics_off' } };
  }

  // Send current video/track to Telegram chat
  if (/^(?:send|upload|drop)\s+(?:this|current)?\s*(?:video|movie|song|track|it)\s+(?:to|in)\s+(?:the\s+)?chat(?:\s+(?:in\s+)?(360p|480p|720p|1080p))?$/i.test(lower)) {
    const qm = lower.match(/(360p|480p|720p|1080p)/i);
    return { name: 'send_current_video_to_chat', args: { ...(qm ? { quality: qm[1].toLowerCase() } : {}) } };
  }

  return null;
}

/**
 * Parse single or chained desk actions deterministically.
 * Only returns parsed steps when EVERY clause resolves cleanly with zero ambiguity.
 */
export function parseDeskIntents(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 260) return null;

  const clauses = raw.split(CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean);
  if (!clauses.length || clauses.length > 6) return null;

  const steps = [];
  for (const clause of clauses) {
    const step = parseSingleClause(clause);
    if (!step) return null;
    steps.push(step);
  }
  return steps.length ? steps : null;
}
