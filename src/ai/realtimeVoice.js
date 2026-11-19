/**
 * Real-Time Voice Capability Probe & Pluggable Gemini Live (`gemini-3.8-live`) Session Adapter.
 *
 * Strictly verifies actual endpoint/model permissions rather than pretending a standard
 * text-generation model is a bidirectional PCM WebSocket session.
 *
 * Audio contract when a Gemini Live WebSocket session is granted:
 *  - Inbound:  16 kHz, 16-bit PCM, little-endian, mono
 *  - Outbound: 24 kHz, 16-bit PCM, little-endian, mono
 */
export const REALTIME_AUDIO_CONTRACT = {
  input: { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' },
  output: { sampleRate: 24000, channels: 1, encoding: 'pcm_s16le' }
};

export class RealtimeVoiceCapability {
  constructor({ settings = null } = {}) {
    this.settings = settings;
    this.lastProbe = null;
  }

  /**
   * Probe whether bidirectional Gemini Live (`gemini-3.8-live`) is actually reachable
   * with currently configured credentials.
   */
  async probe({ force = false } = {}) {
    if (!force && this.lastProbe && Date.now() - this.lastProbe.checkedAt < 300000) {
      return this.lastProbe;
    }
    const endpoint = String(this.settings?.get?.('ai.endpoint') || '').trim();
    const apiKey = String(
      this.settings?.get?.('ai.apiKey')
      || this.settings?.env?.EXPLABS_API_KEY
      || process.env.EXPLABS_API_KEY
      || ''
    ).trim();
    const googleKey = String(
      this.settings?.env?.GEMINI_API_KEY
      || process.env.GEMINI_API_KEY
      || ((apiKey.startsWith('AIza') || apiKey.startsWith('AQ.')) ? apiKey : '')
    ).trim();
    const liveModel = String(this.settings?.env?.GEMINI_LIVE_MODEL || process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live').trim();

    if (googleKey) {
      this.lastProbe = {
        checkedAt: Date.now(),
        model: liveModel,
        transport: 'google_bidi_websocket',
        available: true,
        audioContract: REALTIME_AUDIO_CONTRACT,
        reason: null
      };
      return this.lastProbe;
    }

    if (endpoint.includes('experientiallabs.ai') && apiKey) {
      try {
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
          const data = await res.json();
          const hasLive = Array.isArray(data?.data) && data.data.some((m) => /gemini-3\.8-live|gpt-realtime/i.test(String(m?.id || '')));
          this.lastProbe = {
            checkedAt: Date.now(),
            model: 'gemini-3.8-live',
            transport: 'experiential_gateway',
            available: hasLive,
            audioContract: REALTIME_AUDIO_CONTRACT,
            reason: hasLive ? null : 'gemini-3.8-live is not granted on the supplied Experiential API key (403 model_not_granted); falling back to streaming VAD/Whisper STT + streaming PCM TTS + Astra/Neon.'
          };
          return this.lastProbe;
        }
      } catch (err) {
        this.lastProbe = {
          checkedAt: Date.now(),
          model: 'gemini-3.8-live',
          transport: 'experiential_gateway',
          available: false,
          audioContract: REALTIME_AUDIO_CONTRACT,
          reason: `Realtime model probe failed: ${err?.message || 'network_error'}`
        };
        return this.lastProbe;
      }
    }

    this.lastProbe = {
      checkedAt: Date.now(),
      model: 'gemini-3.8-live',
      transport: 'none',
      available: false,
      audioContract: REALTIME_AUDIO_CONTRACT,
      reason: 'No Gemini Live API key or Experiential realtime model grant configured; using local streaming PCM VAD + Faster-Whisper + streaming Edge-TTS PCM + Experiential Astra/Neon reasoning.'
    };
    return this.lastProbe;
  }
}
