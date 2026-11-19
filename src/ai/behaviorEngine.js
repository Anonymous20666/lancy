/**
 * Human Conversation Behavior Engine for Lancy AI
 *
 * Coordinates six functional intelligence systems over a single shared pipeline:
 *  1. ListeningIntelligence       — addressee distinction, pauses, hesitations, self-corrections, rhetorical, overlaps
 *  2. SocialIntelligence          — emotional/social context, serious vs playful boundaries, tact & de-escalation
 *  3. ConversationStateManager    — topic stacks/branches, speaker-to-statement links, pending proposals, references
 *  4. ConversationalExpression    — dynamic length, delivery style, natural transitions, anti-repetition guard
 *  5. IntentResolver              — speech-act classification, confidence, ambiguity/clarification & ask-first gates
 *  6. GroupParticipationController + SelfMonitor + CrossSurfaceContextManager
 */
import { normalizeDisplayName } from './userProfile.js';

export const PARTICIPATION_POLICIES = {
  PASSIVE: 'passive',     // Passive listening only (also normalizes legacy 'quiet')
  REACTIVE: 'reactive',   // Answers direct/unresolved requests & confirmations; minimal unsolicited talk
  BALANCED: 'balanced',   // Default balanced co-host: joins when relevant, stays silent on human side-chat
  LIVELY: 'lively'        // Highly engaging co-host with tighter cooldowns
};

export const RULE_PRIORITY = {
  SAFETY_PRIVACY_PERMISSIONS: 1,
  IMMEDIATE_SPEECH_INTERRUPTION: 2,
  CRITICAL_MEDIA_CONTROL: 3,
  DIRECTLY_ADDRESSED_REQUEST: 4,
  UNRESOLVED_QUESTION: 5,
  RELEVANT_SOCIAL_REACTION: 6,
  PROACTIVE_ENGAGEMENT: 7,
  OPTIONAL_OBSERVATION: 8
};

const POLICY_ALIASES = {
  quiet: PARTICIPATION_POLICIES.PASSIVE,
  passive: PARTICIPATION_POLICIES.PASSIVE,
  reactive: PARTICIPATION_POLICIES.REACTIVE,
  balanced: PARTICIPATION_POLICIES.BALANCED,
  lively: PARTICIPATION_POLICIES.LIVELY
};

const STOP_SPEAKING_RE = /^(?:lancy[,\s]+)?(?:stop\s+talking|shut\s+up|be\s+quiet|hold\s+on\s+lancy|wait\s+stop|quiet\s+for\s+a\s+sec|pause\s+talking|stop\s+speaking)[.!?\s]*$/i;
const SIMPLE_ACK_RE = /^(?:yeah|yep|yup|yes|right|true|fair|gotcha|got\s+it|okay|ok|alright|sure|cool|mhmm|uh-?huh|word|bet|sharp|abi|na\s+so)[.!?\s]*$/i;
const CANCEL_INTENT_RE = /^(?:actually[,\s]+)?(?:don'?t|never\s*mind|nevermind|scratch\s+that|forget\s+(?:that|it)|cancel\s+(?:that|it)|not\s+that\s+one|leave\s+it|no[,\s]+wait|stop\s+that)[.!?\s]*$/i;
const CONFIRM_INTENT_RE = /^(?:(?:yeah|yep|yup|yes|ok|okay|sure|alright)[,\s]+)*(?:yeah|yep|yup|yes|let'?s\s+go\s+with\s+(?:it|that)|go\s+ahead|do\s+(?:it|that)|sounds\s+good|sure|alright|o\s*ya|abeg\s+do\s+am|yes\s+please|please\s+do|lock\s+it\s+in)[.!?\s]*$/i;
const PASSIVE_REACTION_RE = /^(?:damn|crazy|wild|lol+|lmao+|haha+|nice|cool|oh+|ohh+|wtf|bruh|fr|for\s+real|no\s+way|sheesh|omo+|chai|ehen|hmm+|uh+|ah+|eish)[.!?\s]*$/i;
const HESITATION_OR_THINKING_RE = /(?:^|\s)(?:um+|uh+|erm+|hmm+|wait\s+let\s+me\s+think|where\s+did\s+i|how\s+do\s+i\s+put\s+this|let\s+me\s+see)\b|[…]{1}$|\.\.\.$/i;
const RHETORICAL_RE = /\b(?:can\s+you\s+believe\s+(?:this|that)|who\s+even\s+does\s+that|why\s+is\s+(?:life|monday|everything)\s+like\s+this|what\s+(?:the\s+heck|on\s+earth|kind\s+of\s+day)|is\s+it\s+just\s+me\s+or)\b/i;
const SELF_CORRECTION_RE = /\b(?:actually(?:[,\s]+(?:wait(?:[,\s]+no)?|forget|scratch|no|make\s+it|play|nevermind))?|wait[,\s]+no|i\s+mean|rather|sorry[,\s]+i\s+meant)(?:[:,\s]+|$)/i;

const SOCIAL_SIGNAL_RULES = [
  { key: 'anger_tension', serious: true, re: /\b(?:pissed|furious|shut\s+the\s+fuck|wtf\s+is\s+wrong\s+with\s+you|hate\s+you|stupid\s+bot|useless|stop\s+it\s+now|arguing|calm\s+down)\b/i },
  { key: 'sadness_bad_news', serious: true, re: /\b(?:died|passed\s+away|funeral|hospital|sick|lost\s+my\s+job|failed\s+the|broke\s+up|heartbroken|depressed|grief|crying|bad\s+news|rough\s+day|terrible\s+news|condolences)\b/i },
  { key: 'frustration', serious: true, re: /\b(?:annoying|frustrat(?:ed|ing)|nothing\s+works|keeps\s+(?:breaking|failing)|this\s+is\s+slow|not\s+replying|tired\s+of\s+this|ugh+|stuck\s+for\s+hours)\b/i },
  { key: 'serious_personal', serious: true, re: /\b(?:honestly\s+i'?m\s+scared|struggling\s+with|personal\s+issue|family\s+problem|mental\s+health|stressing\s+me\s+out|need\s+real\s+advice|seriously\s+though)\b/i },
  { key: 'embarrassment', serious: true, re: /\b(?:embarrass(?:ed|ing)|awkward|my\s+bad\s+y'?all|wish\s+i\s+didn'?t\s+say|cringe|so\s+shy)\b/i },
  { key: 'disappointment', serious: false, re: /\b(?:disappoint(?:ed|ing)|bummer|let\s+down|expected\s+better|getting\s+boring|becoming\s+boring)\b/i },
  { key: 'joy_celebration', serious: false, re: /\b(?:got\s+the\s+job|passed\s+my|graduated|engaged|married|won\s+the|celebrat(?:e|ing)|promo(?:tion|ted)|congrats|congratulations|big\s+win|finally\s+made\s+it)\b/i },
  { key: 'excitement', serious: false, re: /\b(?:yo+!?|let'?s\s+go+!?|hyped|fire+|banger|obsessed|amazing|insane|omg|just\s+bought\s+a\s+new|wait\s+look\s+at\s+this)\b/i },
  { key: 'sarcasm_teasing', serious: false, re: /\b(?:yeah\s+right|totally\s+not|oh\s+great|mr\.?\s+genius|sure\s+bro|look\s+at\s+this\s+guy|you\s+wish|cope\s+harder|nah\s+bro\s+got\s+cooked)\b/i },
  { key: 'playful_humor', serious: false, re: /\b(?:lol+|lmao+|haha+|jk|just\s+kidding|roast|banter|joking|funny|clown(?:ing)?|mumu|abeg\s+rest)\b/i },
  { key: 'disagreement', serious: false, re: /\b(?:i\s+disagree|nah\s+i\s+don'?t\s+think\s+so|that'?s\s+not\s+true|wrong\s+about\s+that|actually\s+no|cap\b|overrated)\b/i },
  { key: 'confusion', serious: false, re: /\b(?:confused|what\s+do\s+you\s+mean|wait\s+what\??|makes\s+no\s+sense|don'?t\s+get\s+it|lost\s+me)\b/i },
  { key: 'surprise', serious: false, re: /\b(?:wait\s+seriously\??|no\s+way!?|for\s+real\??|are\s+you\s+serious|shocked|didn'?t\s+expect)\b/i },
  { key: 'curiosity', serious: false, re: /\b(?:curious|wonder\s+why|how\s+does|what\s+if|tell\s+me\s+more|who\s+sang|which\s+one)\b/i },
  { key: 'uncertainty', serious: false, re: /\b(?:maybe|not\s+sure|i\s+guess|kind\s+of|sort\s+of|perhaps|might\s+be|either\s+way)\b/i }
];

const SHARE_FOLLOWUP_RE = /\b(?:i\s+just\s+(?:bought|got|started|finished|moved|landed|found|watched|heard)|guess\s+what|funny\s+thing\s+happened|something\s+crazy\s+happened)\b/i;
const DIRECT_MEDIA_CMD_RE = /^(?:lancy[,\s]+)?(?:play|pause|resume|skip|next|previous|prev|stop|leave|mute|unmute|shuffle|loop|set\s+volume|turn\s+(?:up|down)\s+the?\s*volume|seek\s+to|jump\s+to)\b/i;
const INDIRECT_MEDIA_RE = /\b(?:something\s+(?:more\s+)?(?:energetic|chill|calm|loud|upbeat|afrobeats|sad|hype)|this\s+(?:song|track|music|movie|video)\s+is\s+(?:getting\s+boring|too\s+slow|dead|trash)|put\s+on\s+some|vibe\s+check|switch\s+the\s+vibe|play\s+something\s+like)\b/i;
const QUESTION_START_RE = /^(?:what|who|why|how|when|where|which|can|could|would|will|did|do|does|is|are|was|were|have|has|should|anybody|anyone|wait\s+what)\b/i;

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tokenOverlap(a, b) {
  const ta = new Set(String(a || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const tb = new Set(String(b || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

// ──────────────────────────────────────────────────────────────────────────────
// SYSTEM 1 — LISTENING INTELLIGENCE
// ──────────────────────────────────────────────────────────────────────────────
export class ListeningIntelligence {
  analyze({
    text = '',
    surface = 'dm_text',
    isDirectlyAddressed = false,
    conversationMode = 'IDLE',
    lowConfidence = false,
    simultaneousSpeakers = [],
    participants = [],
    recentTurns = [],
    pendingProposal = null,
    senderName = ''
  } = {}) {
    const clean = normalizeText(text);
    const mentionsLancy = /\b(?:lancy|dj)\b/i.test(clean);
    const isDm = surface === 'dm_text' || surface === 'dm_voice';
    const hasPending = Boolean(pendingProposal && pendingProposal.expiresAt > Date.now());

    // Detect speaker addressing a human participant by name (not Lancy)
    const participantNames = new Set(
      [
        ...(participants || []).map((p) => p?.display_name || p?.name || p?.first_name).filter(Boolean),
        ...(recentTurns || []).map((t) => t?.role === 'user' ? t.speakerName : null).filter(Boolean)
      ]
        .map((n) => String(n).trim().split(/\s+/)[0])
        .filter((n) => n && n.length >= 2 && !/^(?:lancy|member|speaker|user)$/i.test(n) && n.toLowerCase() !== String(senderName || '').trim().split(/\s+/)[0].toLowerCase())
    );

    let addressedParticipant = null;
    if (!mentionsLancy) {
      for (const name of participantNames) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^(?:hey|hi|yo|wait|bro|sis|abeg)?[\\s,]*${esc}[,:\\s]|\\b(?:ask|tell|@)${esc}\\b`, 'i').test(clean)) {
          addressedParticipant = name;
          break;
        }
      }
    }

    // Mid-sentence self-correction extraction
    let hasSelfCorrection = false;
    let correctedClause = clean;
    const corrM = clean.match(SELF_CORRECTION_RE);
    if (corrM && typeof corrM.index === 'number') {
      const after = clean.slice(corrM.index + corrM[0].length).trim();
      if (after.length >= 2) {
        hasSelfCorrection = true;
        correctedClause = after;
      } else if (CANCEL_INTENT_RE.test(clean)) {
        hasSelfCorrection = true;
      }
    }

    const isHesitation = HESITATION_OR_THINKING_RE.test(clean);
    const isRhetorical = RHETORICAL_RE.test(clean) && !mentionsLancy && !isDm;
    const isAckOnly = SIMPLE_ACK_RE.test(clean);
    const isReactionOnly = PASSIVE_REACTION_RE.test(clean);
    const isStop = STOP_SPEAKING_RE.test(clean);

    // Repetition detection: similar question asked recently without answer
    const recentUserTurns = (recentTurns || []).filter((t) => t?.role === 'user').slice(-5);
    const isRepetition = Boolean(
      clean.length >= 6
      && recentUserTurns.some((t) => tokenOverlap(t.text, clean) >= 0.68)
    );

    let target = 'group_broadcast';
    if (isStop || isDirectlyAddressed || mentionsLancy || isDm) {
      target = 'direct_to_lancy';
    } else if (addressedParticipant) {
      target = 'person_to_person';
    } else if (simultaneousSpeakers.length >= 2 && conversationMode === 'IDLE') {
      target = 'person_to_person';
    } else if (hasPending && (CONFIRM_INTENT_RE.test(clean) || CANCEL_INTENT_RE.test(clean))) {
      target = 'indirect_to_lancy';
    } else if (INDIRECT_MEDIA_RE.test(clean) || conversationMode !== 'IDLE') {
      target = 'indirect_to_lancy';
    } else if (hasSelfCorrection && conversationMode !== 'IDLE') {
      target = 'correction_or_pivot';
    } else if (isReactionOnly) {
      target = 'reaction_only';
    } else if (isRhetorical) {
      target = 'rhetorical';
    } else if (isHesitation && clean.split(/\s+/).length <= 5) {
      target = 'thinking_aloud';
    } else if (isAckOnly) {
      target = 'acknowledgement_only';
    }

    const shouldWaitForFinish = Boolean(
      !isStop
      && !isDirectlyAddressed
      && !isDm
      && surface.startsWith('vc_')
      && isHesitation
      && /(?:\.\.\.|…|\b(?:um+|uh+|erm+|and|so|because|wait)\s*)$/i.test(clean)
    );

    return {
      cleanText: clean,
      effectiveText: correctedClause,
      target,
      addressedParticipant,
      mentionsLancy,
      lowConfidence: Boolean(lowConfidence),
      simultaneousCount: Array.isArray(simultaneousSpeakers) ? simultaneousSpeakers.length : 0,
      hasSelfCorrection,
      isHesitation,
      isRhetorical,
      isRepetition,
      isAckOnly,
      isReactionOnly,
      isStopSpeaking: isStop,
      shouldWaitForFinish,
      needsShortAck: Boolean(isAckOnly && conversationMode !== 'IDLE' && !hasPending)
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SYSTEM 2 — SOCIAL INTELLIGENCE
// ──────────────────────────────────────────────────────────────────────────────
export class SocialIntelligence {
  analyze({ text = '', recentTurns = [], groupMood = 'neutral' } = {}) {
    const clean = normalizeText(text);
    let primarySignal = 'neutral';
    let isSeriousContext = false;
    const matched = [];

    for (const rule of SOCIAL_SIGNAL_RULES) {
      if (rule.re.test(clean)) {
        matched.push(rule);
        if (primarySignal === 'neutral') {
          primarySignal = rule.key;
          isSeriousContext = rule.serious;
        } else if (rule.serious) {
          isSeriousContext = true;
        }
      }
    }

    // Check if an earlier playful conversation just turned serious
    const hadPlayfulRecent = (recentTurns || []).slice(-4).some((t) =>
      /\b(?:lol+|lmao+|haha+|jk|roast|banter|joking)\b/i.test(String(t?.text || ''))
    );
    const shiftedToSerious = Boolean(isSeriousContext && (hadPlayfulRecent || groupMood === 'joking'));

    // Also inspect recent group tension / conflict across turns
    const recentTension = (recentTurns || []).slice(-3).filter((t) =>
      /\b(?:disagree|stop|annoying|wrong|shut\s+up|pissed|argument|serious)\b/i.test(String(t?.text || ''))
    ).length >= 2;
    if (recentTension && primarySignal === 'neutral') {
      primarySignal = 'anger_tension';
      isSeriousContext = true;
    }

    let tone = 'natural_chill';
    let guidance = 'Keep natural co-host presence matching speaker pace.';
    if (primarySignal === 'anger_tension' || recentTension) {
      tone = 'deescalate_steady';
      guidance = 'De-escalate calmly without defensiveness, jokes, or taking sides aggressively.';
    } else if (primarySignal === 'sadness_bad_news' || primarySignal === 'serious_personal') {
      tone = 'empathetic_calm';
      guidance = 'Prioritize genuine warmth, empathy, and supportive listening; avoid jokes or assumptions about private feelings.';
    } else if (primarySignal === 'frustration') {
      tone = 'tactful_supportive';
      guidance = 'Acknowledge the frustration directly and help solve or ease it cleanly without forced humor.';
    } else if (primarySignal === 'embarrassment') {
      tone = 'tactful_supportive';
      guidance = 'Move past the awkward moment gracefully; do not highlight or tease about the mistake.';
    } else if (primarySignal === 'joy_celebration' || primarySignal === 'excitement') {
      tone = 'warm_celebratory';
      guidance = 'Match genuine conversational enthusiasm naturally and follow up with interest.';
    } else if (primarySignal === 'disagreement') {
      tone = 'grounded_respectful';
      guidance = 'Engage respectfully, explain your perspective concisely without becoming defensive.';
    } else if (primarySignal === 'playful_humor' || primarySignal === 'sarcasm_teasing') {
      tone = 'playful_witty';
      guidance = 'Light wit or tasteful humor is welcome; avoid repetitive or mean-spirited targeting.';
    } else if (primarySignal === 'curiosity' || primarySignal === 'confusion' || primarySignal === 'surprise') {
      tone = 'curious_engaged';
      guidance = 'Match curiosity or clarify clearly and directly.';
    }

    const allowHumor = !isSeriousContext && !recentTension && !['sadness_bad_news', 'frustration', 'anger_tension', 'serious_personal', 'embarrassment'].includes(primarySignal);
    const allowTeasing = allowHumor && (primarySignal === 'playful_humor' || primarySignal === 'sarcasm_teasing');

    return {
      signal: primarySignal,
      signals: matched.map((m) => m.key),
      isSeriousContext,
      shiftedToSerious,
      recentTension,
      tone,
      allowHumor,
      allowTeasing,
      deescalate: primarySignal === 'anger_tension' || recentTension,
      neverClaimPrivateCertainty: true,
      guidance
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SYSTEM 3 — CONVERSATION STATE MANAGER & TOPIC TRACKER
// ──────────────────────────────────────────────────────────────────────────────
export class ConversationStateManager {
  constructor({ memory = null } = {}) {
    this.memory = memory;
    this.states = new Map();
  }

  getState(sessionKey, { chatId = 0, surface = 'vc' } = {}) {
    const key = String(sessionKey || `${surface}:${Number(chatId) || 0}`);
    if (!this.states.has(key)) {
      this.states.set(key, {
        sessionKey: key,
        chatId: Number(chatId) || 0,
        surface,
        currentTopic: null,
        topicBranches: [],      // stack of { topic, interruptedAt, lastStatement }
        recentConclusions: [],
        pendingProposal: null,  // { type, description, query, action, proposedAt, expiresAt }
        expectedFollowUp: null, // { userId, speakerName, topicHint, ts }
        speakerTurnsWindow: [], // lightweight recent turn window with timestamps & social mood
        ignoredQuestions: [],   // questions unanswered across >=2 turns
        lastProactiveAt: 0
      });
    }
    if (this.states.size > 400) {
      const oldest = this.states.keys().next().value;
      this.states.delete(oldest);
    }
    return this.states.get(key);
  }

  inferTopic(text, fallback = null) {
    const clean = normalizeText(text).replace(/\b(?:forget|pause|drop|stop|skip)\s+(?:the\s+)?[a-z0-9 ]{2,24}\s+(?:talk|topic|stuff|subject)\b/gi, '');
    if (clean.length < 4) return fallback;
    if (/\b(?:laptop|pc|macbook|lenovo|legion|gpu|phone|iphone|android|tech|code|coding|bug|api|python|node|server)\b/i.test(clean)) return 'Tech & Gear';
    if (/\b(?:movie|film|series|season|episode|horror|thriller|netflix|cinema|anime|avatar|watch)\b/i.test(clean)) return 'Movies & Series';
    if (/\b(?:song|music|track|album|artist|burna|wizkid|davido|rema|asake|afrobeats|amapiano|beat|remix|lyrics|dj)\b/i.test(clean)) return 'Music & Vibe';
    if (/\b(?:work|job|interview|school|exam|business|money|life|family|health|stress|relationship)\b/i.test(clean)) return 'Life & Personal';
    if (/\b(?:football|match|premier\s+league|champions|nba|news|latest|today|weather|crypto)\b/i.test(clean)) return 'News & World';
    return fallback;
  }

  updateWithUserTurn(sessionKey, { chatId = 0, surface = 'vc', userId = null, speakerName = 'Speaker', text = '', social = null, listening = null } = {}) {
    const st = this.getState(sessionKey, { chatId, surface });
    const clean = normalizeText(text);
    const topicText = listening?.effectiveText || clean;
    const now = Date.now();
    const cleanSpeaker = normalizeDisplayName(speakerName, 'Member');

    // Topic branching / returning to earlier discussion
    const wantsTopicReturn = /\b(?:go\s+back\s+to|back\s+to\s+(?:that|earlier|what\s+we\s+were|the\s+previous)\s*(?:topic|discussion|thing)?|continue\s+from\s+there|as\s+i\s+was\s+saying)\b/i.test(clean);
    let restoredTopic = null;
    const vcFallbackState = (Number(chatId) < 0 && !String(sessionKey).startsWith('vc:'))
      ? this.states.get(`vc:${Number(chatId)}`)
      : null;
    const sourceBranches = st.topicBranches.length ? st.topicBranches : (vcFallbackState?.topicBranches || []);
    if (wantsTopicReturn && sourceBranches.length > 0) {
      restoredTopic = sourceBranches.pop();
      if (st.currentTopic && st.currentTopic !== restoredTopic.topic) {
        st.topicBranches.push({ topic: st.currentTopic, interruptedAt: now, lastStatement: clean.slice(0, 120) });
      }
      st.currentTopic = restoredTopic.topic;
    } else {
      const detected = this.inferTopic(topicText, null);
      if (detected && st.currentTopic && detected !== st.currentTopic) {
        st.topicBranches.push({
          topic: st.currentTopic,
          interruptedAt: now,
          lastStatement: st.speakerTurnsWindow.at(-1)?.text || ''
        });
        while (st.topicBranches.length > 6) st.topicBranches.shift();
        st.currentTopic = detected;
      } else if (detected && !st.currentTopic) {
        st.currentTopic = detected;
      }
    }

    // Track ignored group questions: any prior question still open after 2 newer user turns
    if (st.ignoredQuestions.length) {
      for (const iq of st.ignoredQuestions) iq.turnsPassed += 1;
      st.ignoredQuestions = st.ignoredQuestions.filter((iq) => (now - iq.ts) < 180000);
    }
    if ((clean.includes('?') || QUESTION_START_RE.test(clean)) && !listening?.isRhetorical && listening?.target !== 'direct_to_lancy') {
      st.ignoredQuestions.push({ speaker: cleanSpeaker, userId, text: clean.slice(0, 160), ts: now, turnsPassed: 0 });
      if (st.ignoredQuestions.length > 4) st.ignoredQuestions.shift();
    }

    if (SHARE_FOLLOWUP_RE.test(clean)) {
      st.expectedFollowUp = { userId, speakerName: cleanSpeaker, topicHint: clean.slice(0, 140), ts: now };
    }

    st.speakerTurnsWindow.push({
      role: 'user',
      userId: userId ? Number(userId) : null,
      speakerName: cleanSpeaker,
      text: clean.slice(0, 320),
      topic: st.currentTopic,
      mood: social?.signal || 'neutral',
      ts: now
    });
    while (st.speakerTurnsWindow.length > 20) st.speakerTurnsWindow.shift();

    // Also pull persisted turns if available
    const memSc = this.memory?.getSessionContext?.(sessionKey, { chatId, surface });
    if (memSc && st.currentTopic && !memSc.currentTopic) {
      memSc.currentTopic = st.currentTopic;
    }

    return {
      state: st,
      restoredTopic,
      staleIgnoredQuestion: st.ignoredQuestions.find((iq) => iq.turnsPassed >= 2) || null
    };
  }

  recordAssistantTurn(sessionKey, { chatId = 0, surface = 'vc', reply = '', proposedAction = null, concluded = false } = {}) {
    const st = this.getState(sessionKey, { chatId, surface });
    const clean = normalizeText(reply);
    const now = Date.now();
    if (clean) {
      st.speakerTurnsWindow.push({ role: 'assistant', speakerName: 'Lancy', text: clean.slice(0, 320), topic: st.currentTopic, ts: now });
      while (st.speakerTurnsWindow.length > 20) st.speakerTurnsWindow.shift();
    }
    // Any assistant turn resolves oldest pending ignored question
    if (st.ignoredQuestions.length) st.ignoredQuestions.shift();
    if (proposedAction) {
      st.pendingProposal = {
        ...proposedAction,
        proposedAt: now,
        expiresAt: now + 180000
      };
    } else if (clean.endsWith('?') && /\b(?:want\s+me\s+to|should\s+i|shall\s+i|switch\s+(?:to|over)|queue\s+up)\b/i.test(clean)) {
      st.pendingProposal = {
        type: 'suggested_action',
        description: clean.slice(0, 180),
        proposedAt: now,
        expiresAt: now + 180000
      };
    }
    if (concluded && st.currentTopic) {
      st.recentConclusions.push({ topic: st.currentTopic, summary: clean.slice(0, 140), ts: now });
      while (st.recentConclusions.length > 5) st.recentConclusions.shift();
      st.pendingProposal = null;
    }
  }

  clearPendingProposal(sessionKey) {
    const st = this.states.get(String(sessionKey));
    if (st) st.pendingProposal = null;
  }

  /**
   * Resolve conversational anaphora & cross-speaker references using real history & active media state.
   */
  resolveReferences({ text = '', sessionKey = '', chatId = 0, surface = 'vc', snapshot = null, restoredTopic = null } = {}) {
    const clean = normalizeText(text);
    const st = this.getState(sessionKey, { chatId, surface });
    const sc = this.memory?.getSessionContext?.(sessionKey, { chatId, surface });
    const vcSc = (Number(chatId) < 0 && !String(sessionKey).startsWith('vc:'))
      ? this.memory?.getSessionContext?.(`vc:${Number(chatId)}`, { chatId, surface: 'vc' })
      : null;
    const mergedMemTurns = [
      ...(vcSc?.speakerTurns || []),
      ...(sc?.speakerTurns || [])
    ].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const turns = (mergedMemTurns.length ? mergedMemTurns : st.speakerTurnsWindow) || [];
    const resolved = [];

    // 1. Named speaker reference: "what did John say earlier", "what was John saying"
    const whoSaidM = clean.match(/\bwhat\s+(?:did|was)\s+([a-z0-9_.-]{2,28})\s+(?:say|saying|mention|talking\s+about)/i);
    if (whoSaidM) {
      const targetName = whoSaidM[1];
      const match = this.memory?.findSpeakerStatement?.(sessionKey, { speakerQuery: targetName, chatId, surface })
        || (vcSc ? this.memory?.findSpeakerStatement?.(`vc:${Number(chatId)}`, { speakerQuery: targetName, chatId, surface: 'vc' }) : null)
        || [...turns].reverse().find((t) => t.role === 'user' && String(t.speakerName || '').toLowerCase().includes(targetName.toLowerCase()));
      if (match) {
        resolved.push({ kind: 'speaker_recall', speaker: match.speakerName, statement: match.text });
      } else {
        resolved.push({ kind: 'speaker_recall_missing', speaker: targetName });
      }
    }

    // 2. Pronoun speaker reference: "what he/she said/mentioned"
    if (/\bwhat\s+(?:he|she|they)\s+(?:said|mentioned|meant)\b/i.test(clean)) {
      const lastHuman = [...turns].reverse().find((t) => t.role === 'user' && !tokenOverlap(t.text, clean));
      if (lastHuman) {
        resolved.push({ kind: 'pronoun_speaker_recall', speaker: lastHuman.speakerName, statement: lastHuman.text });
      }
    }

    // 3. Numbered option / ordinal reference: "the second option", "that first one", "that one", "the other one"
    const ordinalM = clean.match(/\b(?:the\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)\s*(?:one|option|movie|film|song|video|track)?\b/i);
    const ordMap = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
    const idx = ordinalM ? ordMap[ordinalM[1].toLowerCase()] : null;
    const movieResults = snapshot?.lastMovieSearch?.results || [];
    const videoResults = snapshot?.lastVideoSearch?.results || [];
    if (idx) {
      const hitMovie = movieResults[idx - 1];
      const hitVideo = videoResults[idx - 1];
      if (hitMovie) resolved.push({ kind: 'search_option', mediaType: 'movie', index: idx, title: hitMovie.title, id: hitMovie.id });
      else if (hitVideo) resolved.push({ kind: 'search_option', mediaType: 'video', index: idx, title: hitVideo.title, id: hitVideo.id });
    } else if (/\b(?:that\s+one|the\s+other\s+one|the\s+previous\s+one|same\s+as\s+before)\b/i.test(clean)) {
      if (/\b(?:other\s+one)\b/i.test(clean) && (movieResults[1] || videoResults[1])) {
        const alt = movieResults[1] || videoResults[1];
        resolved.push({ kind: 'alternative_option', index: 2, title: alt.title });
      } else if (/\b(?:previous\s+one|same\s+as\s+before)\b/i.test(clean)) {
        const prevTrack = snapshot?.previousTrack || st.recentConclusions.at(-1);
        if (prevTrack) resolved.push({ kind: 'previous_reference', target: prevTrack.title || prevTrack.topic || prevTrack.summary });
      } else if (st.pendingProposal && st.pendingProposal.expiresAt > Date.now()) {
        resolved.push({ kind: 'pending_proposal', description: st.pendingProposal.description });
      }
    }

    // 4. Topic branch return: "go back to that topic", "continue from there"
    if (/\b(?:go\s+back\s+to\s+(?:that|the)\s*(?:topic|discussion)|continue\s+from\s+there|back\s+to\s+what\s+we\s+were)\b/i.test(clean)) {
      const vcState = (Number(chatId) < 0 && !String(sessionKey).startsWith('vc:'))
        ? this.states.get(`vc:${Number(chatId)}`)
        : null;
      const branch = restoredTopic || st.topicBranches.at(-1) || vcState?.topicBranches?.at(-1);
      if (branch) resolved.push({ kind: 'topic_return', topic: branch.topic, snippet: branch.lastStatement });
    }

    // 5. Confirmation or cancellation against pending proposal
    if (st.pendingProposal && st.pendingProposal.expiresAt > Date.now()) {
      if (CONFIRM_INTENT_RE.test(clean)) {
        resolved.push({ kind: 'proposal_confirmed', proposal: st.pendingProposal.description });
      } else if (CANCEL_INTENT_RE.test(clean)) {
        resolved.push({ kind: 'proposal_cancelled', proposal: st.pendingProposal.description });
      }
    }

    return resolved;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SYSTEM 4 — CONVERSATIONAL EXPRESSION
// ──────────────────────────────────────────────────────────────────────────────
export class ConversationalExpression {
  constructor() {
    this.recentAssistantOutputs = new Map();
  }

  recordOutput(sessionKey, reply) {
    const clean = normalizeText(reply);
    if (!clean) return;
    const key = String(sessionKey || 'default');
    const arr = this.recentAssistantOutputs.get(key) || [];
    arr.push(clean);
    while (arr.length > 8) arr.shift();
    this.recentAssistantOutputs.set(key, arr);
  }

  selectExpression({ sessionKey = 'default', surface = 'dm_text', intent = {}, social = {}, listening = {} } = {}) {
    const isVoice = surface.startsWith('vc_');
    let lengthMode = 'short';
    if (listening.needsShortAck || intent.type === 'reaction') {
      lengthMode = 'ack';
    } else if (social.isSeriousContext || intent.complexity === 'complex' || intent.type === 'research_question' || (!isVoice && intent.lengthChars > 140)) {
      lengthMode = isVoice ? 'medium' : 'detailed';
    } else if (social.signal === 'playful_humor' || intent.type === 'joke') {
      lengthMode = 'short';
    }

    const deliveryMap = {
      warm_celebratory: 'excited_warm',
      empathetic_calm: 'soft_reassuring',
      deescalate_steady: 'calm_steady',
      tactful_supportive: 'grounded_calm',
      playful_witty: 'playful_light',
      curious_engaged: 'curious_bright',
      grounded_respectful: 'measured_serious',
      natural_chill: 'relaxed_conversational'
    };

    const prev = this.recentAssistantOutputs.get(String(sessionKey)) || [];
    const recentOpeners = [...new Set(prev.map((r) => r.split(/[,.!?]/)[0]?.trim()).filter((x) => x && x.length <= 32))].slice(-4);

    return {
      lengthMode,
      delivery: deliveryMap[social.tone] || 'relaxed_conversational',
      pacing: lengthMode === 'ack' ? 'snappy' : (social.isSeriousContext ? 'unhurried' : 'natural'),
      avoidRepetitions: recentOpeners,
      allowSpontaneousPause: Boolean(isVoice && lengthMode !== 'ack'),
      avoidCustomerSupportClosing: true
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SYSTEM 5 — INTENT RESOLVER
// ──────────────────────────────────────────────────────────────────────────────
export class IntentResolver {
  resolve({ text = '', listening = {}, resolvedRefs = [], pendingProposal = null, conversationMode = 'IDLE' } = {}) {
    const clean = listening.effectiveText || normalizeText(text);
    const hasPending = Boolean(pendingProposal && pendingProposal.expiresAt > Date.now());

    if (listening.isStopSpeaking) {
      return { type: 'stop_speaking', confidence: 0.99, requiresAction: true, shouldAskFirst: false, complexity: 'simple' };
    }
    if (CANCEL_INTENT_RE.test(clean)) {
      return {
        type: 'cancellation',
        confidence: hasPending ? 0.95 : 0.78,
        requiresAction: hasPending,
        shouldAskFirst: false,
        complexity: 'simple'
      };
    }
    if (CONFIRM_INTENT_RE.test(clean) && (hasPending || conversationMode === 'CLARIFYING')) {
      return { type: 'confirmation', confidence: 0.92, requiresAction: true, shouldAskFirst: false, complexity: 'moderate' };
    }
    if (listening.isReactionOnly || (listening.isAckOnly && !hasPending)) {
      return { type: 'reaction', confidence: 0.9, requiresAction: false, shouldAskFirst: false, complexity: 'none' };
    }
    if (/\b(?:what\s+if|suppose|imagine\s+if|hypothetically)\b/i.test(clean)) {
      return { type: 'hypothetical', confidence: 0.85, requiresAction: false, shouldAskFirst: false, complexity: 'moderate' };
    }
    if (DIRECT_MEDIA_CMD_RE.test(clean) || resolvedRefs.some((r) => r.kind === 'search_option')) {
      return { type: 'media_command', confidence: 0.94, requiresAction: true, shouldAskFirst: false, complexity: 'moderate' };
    }
    if (INDIRECT_MEDIA_RE.test(clean)) {
      const isPureComplaint = /\b(?:becoming\s+boring|getting\s+boring|too\s+slow|this\s+is\s+dead|don'?t\s+like\s+this)\b/i.test(clean)
        && !/\b(?:play|put\s+on|switch|skip|change)\b/i.test(clean);
      return {
        type: isPureComplaint ? 'complaint_feedback' : 'indirect_media_request',
        confidence: isPureComplaint ? 0.78 : 0.82,
        requiresAction: !isPureComplaint,
        shouldAskFirst: isPureComplaint,
        complexity: 'moderate'
      };
    }
    if (/\b(?:latest|news|release\s+date|who\s+won|who\s+is|search|look\s+up|research|compare|analyze|explain)\b/i.test(clean)) {
      return { type: 'research_question', confidence: 0.88, requiresAction: true, shouldAskFirst: false, complexity: 'complex' };
    }
    if (clean.includes('?') || QUESTION_START_RE.test(clean)) {
      return { type: 'question', confidence: 0.86, requiresAction: false, shouldAskFirst: false, complexity: clean.length > 110 ? 'complex' : 'moderate' };
    }
    if (SHARE_FOLLOWUP_RE.test(clean)) {
      return { type: 'social_share', confidence: 0.85, requiresAction: false, shouldAskFirst: false, complexity: 'simple' };
    }
    if (/\b(?:maybe\s+we\s+could|how\s+about|we\s+should\s+probably)\b/i.test(clean)) {
      return { type: 'suggestion', confidence: 0.76, requiresAction: false, shouldAskFirst: true, complexity: 'moderate' };
    }
    return {
      type: 'statement',
      confidence: listening.lowConfidence ? 0.35 : 0.75,
      requiresAction: false,
      shouldAskFirst: false,
      complexity: clean.length > 140 ? 'complex' : 'simple',
      lengthChars: clean.length
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 6 & 7 — GROUP PARTICIPATION CONTROLLER, SELF-MONITOR & CROSS-SURFACE
// ──────────────────────────────────────────────────────────────────────────────
export class GroupParticipationController {
  constructor({ defaultPolicy = PARTICIPATION_POLICIES.BALANCED, cooldownMs = 60000 } = {}) {
    this.defaultPolicy = POLICY_ALIASES[defaultPolicy] || PARTICIPATION_POLICIES.BALANCED;
    this.cooldownMs = cooldownMs;
    this.policiesByChat = new Map();
    this.lastProactiveByChat = new Map();
  }

  setPolicy(chatId, policy) {
    const norm = POLICY_ALIASES[String(policy || '').trim().toLowerCase()] || PARTICIPATION_POLICIES.BALANCED;
    this.policiesByChat.set(Number(chatId) || 0, norm);
    return norm;
  }

  getPolicy(chatId) {
    return this.policiesByChat.get(Number(chatId) || 0) || this.defaultPolicy;
  }

  evaluate({ chatId = 0, surface = 'dm_text', listening = {}, social = {}, intent = {}, state = null, conversationMode = 'IDLE', nowPlayingTitle = null, activeSpeakerSpeaking = false, staleIgnoredQuestion = null } = {}) {
    const policy = this.getPolicy(chatId);
    const isGroupSurface = Number(chatId) < 0 && surface !== 'dm_text';

    // Rule Priority #2: Immediate interruption / stop speaking always acts immediately
    if (listening.isStopSpeaking) {
      return { speak: false, cancelSpeech: true, mode: 'silent', reason: 'stop_speaking_requested', priority: RULE_PRIORITY.IMMEDIATE_SPEECH_INTERRUPTION };
    }

    // Wait while speaker is visibly mid-hesitation/mid-thought on voice unless directly addressed
    if (listening.shouldWaitForFinish) {
      return { speak: false, mode: 'wait_for_finish', reason: 'speaker_mid_thought', priority: RULE_PRIORITY.IMMEDIATE_SPEECH_INTERRUPTION };
    }

    // Rule Priority #3/#4: Directly addressed, DM, or active clarification/proposal confirmation
    if (listening.target === 'direct_to_lancy' || surface === 'dm_text') {
      return {
        speak: true,
        mode: listening.lowConfidence ? 'clarify' : 'reply',
        reason: 'directly_addressed',
        priority: intent.type === 'media_command' ? RULE_PRIORITY.CRITICAL_MEDIA_CONTROL : RULE_PRIORITY.DIRECTLY_ADDRESSED_REQUEST
      };
    }

    if (listening.target === 'indirect_to_lancy' && conversationMode !== 'IDLE') {
      return {
        speak: true,
        mode: listening.needsShortAck ? 'ack' : 'reply',
        reason: 'active_conversation_continuation',
        priority: RULE_PRIORITY.DIRECTLY_ADDRESSED_REQUEST
      };
    }

    if (!isGroupSurface) {
      return { speak: true, mode: 'reply', reason: 'private_dm', priority: RULE_PRIORITY.DIRECTLY_ADDRESSED_REQUEST };
    }

    // Group social boundaries when IDLE:
    if (listening.target === 'person_to_person') {
      return { speak: false, mode: 'silent', reason: 'person_to_person_dialogue', priority: RULE_PRIORITY.OPTIONAL_OBSERVATION };
    }
    if (listening.target === 'thinking_aloud' || listening.target === 'reaction_only' || listening.target === 'rhetorical') {
      return { speak: false, mode: 'silent', reason: `idle_${listening.target}`, priority: RULE_PRIORITY.OPTIONAL_OBSERVATION };
    }

    if (policy === PARTICIPATION_POLICIES.PASSIVE) {
      return { speak: false, mode: 'silent', reason: 'passive_policy', priority: RULE_PRIORITY.OPTIONAL_OBSERVATION };
    }
    if (policy === PARTICIPATION_POLICIES.REACTIVE && conversationMode === 'IDLE') {
      return { speak: false, mode: 'silent', reason: 'reactive_policy_idle', priority: RULE_PRIORITY.OPTIONAL_OBSERVATION };
    }

    // Check cooldown before any proactive/social interjection
    const now = Date.now();
    const lastAt = this.lastProactiveByChat.get(Number(chatId) || 0) || 0;
    const requiredWait = policy === PARTICIPATION_POLICIES.LIVELY ? Math.floor(this.cooldownMs * 0.45) : this.cooldownMs;
    const cooldownOk = !activeSpeakerSpeaking && (now - lastAt >= requiredWait);

    // Rule Priority #5: Rescuing an ignored group question cleanly (balanced/lively)
    if (staleIgnoredQuestion && cooldownOk && !social.isSeriousContext) {
      return {
        speak: true,
        mode: 'proactive',
        reason: 'answer_ignored_participant_question',
        targetQuestion: staleIgnoredQuestion,
        priority: RULE_PRIORITY.UNRESOLVED_QUESTION
      };
    }

    // Rule Priority #6: De-escalation or serious social boundary check
    if (social.deescalate && cooldownOk && policy !== PARTICIPATION_POLICIES.PASSIVE) {
      return { speak: true, mode: 'deescalate', reason: 'group_conflict_deescalation', priority: RULE_PRIORITY.RELEVANT_SOCIAL_REACTION };
    }

    // Never interrupt serious group chat to drop a joke or random trivia
    if (social.isSeriousContext) {
      return { speak: false, mode: 'silent', reason: 'respect_serious_group_discussion', priority: RULE_PRIORITY.RELEVANT_SOCIAL_REACTION };
    }

    // Rule Priority #7: Proactive DJ / media or group humor/celebration entry point
    const touchesMedia = Boolean(nowPlayingTitle) && (INDIRECT_MEDIA_RE.test(listening.cleanText || '') || /\b(?:this\s+(?:song|track|movie|film|scene)|vibe|what(?:'s|s)\s+playing)\b/i.test(listening.cleanText || ''));
    const celebratoryMoment = social.signal === 'joy_celebration' || (social.signal === 'playful_humor' && policy === PARTICIPATION_POLICIES.LIVELY);

    if ((touchesMedia || celebratoryMoment) && cooldownOk) {
      return {
        speak: true,
        mode: 'proactive',
        reason: touchesMedia ? 'proactive_media_relevance' : 'proactive_social_celebration',
        priority: RULE_PRIORITY.PROACTIVE_ENGAGEMENT
      };
    }

    return { speak: false, mode: 'silent', reason: 'balanced_listening_restraint', priority: RULE_PRIORITY.OPTIONAL_OBSERVATION };
  }

  markProactiveSpoken(chatId) {
    this.lastProactiveByChat.set(Number(chatId) || 0, Date.now());
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// COORDINATED BEHAVIOR ENGINE
// ──────────────────────────────────────────────────────────────────────────────
export class HumanBehaviorEngine {
  constructor({ memory = null, db = null } = {}) {
    this.memory = memory;
    this.db = db;
    this.listening = new ListeningIntelligence();
    this.social = new SocialIntelligence();
    this.conversation = new ConversationStateManager({ memory });
    this.expression = new ConversationalExpression();
    this.intent = new IntentResolver();
    this.group = new GroupParticipationController();
  }

  setParticipationPolicy(chatId, policy) {
    const cid = Number(chatId) || 0;
    const norm = this.group.setPolicy(cid, policy);
    if (cid) this.db?.setSetting?.(`voiceai.proactive.${cid}`, norm);
    return norm;
  }

  getParticipationPolicy(chatId) {
    const cid = Number(chatId) || 0;
    const saved = cid ? this.db?.getSetting?.(`voiceai.proactive.${cid}`, null) : null;
    if (saved) return POLICY_ALIASES[String(saved).toLowerCase()] || this.group.getPolicy(cid);
    return this.group.getPolicy(cid);
  }

  /**
   * Full behavioral analysis pipeline (<2ms deterministic) for any incoming VC/Group/DM event.
   */
  analyzeTurn({
    chatId = 0,
    userId = null,
    senderName = 'Member',
    surface = 'dm_text',
    sessionKey = null,
    text = '',
    isDirectlyAddressed = false,
    conversationMode = 'IDLE',
    lowConfidence = false,
    simultaneousSpeakers = [],
    activeSpeakerSpeaking = false,
    participants = [],
    snapshot = null
  } = {}) {
    const cid = Number(chatId || 0);
    const key = String(sessionKey || (cid > 0 ? `dm:${Number(userId) || cid}` : `vc:${cid}`));
    const st = this.conversation.getState(key, { chatId: cid, surface });

    // Sync persisted policy if present
    if (cid) {
      const persisted = this.db?.getSetting?.(`voiceai.proactive.${cid}`, null);
      if (persisted) this.group.setPolicy(cid, persisted);
    }

    // 1. Listening Intelligence
    const listen = this.listening.analyze({
      text,
      surface,
      isDirectlyAddressed,
      conversationMode,
      lowConfidence,
      simultaneousSpeakers,
      participants,
      recentTurns: st.speakerTurnsWindow,
      pendingProposal: st.pendingProposal,
      senderName
    });

    // 2. Social Intelligence
    const social = this.social.analyze({
      text: listen.cleanText,
      recentTurns: st.speakerTurnsWindow,
      groupMood: st.speakerTurnsWindow.at(-1)?.mood === 'playful_humor' ? 'joking' : 'neutral'
    });

    // 3. Conversation State & Topic Tracker
    const stateUpdate = this.conversation.updateWithUserTurn(key, {
      chatId: cid,
      surface,
      userId,
      speakerName: senderName,
      text: listen.cleanText,
      social,
      listening: listen
    });

    // 4. Contextual Reference Resolution
    const resolvedRefs = this.conversation.resolveReferences({
      text: listen.cleanText,
      sessionKey: key,
      chatId: cid,
      surface,
      snapshot,
      restoredTopic: stateUpdate.restoredTopic
    });

    // 5. Intent Resolution
    const intent = this.intent.resolve({
      text: listen.cleanText,
      listening: listen,
      resolvedRefs,
      pendingProposal: st.pendingProposal,
      conversationMode
    });

    if (intent.type === 'cancellation') {
      this.conversation.clearPendingProposal(key);
    }

    // 6. Group Participation & Self-Monitoring Check
    const participation = this.group.evaluate({
      chatId: cid,
      surface,
      listening: listen,
      social,
      intent,
      state: st,
      conversationMode,
      nowPlayingTitle: snapshot?.nowPlaying?.title || null,
      activeSpeakerSpeaking,
      staleIgnoredQuestion: stateUpdate.staleIgnoredQuestion
    });

    // 7. Expression Profile & Cross-Surface Context
    const expression = this.expression.selectExpression({
      sessionKey: key,
      surface,
      intent,
      social,
      listening: listen
    });

    const crossSurface = this.buildCrossSurfaceContext({ chatId: cid, userId, surface, key });

    // 8. 12-Question Self-Monitor Digest
    const selfMonitor = {
      whatIsHappening: `${intent.type} (${social.signal})`,
      whoIsSpeaking: normalizeDisplayName(senderName, 'Member'),
      whoIsAddressed: listen.addressedParticipant || (listen.target === 'direct_to_lancy' ? 'Lancy' : listen.target),
      actualIntention: intent.type,
      responseExpected: participation.speak,
      otherSpeakerActive: Boolean(listeningIsWait(listen, activeSpeakerSpeaking)),
      isSeriousSituation: social.isSeriousContext,
      relevantToTools: intent.requiresAction,
      actionNecessary: intent.requiresAction && !intent.shouldAskFirst,
      clarificationNeeded: Boolean(listen.lowConfidence || resolvedRefs.some((r) => r.kind === 'speaker_recall_missing')),
      responseStyle: `${expression.lengthMode}/${expression.delivery}`,
      rulePriority: participation.priority
    };

    return {
      sessionKey: key,
      listening: listen,
      social,
      intent,
      participation,
      expression,
      resolvedReferences: resolvedRefs,
      topic: st.currentTopic,
      restoredTopic: stateUpdate.restoredTopic,
      pendingProposal: st.pendingProposal,
      expectedFollowUp: st.expectedFollowUp,
      crossSurface,
      selfMonitor,
      promptDirective: this.formatPromptDirective({
        listening: listen,
        social,
        intent,
        expression,
        resolvedRefs,
        state: st,
        restoredTopic: stateUpdate.restoredTopic,
        crossSurface,
        selfMonitor
      })
    };
  }

  recordOutcome({ sessionKey, chatId = 0, surface = 'vc', reply = '', proposedAction = null, concluded = false } = {}) {
    const key = String(sessionKey || `vc:${Number(chatId) || 0}`);
    this.conversation.recordAssistantTurn(key, { chatId, surface, reply, proposedAction, concluded });
    this.expression.recordOutput(key, reply);
  }

  buildCrossSurfaceContext({ chatId = 0, userId = null, surface = 'dm_text', key = '' } = {}) {
    const cid = Number(chatId || 0);
    const includePrivate = surface === 'dm_text' && cid > 0;
    const links = [];
    // If chatting in DM and user also participated in a VC/group recently, or vice-versa (non-private only in group!)
    if (this.memory && cid < 0) {
      const vcSc = this.memory.getSessionContext(`vc:${cid}`, { chatId: cid, surface: 'vc' });
      if (vcSc?.currentTopic && !key.startsWith('vc:')) {
        links.push(`Active VC/Group Topic: ${vcSc.currentTopic}`);
      }
      if (vcSc?.speakerTurns?.length && surface === 'group_text') {
        const lastVc = vcSc.speakerTurns.filter((t) => t.surface === 'vc_voice').slice(-2);
        if (lastVc.length) {
          links.push(`Recent Spoken VC Exchange: ${lastVc.map((t) => `${t.speakerName}: "${t.text.slice(0, 80)}"`).join(' | ')}`);
        }
      }
    }
    return {
      includePrivateMemories: includePrivate,
      links
    };
  }

  formatPromptDirective({ listening, social, intent, expression, resolvedRefs, state, restoredTopic, crossSurface } = {}) {
    const lines = [
      `BEHAVIORAL DIRECTIVE: addressee=${listening.target}, intent=${intent.type} (conf=${intent.confidence.toFixed(2)}), social=${social.signal} (${social.tone}), allowHumor=${social.allowHumor}, delivery=${expression.delivery}, length=${expression.lengthMode}.`,
      `Social Guidance: ${social.guidance}`
    ];
    if (state?.currentTopic) lines.push(`Active Topic: ${state.currentTopic}${state.topicBranches?.length ? ` (prior paused topics: ${state.topicBranches.slice(-2).map((b) => b.topic).join(', ')})` : ''}.`);
    if (restoredTopic) lines.push(`Speaker is returning to earlier topic "${restoredTopic.topic}" (earlier note: "${restoredTopic.lastStatement}"). Resume naturally.`);
    if (listening.hasSelfCorrection) lines.push(`Speaker corrected themselves mid-utterance -> act only on corrected intent: "${listening.effectiveText}".`);
    if (listening.isRepetition) lines.push('Speaker repeated an earlier point — address the missed detail directly instead of giving a vague reply.');
    if (intent.shouldAskFirst) lines.push('Do NOT execute a blind media switch yet — acknowledge dissatisfaction/suggestion and ask if they want that specific switch first.');
    if (resolvedRefs?.length) {
      lines.push(`Resolved Context References: ${resolvedRefs.map((r) => JSON.stringify(r)).join(' ; ')}`);
    }
    if (crossSurface?.links?.length) lines.push(crossSurface.links.join(' | '));
    if (expression.avoidRepetitions?.length) {
      lines.push(`Avoid repeating your recent phrasing: ${expression.avoidRepetitions.join(' / ')}.`);
    }
    if (expression.avoidCustomerSupportClosing) {
      lines.push('Never end with robotic customer-support questions like "Anything else I can help with?".');
    }
    return lines.join('\n');
  }
}

function listeningIsWait(listen, activeSpeakerSpeaking) {
  return Boolean(listen?.shouldWaitForFinish || activeSpeakerSpeaking);
}
