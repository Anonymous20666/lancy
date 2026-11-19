/**
 * Conversational Decision Engine for Lancy AI.
 *
 * Separates natural conversational interaction, passive group observation,
 * proactive DJ commentary, ambiguity/clarification gates, tool execution,
 * and deep reasoning routing so Lancy never behaves like a rigid keyword matcher.
 */
import { isPureCasualBanter } from './lancyAgent.js';

export const DECISION = {
  CONTINUE_LISTENING: 'continue_listening',
  SILENT_OTHER_SPEAKER: 'silent_other_speaker',
  SHORT_ACK: 'short_ack',
  RESPOND: 'respond',
  PROACTIVE: 'proactive',
  CLARIFY: 'clarify',
  EXECUTE_TOOLS: 'execute_tools',
  DEEP_REASON: 'deep_reason',
  FINISH: 'finish'
};

const PASSIVE_REACTION_ONLY_RE = /^(?:damn|crazy|wild|lol+|lmao+|haha+|nice|cool|oh+|ohh+|wtf|bruh|fr|for real|true|word|no way|sheesh|omo|chai|ehen|okay|ok|hmm+|uh+|ah+)[.!?\s]*$/i;
const DIRECT_ADDRESS_RE = /\b(?:lancy|dj)\b/i;
const COMPLEX_REASON_RE = /\b(?:compare|recommend|analyze|explain|why|how\s+does|last\s+(?:five|5|ten|10)\s+years|best\s+movies|earlier|what\s+did\s+.+\s+say|plan|research|news|latest|update|release\s+date|specs|difference\s+between|poll|remember)\b/i;
const RESEARCH_NEED_RE = /\b(?:latest|news|release\s+date|came\s+out|when\s+did|who\s+is|who\s+won|current\s+price|specs|documentation|bot\s+api|trending\s+today|search\s+the\s+web|look\s+up|google)\b/i;
const CONVERSATIONAL_DISSATISFACTION_RE = /\b(?:becoming\s+boring|getting\s+boring|tired\s+of\s+this|don'?t\s+like\s+this|switch\s+the\s+vibe|more\s+energetic|too\s+slow|this\s+is\s+dead|change\s+the\s+mood)\b/i;
const AFFIRMATIVE_END_RE = /^(?:that'?s\s+all|thats\s+all|that\s+is\s+all|i'?m\s+done|im\s+done|nothing\s+else|no\s+more|na\s+all|e\s+don\s+do|carry\s+on|done)[.!?\s]*$/i;

export class ConversationalDecisionEngine {
  constructor({
    proactiveMinIntervalMs = 90000,
    participationLevel = 'balanced' // 'quiet' | 'balanced' | 'lively'
  } = {}) {
    this.proactiveMinIntervalMs = proactiveMinIntervalMs;
    this.participationLevel = participationLevel;
    this.lastProactiveByChat = new Map();
    this.lastProactiveTopicByChat = new Map();
  }

  /**
   * Decide how Lancy should handle an incoming utterance or message.
   */
  decide({
    text = '',
    surface = 'dm', // 'vc_voice' | 'vc_message' | 'group_text' | 'dm_text'
    hasImages = false,
    isDirectlyAddressed = false,
    conversationMode = 'IDLE',
    lowConfidence = false,
    simultaneousSpeakers = [],
    activeSpeakerSpeaking = false,
    recentTurnCount = 0,
    nowPlayingTitle = null,
    behaviorAnalysis = null
  } = {}) {
    const clean = String(text || '').trim();
    const isVoice = surface.startsWith('vc_');

    if (behaviorAnalysis) {
      const { listening, intent, participation, social } = behaviorAnalysis;
      if (listening?.isStopSpeaking || participation?.cancelSpeech) {
        return { action: DECISION.SILENT_OTHER_SPEAKER, cancelSpeech: true, reasoning: 'stop_speaking_priority', complexity: 'none' };
      }
      if (listening?.shouldWaitForFinish || participation?.mode === 'wait_for_finish') {
        return { action: DECISION.CONTINUE_LISTENING, reasoning: 'speaker_mid_thought_pause', complexity: 'none' };
      }
      if (!hasImages && !participation?.speak) {
        if (listening?.target === 'person_to_person') {
          return { action: DECISION.SILENT_OTHER_SPEAKER, reasoning: participation?.reason || 'person_to_person_dialogue', complexity: 'none' };
        }
        return { action: DECISION.CONTINUE_LISTENING, reasoning: participation?.reason || 'listening_restraint', complexity: 'none' };
      }
      if (participation?.mode === 'ack' && !intent?.requiresAction) {
        return { action: DECISION.SHORT_ACK, reasoning: 'conversational_acknowledgement', complexity: 'simple' };
      }
      if (participation?.mode === 'proactive' || participation?.mode === 'deescalate') {
        return {
          action: social?.isSeriousContext ? DECISION.DEEP_REASON : DECISION.PROACTIVE,
          reasoning: participation.reason || 'group_social_participation',
          complexity: social?.isSeriousContext ? 'moderate' : 'simple'
        };
      }
    }

    if (AFFIRMATIVE_END_RE.test(clean) && conversationMode !== 'IDLE') {
      return { action: DECISION.FINISH, reasoning: 'explicit_finish', complexity: 'simple' };
    }

    // Ambiguous / low-confidence speech or simultaneous overlap without clear single intent
    if (lowConfidence && (isDirectlyAddressed || conversationMode !== 'IDLE')) {
      return {
        action: DECISION.CLARIFY,
        reasoning: 'low_confidence_or_noisy_audio',
        complexity: 'simple'
      };
    }

    if (simultaneousSpeakers.length >= 2 && isVoice && conversationMode === 'IDLE' && !isDirectlyAddressed) {
      return {
        action: DECISION.SILENT_OTHER_SPEAKER,
        reasoning: 'overlapping_human_conversation',
        complexity: 'none'
      };
    }

    // Never hijack background passive human reactions in open group/VC unless actively conversing or directly addressed
    if (!hasImages && !isDirectlyAddressed && conversationMode === 'IDLE') {
      if (PASSIVE_REACTION_ONLY_RE.test(clean)) {
        return {
          action: DECISION.CONTINUE_LISTENING,
          reasoning: 'passive_group_reaction',
          complexity: 'none'
        };
      }
    }

    // In passive group observation (not addressed, IDLE), consider controlled proactive contribution
    if (surface === 'group_text' && !isDirectlyAddressed && !hasImages && conversationMode === 'IDLE') {
      return this.#decideProactive({ clean, activeSpeakerSpeaking, nowPlayingTitle });
    }

    // Multimodal image, complex research, multi-speaker recall, or deep planning -> route to Neon reasoning
    const needsResearch = RESEARCH_NEED_RE.test(clean);
    const isComplex = Boolean(
      hasImages
      || needsResearch
      || COMPLEX_REASON_RE.test(clean)
      || clean.length > 140
      || recentTurnCount >= 4 && /\b(?:it|that|earlier|previous|the other|second one|remember)\b/i.test(clean)
    );

    if (hasImages || needsResearch || isComplex) {
      return {
        action: DECISION.DEEP_REASON,
        reasoning: hasImages ? 'multimodal_vision' : (needsResearch ? 'web_research_needed' : 'complex_reasoning_or_context'),
        complexity: 'complex',
        needsResearch
      };
    }

    if (CONVERSATIONAL_DISSATISFACTION_RE.test(clean)) {
      return {
        action: DECISION.DEEP_REASON,
        reasoning: 'conversational_music_feedback',
        complexity: 'moderate',
        needsResearch: false
      };
    }

    if (isPureCasualBanter(clean)) {
      return {
        action: DECISION.RESPOND,
        reasoning: 'casual_human_banter',
        complexity: 'simple',
        needsResearch: false
      };
    }

    if (DIRECT_ADDRESS_RE.test(clean) || isDirectlyAddressed || surface === 'dm_text' || conversationMode !== 'IDLE') {
      return {
        action: DECISION.EXECUTE_TOOLS,
        reasoning: 'conversational_turn_with_tools',
        complexity: 'moderate',
        needsResearch: false
      };
    }

    return {
      action: DECISION.CONTINUE_LISTENING,
      reasoning: 'unaddressed_chatter',
      complexity: 'none'
    };
  }

  #decideProactive({ clean, activeSpeakerSpeaking, nowPlayingTitle }) {
    if (this.participationLevel === 'quiet' || this.participationLevel === 'passive' || this.participationLevel === 'reactive' || activeSpeakerSpeaking) {
      return { action: DECISION.CONTINUE_LISTENING, reasoning: 'quiet_or_speaker_active', complexity: 'none' };
    }
    const touchesMusicOrMovie = Boolean(nowPlayingTitle) && /\b(?:this\s+(?:song|track|movie|film|scene|beat)|what(?:'s|s)\s+playing|vibe)\b/i.test(clean);
    if (!touchesMusicOrMovie) {
      return { action: DECISION.CONTINUE_LISTENING, reasoning: 'no_proactive_entry_point', complexity: 'none' };
    }
    return { action: DECISION.PROACTIVE, reasoning: 'relevant_media_commentary', complexity: 'simple' };
  }

  canEmitProactive(chatId, topicKey = '') {
    const cid = Number(chatId || 0);
    const now = Date.now();
    const lastAt = this.lastProactiveByChat.get(cid) || 0;
    const minWait = this.participationLevel === 'lively' ? Math.floor(this.proactiveMinIntervalMs * 0.5) : this.proactiveMinIntervalMs;
    if (now - lastAt < minWait) return false;
    const cleanTopic = String(topicKey || '').trim().toLowerCase();
    if (cleanTopic && this.lastProactiveTopicByChat.get(cid) === cleanTopic && now - lastAt < minWait * 3) {
      return false;
    }
    this.lastProactiveByChat.set(cid, now);
    if (cleanTopic) this.lastProactiveTopicByChat.set(cid, cleanTopic);
    return true;
  }
}
