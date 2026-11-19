"""Gemini 3.8 Live Bidirectional WebSocket Voice Engine.

Built strictly according to the Gemini 3.8 Live specification:
  - Target Model: `models/gemini-3.8-live` over `BidiGenerateContent` WebSocket
  - Default Voice: `Charon` (warm, grounded deep male voice)
  - Input Audio:  16 kHz, 16-bit PCM, little-endian, mono (`audio/pcm;rate=16000`)
  - Output Audio: 24 kHz, 16-bit PCM, little-endian, mono (upsampled to 48 kHz stereo for `av_sync`)
  - Long-talk patient turn detection (`END_SENSITIVITY_LOW`, `silenceDurationMs=680`)
  - Default-enabled Affective Dialogue & Proactive Audio (legacy flags omitted)
  - `inputAudioTranscription` with `customVocabulary` domain biasing & `outputAudioTranscription`
  - Asynchronous non-blocking tool execution with structured `FunctionResponse` (`status`, `retryable`, `message`)
"""

from __future__ import annotations

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
import re
import time
import numpy as np

log = logging.getLogger('voice.gemini_live')

# Dedicated multi-threaded DSP worker pool so base64 + NumPy 36k->16k and 24k->48k
# resampling run off the main asyncio event loop thread across CPU cores.
_AUDIO_DSP_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix='gemini-dsp')


def _decode_and_upsample_24k_to_48k(b64_data: str, prev_sample: int | None) -> tuple[bytes, int | None]:
    pcm_24k = base64.b64decode(b64_data or '')
    if not pcm_24k:
        return b'', prev_sample
    return pcm_24k_mono_to_48k_stereo(pcm_24k, prev_sample, return_state=True)

GEMINI_LIVE_WS_URL = (
    'wss://generativelanguage.googleapis.com/ws/'
    'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
)
DEFAULT_LIVE_MODEL = 'models/gemini-3.8-live'
DEFAULT_LIVE_VOICE = os.environ.get('GEMINI_LIVE_VOICE', 'Charon')
DEFAULT_PERSONA_ID = 'pappy'

VALID_GEMINI_VOICES = {
    'Charon', 'Fenrir', 'Orus', 'Puck', 'Aoede', 'Kore', 'Leda', 'Zephyr',
    'Achernar', 'Algenib', 'Autonoe', 'Callirrhoe', 'Despina', 'Enceladus',
    'Gacrux', 'Iapetus', 'Laomedeia', 'Pulcherrima', 'Rasalgethi', 'Sadachbia',
    'Sulafat', 'Umbriel', 'Vindemiatrix', 'Schedar', 'Algieba', 'Alnilam',
    'Achird', 'Erinome', 'Sadaltager', 'Zubenelgenubi',
}

PERSONA_CAST = {
    'pappy': {
        'id': 'pappy', 'name': 'Pappy', 'gender': 'male', 'age_group': 'man', 'voice': 'Charon',
        'personality': 'Charismatic, grounded deep-voiced male host, DJ, and storyteller with effortless warmth, Nigerian English/Pidgin flair, sharp cinema/music taste, and captivating long-form storytelling.',
    },
    'ava': {
        'id': 'ava', 'name': 'Ava', 'gender': 'female', 'age_group': 'lady', 'voice': 'Aoede',
        'personality': 'Warm, confident, expressive woman with quick playful wit, emotional depth, and a soft spot for R&B, Afrobeats, and gripping dark romance novels.',
    },
    'maya': {
        'id': 'maya', 'name': 'Maya', 'gender': 'female', 'age_group': 'girl', 'voice': 'Leda',
        'personality': 'Bright, curious, energetic young girl voice with lively reactions, love for trending music videos, anime, romance stories, and animated storytelling.',
    },
    'leo': {
        'id': 'leo', 'name': 'Leo', 'gender': 'male', 'age_group': 'boy', 'voice': 'Puck',
        'personality': 'Upbeat, energetic young guy/boy energy — quick banter, hyped about music bangers, action movies, adventure stories, and sharp humor.',
    },
    'nana': {
        'id': 'nana', 'name': 'Nana', 'gender': 'female', 'age_group': 'old_woman', 'voice': 'Gacrux',
        'personality': 'Warm, wise older woman / grandmotherly figure with calm patient grace, ancestral folklore, rich dramatic storytelling cadence, and grounded life wisdom.',
    },
    'elder': {
        'id': 'elder', 'name': 'Elder', 'gender': 'male', 'age_group': 'old_man', 'voice': 'Algenib',
        'personality': 'Measured, gravelly wise old man voice — thoughtful, unhurried, rich in history, classic cinema, legends, and deep life insight.',
    },
    'zara': {
        'id': 'zara', 'name': 'Zara', 'gender': 'female', 'age_group': 'lady', 'voice': 'Kore',
        'personality': 'Bold, dramatic, sharp-witted woman who loves dark romance, plot twists, late-night debates, and unflinching honesty.',
    },
    'marcus': {
        'id': 'marcus', 'name': 'Marcus', 'gender': 'male', 'age_group': 'man', 'voice': 'Fenrir',
        'personality': 'Smooth, cinematic man — deep taste in crime thrillers, film craft, lyrics, and atmospheric vibes.',
    },
    'chloe': {
        'id': 'chloe', 'name': 'Chloe', 'gender': 'female', 'age_group': 'girl', 'voice': 'Zephyr',
        'personality': 'Sweet, sunny, perceptive young feminine voice who keeps conversations engaging, warm, and genuinely curious.',
    },
}

LIVE_VOICE_ALIASES = {
    'pappy': 'Charon', 'lancy': 'Charon', 'charon': 'Charon',
    'man': 'Charon', 'deep_male': 'Charon', 'male': 'Charon', 'ng_male': 'Charon', 'ng': 'Charon',
    'fenrir': 'Fenrir', 'marcus': 'Fenrir', 'uk_male': 'Fenrir',
    'orus': 'Orus', 'us_male': 'Orus',
    'leo': 'Puck', 'boy': 'Puck', 'young_male': 'Puck', 'puck': 'Puck',
    'elder': 'Algenib', 'old_man': 'Algenib', 'grandpa': 'Algenib', 'algenib': 'Algenib',
    'ava': 'Aoede', 'lady': 'Aoede', 'woman': 'Aoede', 'female': 'Aoede', 'aoede': 'Aoede', 'ng_female': 'Aoede',
    'zara': 'Kore', 'kore': 'Kore', 'us_female': 'Kore',
    'maya': 'Leda', 'girl': 'Leda', 'young_female': 'Leda', 'leda': 'Leda',
    'chloe': 'Zephyr', 'zephyr': 'Zephyr',
    'nana': 'Gacrux', 'old_woman': 'Gacrux', 'grandma': 'Gacrux', 'elder_woman': 'Gacrux', 'gacrux': 'Gacrux', 'uk_female': 'Gacrux',
}

_ARCHETYPE_VOICE = {
    'man': ('male', 'Charon'),
    'boy': ('male', 'Puck'),
    'old_man': ('male', 'Algenib'),
    'lady': ('female', 'Aoede'),
    'girl': ('female', 'Leda'),
    'old_woman': ('female', 'Gacrux'),
}

_LIKELY_FEMALE_RE = re.compile(r'^(?:ava|maya|nana|zara|chloe|sarah|ada|amara|chioma|tolu|sophia|bella|elena|kemi|lola|grace|victoria|queen|esther|naomi|rachel|olivia|emma|mia|aisha|fatima|zainab)$', re.IGNORECASE)


def resolve_live_voice_name(voice: str | None = None) -> str:
    raw = str(voice or '').strip()
    if not raw:
        return DEFAULT_LIVE_VOICE
    if raw.lower() in LIVE_VOICE_ALIASES:
        return LIVE_VOICE_ALIASES[raw.lower()]
    if raw in VALID_GEMINI_VOICES:
        return raw
    if 'Ezinne' in raw or 'Ava' in raw:
        return 'Aoede'
    if 'Maisie' in raw or 'Ana' in raw:
        return 'Leda'
    if 'Sonia' in raw:
        return 'Gacrux'
    if 'Luke' in raw:
        return 'Puck'
    if 'Roger' in raw:
        return 'Algenib'
    return DEFAULT_LIVE_VOICE


def resolve_persona_spec(name_or_voice: str | None = None, *, voice_type: str | None = None) -> dict:
    raw = str(name_or_voice or '').strip()
    vt = str(voice_type or '').strip().lower().replace(' ', '_')
    vt_map = {'woman': 'lady', 'female': 'lady', 'grandma': 'old_woman', 'elder_woman': 'old_woman', 'grandpa': 'old_man', 'elder_man': 'old_man', 'young_male': 'boy', 'young_female': 'girl', 'deep_male': 'man'}
    vt = vt_map.get(vt, vt)

    low = raw.lower()
    if not low or low == 'lancy':
        return dict(PERSONA_CAST['pappy'])
    if low in PERSONA_CAST:
        return dict(PERSONA_CAST[low])
    alias_hits = {
        'man': 'pappy', 'deep_male': 'pappy', 'ng_male': 'pappy', 'charon': 'pappy',
        'lady': 'ava', 'woman': 'ava', 'female': 'ava', 'aoede': 'ava', 'ng_female': 'ava',
        'girl': 'maya', 'young_female': 'maya', 'leda': 'maya',
        'boy': 'leo', 'young_male': 'leo', 'puck': 'leo',
        'old_woman': 'nana', 'grandma': 'nana', 'elder_woman': 'nana', 'gacrux': 'nana', 'uk_female': 'nana',
        'old_man': 'elder', 'grandpa': 'elder', 'elder_man': 'elder', 'algenib': 'elder',
        'kore': 'zara', 'fenrir': 'marcus', 'zephyr': 'chloe',
    }
    if low in alias_hits:
        return dict(PERSONA_CAST[alias_hits[low]])

    # Dynamic custom named persona (e.g., "Amara", "Tobi", "Sophia")
    clean_name = re.sub(r'[^\w -]', '', raw).strip()[:28] or 'Pappy'
    if vt not in _ARCHETYPE_VOICE:
        if _LIKELY_FEMALE_RE.match(clean_name) or re.search(r'(?:a|ah|ia|na|la|elle|ette|yn)$', clean_name, re.I):
            vt = 'lady'
        else:
            vt = 'man'
    gender, g_voice = _ARCHETYPE_VOICE[vt]
    return {
        'id': clean_name.lower(),
        'name': clean_name[0].upper() + clean_name[1:],
        'gender': gender,
        'age_group': vt,
        'voice': g_voice,
        'personality': (
            f'You are {clean_name[0].upper() + clean_name[1:]} ({vt}, {gender}), standing as your own independent '
            f'co-host and storyteller alongside Pappy and Ava. Speak naturally with rich human emotion and character.'
        ),
    }


WAKE_CALL_RE = re.compile(
    r'\b(?:pap+(?:y+e?|i+e?|ie|ey)|pop+(?:y|i)e?|puppy|lancy|lanci|lancey|nancy|now\s+see|lan\s*see|land\s*see|'
    r'ava|eva|maya|maia|leo|nana|mama\s+grace|grandma|elder|zara|marcus|chloe)\b|'
    r'\b(?:switch\s+to|use|give\s+me|change\s+to|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?'
    r'(?:old\s+woman|grandma|elder\s+woman|old\s+man|grandpa|elder\s+man|lady|woman|girl|young\s+girl|boy|young\s+boy|man|deep\s+male)\b',
    re.IGNORECASE,
)

_PERSONA_CALL_PATTERNS = [
    ('ava', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)(?:ava|eva)\b|\b(?:switch\s+to|use|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(?:lady|woman)\s*(?:voice)?\b', re.I)),
    ('maya', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)(?:maya|maia)\b|\b(?:switch\s+to|use|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(?:young\s+)?girl\s*(?:voice)?\b', re.I)),
    ('leo', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)leo\b|\b(?:switch\s+to|use|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(?:young\s+)?boy\s*(?:voice)?\b', re.I)),
    ('nana', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)(?:nana|mama\s+grace|grandma)\b|\b(?:switch\s+to|use|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(?:old\s+woman|grandma|elder\s+woman)\s*(?:voice)?\b', re.I)),
    ('elder', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)elder\b|\b(?:switch\s+to|use|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(?:old\s+man|grandpa|elder\s+man)\s*(?:voice)?\b', re.I)),
    ('zara', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)zara\b', re.I)),
    ('marcus', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)marcus\b', re.I)),
    ('chloe', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)chloe\b', re.I)),
    ('pappy', re.compile(r'(?:^(?:hey|hi|yo|ok|okay|abeg|call|ask)\s+|\b)(?:pap+(?:y+e?|i+e?|ie|ey)|pop+(?:y|i)e?|lancy|lanci|lancey|nancy|now\s+see)\b|\b(?:switch\s+to|use|talk\s+(?:with|in|like))\s+(?:(?:a|an|the)\s+)?(?:deep\s+male|man)\s*(?:voice)?\b', re.I)),
]


def detect_addressed_persona(text: str) -> dict | None:
    """Return the persona spec if the utterance explicitly calls a cast member or requests a voice archetype."""
    clean = str(text or '').strip()
    if not clean:
        return None
    for pid, pat in _PERSONA_CALL_PATTERNS:
        if pat.search(clean):
            return dict(PERSONA_CAST[pid])
    return None


LANCY_CUSTOM_VOCABULARY = [
    'Pappy', 'Ava', 'Maya', 'Leo', 'Nana', 'Elder', 'Zara', 'Marcus', 'Chloe', 'Lancy',
    'abeg', 'no wahala', 'omo', 'wetin dey happen', 'next queue', 'pause am',
    'dark romance', 'Haunting Adeline', 'Twisted Love', 'tell me a story',
    'afrobeats', 'amapiano', 'burna boy', 'wizkid', 'davido', 'asake', 'rema', 'nollywood', 'subtitles',
]

LANCY_LIVE_TOOL_DECLARATIONS = [
    {
        'name': 'get_call_state',
        'description': 'Get live VC playback state, currently playing song/movie/video, queue, volume, subtitles, lyrics snippet, and active participants.',
        'parameters': {'type': 'OBJECT', 'properties': {}},
    },
    {
        'name': 'control_playback',
        'description': 'Pause, resume, skip to next item, go to previous item, switch deck (music/movie), shuffle, loop, leave VC, or refresh player card.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'action': {'type': 'STRING', 'description': 'pause, resume, skip, previous, stop, leave, shuffle, toggle_loop, switch_deck'},
                'deck': {'type': 'STRING', 'description': 'music or movie when switching deck'},
            },
            'required': ['action'],
        },
    },
    {
        'name': 'adjust_volume',
        'description': 'Set, increase, decrease, mute, or unmute call volume (0-200).',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'mode': {'type': 'STRING', 'description': 'set, up, down, mute, unmute'},
                'value': {'type': 'INTEGER', 'description': 'Target percentage 0-200 or delta step'},
            },
            'required': ['mode'],
        },
    },
    {
        'name': 'seek_playback',
        'description': 'Seek to timestamp, relative offset (+/- seconds), or percentage in current audio or video.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'seconds': {'type': 'INTEGER', 'description': 'Absolute target timestamp in seconds from start'},
                'relative': {'type': 'INTEGER', 'description': 'Signed relative offset in seconds (e.g. 30 for +30s forward, -15 for 15s back)'},
                'fraction': {'type': 'NUMBER', 'description': '0.5 for middle'},
            },
        },
    },
    {
        'name': 'search_and_play_music',
        'description': 'Search for a song/artist/vibe and play now or queue it in VC.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'query': {'type': 'STRING', 'description': 'Song title, artist, or genre mood'},
                'action': {'type': 'STRING', 'description': 'play_now, queue, or search'},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'search_videos',
        'description': 'Search YouTube/web videos and optionally play, queue, or send to chat.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'query': {'type': 'STRING', 'description': 'Video query'},
                'action': {'type': 'STRING', 'description': 'play_now, queue, search, or send_to_chat'},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'search_movies_series',
        'description': 'Search, inspect, or play/queue movies or TV series episodes.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'query': {'type': 'STRING', 'description': 'Movie or series title'},
                'action': {'type': 'STRING', 'description': 'play_now, queue, search, or inspect'},
                'season': {'type': 'INTEGER', 'description': 'Season number'},
                'episode': {'type': 'INTEGER', 'description': 'Episode number'},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'manage_queue',
        'description': 'Inspect, move, remove, or clear queued tracks/videos/movies.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'action': {'type': 'STRING', 'description': 'list, remove, move_to_top, clear'},
                'index': {'type': 'INTEGER', 'description': '1-based item index'},
            },
            'required': ['action'],
        },
    },
    {
        'name': 'send_current_video_to_chat',
        'description': 'Send the currently playing music video or track file directly to the Telegram chat.',
        'parameters': {'type': 'OBJECT', 'properties': {}},
    },
    {
        'name': 'tune_cinema_stream',
        'description': 'Switch video quality, subtitles on/off, subtitle language, or audio dub language.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'quality': {'type': 'STRING', 'description': '1080p, 720p, 480p'},
                'subtitles': {'type': 'STRING', 'description': 'on, off, screen'},
                'subtitleLanguage': {'type': 'STRING'},
                'audioLanguage': {'type': 'STRING'},
            },
        },
    },
    {
        'name': 'web_research',
        'description': 'Search live web, Wikipedia, current music, YouTube videos, movies, or TV shows for up-to-date facts, releases, artists, film plots, or technical questions.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'query': {'type': 'STRING', 'description': 'Search query'},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'tell_story_or_novel',
        'description': 'Look up books, dark romance novels, thrillers, folklore, legends, or story plots via OpenLibrary + Wikipedia so you can narrate rich long-form stories.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'query': {'type': 'STRING', 'description': 'Story/novel title, dark romance trope, author, or theme'},
                'genre': {'type': 'STRING', 'description': 'Optional: dark_romance, romance, thriller, horror, fantasy, mystery, folklore, scifi'},
            },
            'required': ['query'],
        },
    },
    {
        'name': 'switch_persona',
        'description': 'Hand off immediately to a named co-host/character (Pappy, Ava, Maya, Leo, Nana, Elder, Zara, Marcus, Chloe, or any requested name) or voice type (man, boy, lady, girl, old_woman, old_man) when a speaker calls that name or asks to switch voices.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'name': {'type': 'STRING', 'description': 'Requested character name e.g. Ava, Pappy, Maya, Leo, Nana, Elder'},
                'voice_type': {'type': 'STRING', 'description': 'Optional voice archetype: man, boy, lady, girl, old_woman, old_man'},
                'handoff_text': {'type': 'STRING', 'description': 'The exact request/question the speaker asked that character'},
            },
            'required': ['name'],
        },
    },
    {
        'name': 'create_group_poll',
        'description': 'Create a Telegram poll in the group chat for listeners to vote on.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'question': {'type': 'STRING'},
                'options': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
            },
            'required': ['question', 'options'],
        },
    },
    {
        'name': 'finish_conversation',
        'description': 'Call when the user says they are done talking ("that is all", "resume", "carry on", "nothing else") so playback can smoothly resume.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'resumePlayback': {'type': 'BOOLEAN', 'description': 'True to resume paused media now'},
                'closingLine': {'type': 'STRING', 'description': 'Natural short closing line'},
            },
        },
    },
    {
        'name': 'browser_start_task',
        'description': 'Start an autonomous BrowserOS Chromium task for websites, forms, research, downloads, or interactive browsing.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'goal': {'type': 'STRING', 'description': 'What to do or look up in the browser'},
                'url': {'type': 'STRING', 'description': 'Optional starting URL'},
                'show_live': {'type': 'BOOLEAN', 'description': 'True to show BrowserOS live in this Voice Chat'},
            },
            'required': ['goal'],
        },
    },
    {
        'name': 'browser_show_live',
        'description': 'Show Lancy live BrowserOS browser screen inside the Telegram Voice Chat (pausing music cleanly if playing).',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'url': {'type': 'STRING'},
            },
        },
    },
    {
        'name': 'browser_hide_live',
        'description': 'Stop showing BrowserOS live in VC and resume previously paused music or movie.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'resume_media': {'type': 'BOOLEAN'},
            },
        },
    },
    {
        'name': 'browser_interact_live',
        'description': 'Manipulate the live BrowserOS tab by voice ("click the second result", "scroll down", "go back", "read this page", "open github.com").',
        'parameters': {
            'type': 'OBJECT',
            'properties': {
                'command': {'type': 'STRING'},
            },
            'required': ['command'],
        },
    },
    {
        'name': 'browser_pause_task',
        'description': 'Pause active autonomous browser task.',
        'parameters': {'type': 'OBJECT', 'properties': {'task_id': {'type': 'STRING'}}},
    },
    {
        'name': 'browser_resume_task',
        'description': 'Resume paused or human-takeover browser task.',
        'parameters': {'type': 'OBJECT', 'properties': {'task_id': {'type': 'STRING'}}},
    },
    {
        'name': 'browser_stop_task',
        'description': 'Stop active browser task.',
        'parameters': {'type': 'OBJECT', 'properties': {'task_id': {'type': 'STRING'}}},
    },
    {
        'name': 'browser_task_status',
        'description': 'Check active BrowserOS task status and visible page.',
        'parameters': {'type': 'OBJECT', 'properties': {'task_id': {'type': 'STRING'}}},
    },
    {
        'name': 'browser_list_tabs',
        'description': 'List open BrowserOS tabs.',
        'parameters': {'type': 'OBJECT', 'properties': {}},
    },
    {
        'name': 'browser_request_human_help',
        'description': 'Pause browser task and ask human user to handle login, OTP/2FA, or CAPTCHA.',
        'parameters': {
            'type': 'OBJECT',
            'properties': {'reason': {'type': 'STRING'}},
            'required': ['reason'],
        },
    },
    {
        'name': 'browser_replay_task',
        'description': 'Fetch step-by-step replay log for the browser task.',
        'parameters': {'type': 'OBJECT', 'properties': {'task_id': {'type': 'STRING'}}},
    },
]

_BLOCKING_LIVE_TOOLS = {'switch_persona', 'finish_conversation'}
for _decl in LANCY_LIVE_TOOL_DECLARATIONS:
    if _decl.get('name') not in _BLOCKING_LIVE_TOOLS:
        _decl['behavior'] = 'NON_BLOCKING'


def build_live_system_instruction(*, persona: dict | None = None, vc_title: str = '', now_playing: str = '') -> str:
    p = persona or PERSONA_CAST['pappy']
    p_name = p.get('name') or 'Pappy'
    p_age_gender = f"{p.get('age_group', 'man')}, {p.get('gender', 'male')}"
    p_desc = p.get('personality') or PERSONA_CAST['pappy']['personality']
    ctx_bits = []
    if vc_title:
        ctx_bits.append(f'Room: "{vc_title}".')
    if now_playing:
        ctx_bits.append(f'Playing: {now_playing}.')
    ctx_line = ' '.join(ctx_bits)
    return (
        f'You are {p_name} ({p_age_gender}) — a sharp, warm, natural human co-host, DJ, cinema buff, and storyteller in a live Telegram Voice Chat.\n'
        f'VIBE: {p_desc}\n'
        'CONVERSATIONAL FLOW & SOCIAL INTELLIGENCE:\n'
        '- Talk like a real person in a room — snappy, expressive, relaxed 1–3 sentence reactions in everyday banter; zero robotic or customer-support phrases ("Anything else?", "How can I assist?").\n'
        '- Match the speaker\'s mood and energy naturally (playful wit when hyped, grounded empathy when serious/frustrated).\n'
        '- Go deep and expansive across paragraphs ONLY when asked for a story, dark romance novel (`tell_story_or_novel`), movie plot/lore, or multi-part breakdown — never cut a story short.\n'
        '- Ignore side human-to-human chatter cleanly via proactive audio.\n'
        'VOICE CAST HANDOFF:\n'
        '- Cast in room: Pappy (man), Ava (lady), Maya (girl), Leo (boy), Nana (old woman), Elder (old man), Zara, Marcus, Chloe.\n'
        '- If someone calls another character or asks to switch voices, call `switch_persona(name=..., voice_type=..., handoff_text=...)` immediately and stay silent so they speak.\n'
        f'{ctx_line}\n'
        'TOOLS, SPEED & LIVE BROWSER:\n'
        '1. Quick controls ("skip", "volume up", "jump 30 seconds", "pause") run asynchronously without stalling — confirm briskly in one natural line. Never issue more than two consecutive tool calls without speaking.\n'
        '2. Stay truthful to `[ROOM STATE UPDATE]` messages and `get_call_state` — never invent playback state.\n'
        '3. On browser requests in VC, pass `show_live: true` to `browser_start_task` or call `browser_show_live` so participants see BrowserOS live.\n'
        '4. When user finishes talking ("carry on", "resume", "nothing else"), call `finish_conversation(resumePlayback=true)`.'
    ).strip()


def resample_pcm_mono(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Linearly resample 16-bit signed little-endian mono PCM between sample rates."""
    if not pcm or src_rate <= 0 or dst_rate <= 0 or src_rate == dst_rate:
        return pcm
    samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32)
    n_src = len(samples)
    if n_src <= 1:
        return pcm
    n_dst = max(1, int(round(n_src * (float(dst_rate) / float(src_rate)))))
    x_old = np.linspace(0.0, 1.0, num=n_src, endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_dst, endpoint=False)
    resampled = np.interp(x_new, x_old, samples)
    return np.clip(resampled, -32768.0, 32767.0).astype('<i2').tobytes()


def resample_pcm_to_16k_mono(pcm: bytes, src_rate: int, channels: int = 1) -> bytes:
    if not pcm:
        return b''
    if int(channels) > 1:
        arr = np.frombuffer(pcm, dtype='<i2').astype(np.float32)
        usable = len(arr) - (len(arr) % int(channels))
        if usable <= 0:
            return b''
        mono = arr[:usable].reshape(-1, int(channels)).mean(axis=1)
        pcm = np.clip(mono, -32768.0, 32767.0).astype('<i2').tobytes()
    return resample_pcm_mono(pcm, int(src_rate or 36000), 16000)


def pcm_24k_mono_to_48k_stereo(pcm_24k: bytes, prev_sample: float | None = None, *, return_state: bool = False):
    """Clickless exact-2x midpoint-interpolated 24 kHz mono -> 48 kHz stereo PCM upsampler."""
    if not pcm_24k or len(pcm_24k) < 2:
        return (b'', prev_sample) if return_state else b''
    usable = len(pcm_24k) - (len(pcm_24k) % 2)
    if usable <= 0:
        return (b'', prev_sample) if return_state else b''
    samples = np.frombuffer(pcm_24k[:usable], dtype='<i2').astype(np.float32)
    n = len(samples)
    if n == 0:
        return (b'', prev_sample) if return_state else b''

    out = np.empty(n * 2, dtype=np.float32)
    if prev_sample is not None:
        out[0] = 0.5 * (float(prev_sample) + samples[0])
        out[1::2] = samples
        if n > 1:
            out[2::2] = 0.5 * (samples[:-1] + samples[1:])
    else:
        out[0::2] = samples
        if n > 1:
            out[1:-1:2] = 0.5 * (samples[:-1] + samples[1:])
        out[-1] = samples[-1]
    next_prev = float(samples[-1])

    mono_48k = np.clip(out, -32768.0, 32767.0).astype('<i2')
    stereo = np.repeat(mono_48k[:, None], 2, axis=1).reshape(-1)
    pcm_out = stereo.astype('<i2').tobytes()
    return (pcm_out, next_prev) if return_state else pcm_out


class GeminiLiveSession:
    """Persistent or single-turn bidirectional WebSocket session with `gemini-3.8-live`."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        chat_id: int | None = None,
        persona_id: str = DEFAULT_PERSONA_ID,
        system_instruction: str = '',
        voice_name: str | None = None,
        function_declarations: list[dict] | None = None,
        custom_vocabulary: list[str] | None = None,
        on_pcm_48k_stereo=None,
        on_tool_call=None,
        on_interrupted=None,
        on_transcription=None,
        on_turn_complete=None,
        on_close=None,
        on_go_away=None,
        is_conversation_engaged=None,
        on_wake_engaged=None,
        on_persona_redirect=None,
    ):
        self.api_key = str(api_key or os.environ.get('GEMINI_API_KEY') or '').strip()
        raw_model = str(model or os.environ.get('GEMINI_LIVE_MODEL') or DEFAULT_LIVE_MODEL).strip()
        self.model = raw_model if raw_model.startswith('models/') else f'models/{raw_model}'
        self.chat_id = chat_id
        self.persona_id = str(persona_id or DEFAULT_PERSONA_ID)
        self.system_instruction = str(system_instruction or build_live_system_instruction()).strip()
        self.voice_name = resolve_live_voice_name(voice_name)
        self.function_declarations = list(
            LANCY_LIVE_TOOL_DECLARATIONS if function_declarations is None else function_declarations
        )
        self.custom_vocabulary = list(
            LANCY_CUSTOM_VOCABULARY if custom_vocabulary is None else custom_vocabulary
        )
        self.on_pcm_48k_stereo = on_pcm_48k_stereo
        self.on_tool_call = on_tool_call
        self.on_interrupted = on_interrupted
        self.on_transcription = on_transcription
        self.on_turn_complete = on_turn_complete
        self.on_close = on_close
        self.on_go_away = on_go_away
        self.is_conversation_engaged = is_conversation_engaged
        self.on_wake_engaged = on_wake_engaged
        self.on_persona_redirect = on_persona_redirect

        self._sess = None
        self._ws = None
        self._recv_task: asyncio.Task | None = None
        self._send_lock = asyncio.Lock()
        self._in_buf = bytearray()
        self._gate_buf = bytearray()
        self._pending_tool_calls: list[dict] = []
        self._awaiting_blocking_tools: set[str] = set()
        self._turn_wake_authorized = False
        self._turn_redirected_to: dict | None = None
        self._out_prev_sample: float | None = None
        self._pending_in_trans: list[str] = []
        self._pending_out_trans: list[str] = []
        self.active_speaker_id: int | None = None
        self.active_speaker_name: str = ''
        self.connected = False
        self.closed = False
        self.session_handle: str | None = None

    def build_setup_payload(self) -> dict:
        # Official Gemini 3.8 Live v1beta protocol: `sessionResumption: {}` enables handles from turn 0;
        # `proactiveAudio` and `thinkingConfig` are rejected with 1007 on this checkpoint.
        setup: dict = {
            'model': self.model,
            'generationConfig': {
                'responseModalities': ['AUDIO'],
                'maxOutputTokens': 8192,
                'speechConfig': {
                    'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': self.voice_name}},
                },
            },
            'realtimeInputConfig': {
                'automaticActivityDetection': {
                    'disabled': False,
                    'startOfSpeechSensitivity': 'START_SENSITIVITY_HIGH',
                    'endOfSpeechSensitivity': 'END_SENSITIVITY_LOW',
                    'prefixPaddingMs': 300,
                    'silenceDurationMs': 1150,
                }
            },
            'contextWindowCompression': {'slidingWindow': {}},
            'sessionResumption': {'handle': self.session_handle} if self.session_handle else {},
            'inputAudioTranscription': (
                {'customVocabulary': self.custom_vocabulary} if self.custom_vocabulary else {}
            ),
            'outputAudioTranscription': {},
        }
        if self.system_instruction:
            setup['systemInstruction'] = {'parts': [{'text': self.system_instruction}]}
        if self.function_declarations:
            setup['tools'] = [{'functionDeclarations': self.function_declarations}]
        return {'setup': setup}

    async def connect(self, timeout_sec: float = 8.0, *, start_reader: bool = True) -> bool:
        if not self.api_key or self.closed:
            return False
        import aiohttp
        ws_url = f'{GEMINI_LIVE_WS_URL}?key={self.api_key}'
        for attempt in range(2):
            await self._close_transport()
            self._sess = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, connect=timeout_sec))
            try:
                self._ws = await self._sess.ws_connect(ws_url, timeout=timeout_sec, heartbeat=25.0)
                await self._ws.send_json(self.build_setup_payload())
                msg = await asyncio.wait_for(self._ws.receive(), timeout=timeout_sec)
                raw = msg.data.decode('utf-8', 'replace') if isinstance(msg.data, (bytes, bytearray)) else str(msg.data)
                if 'setupComplete' in raw:
                    self.connected = True
                    if start_reader:
                        self._recv_task = asyncio.create_task(self._recv_loop())
                    return True
                log.warning('GeminiLive unexpected setup reply chat=%s: %s', self.chat_id, raw[:180])
            except Exception as err:
                log.warning('GeminiLive connect failed chat=%s (%s): %s', self.chat_id, type(err).__name__, str(err)[:160])
            await self._close_transport()
            if self.session_handle and attempt == 0:
                self.session_handle = None
                continue
            break
        return False

    async def _recv_loop(self):
        import aiohttp
        close_frame_code = None
        close_frame_reason = ''
        try:
            while self.connected and self._ws is not None and not self.closed:
                msg = await self._ws.receive()
                if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    if msg.type == aiohttp.WSMsgType.CLOSE:
                        close_frame_code = msg.data
                        close_frame_reason = str(msg.extra or '')
                    break
                raw = msg.data.decode('utf-8', 'replace') if isinstance(msg.data, (bytes, bytearray)) else str(msg.data or '')
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue

                upd = obj.get('sessionResumptionUpdate')
                if isinstance(upd, dict) and upd.get('newHandle'):
                    self.session_handle = str(upd['newHandle'])

                go_away = obj.get('goAway')
                if isinstance(go_away, dict):
                    time_left = str(go_away.get('timeLeft') or '')
                    log.info('GeminiLive goAway chat=%s timeLeft=%s has_handle=%s', self.chat_id, time_left, bool(self.session_handle))
                    if self.on_go_away:
                        asyncio.create_task(self.on_go_away(time_left, self))

                sc = obj.get('serverContent') or {}
                if sc.get('interrupted'):
                    self._out_prev_sample = None
                    self._gate_buf.clear()
                    self._pending_tool_calls.clear()
                    self._turn_redirected_to = None
                    log.info('GeminiLive interrupted by speaker')
                    if self.on_interrupted:
                        await self.on_interrupted()

                in_tr = sc.get('inputTranscription')
                if isinstance(in_tr, dict) and in_tr.get('text'):
                    self._pending_in_trans.append(str(in_tr['text']))
                    in_so_far = ''.join(self._pending_in_trans).strip()
                    redirect_spec = detect_addressed_persona(in_so_far)
                    if redirect_spec and redirect_spec.get('id') != self.persona_id:
                        self._turn_redirected_to = redirect_spec
                        self._turn_wake_authorized = True
                        self._gate_buf.clear()
                        self._pending_tool_calls.clear()
                    elif WAKE_CALL_RE.search(in_so_far):
                        self._turn_wake_authorized = True
                        if self.on_wake_engaged:
                            try:
                                self.on_wake_engaged()
                            except Exception:
                                pass
                        if self._gate_buf and self.on_pcm_48k_stereo and self._turn_redirected_to is None:
                            flushed_pcm = bytes(self._gate_buf)
                            self._gate_buf.clear()
                            await self.on_pcm_48k_stereo(flushed_pcm)
                        if self._pending_tool_calls and self.on_tool_call and self._turn_redirected_to is None:
                            flushed_tc = list(self._pending_tool_calls)
                            self._pending_tool_calls.clear()
                            asyncio.create_task(self.on_tool_call(flushed_tc, self))

                is_engaged = (
                    True
                    if self.is_conversation_engaged is None
                    else bool(self.is_conversation_engaged() or self._turn_wake_authorized)
                )

                tc = obj.get('toolCall')
                if isinstance(tc, dict) and tc.get('functionCalls'):
                    fcalls = tc['functionCalls']
                    for fc in fcalls:
                        fname = str(fc.get('name') or '')
                        cid_fc = str(fc.get('id') or '')
                        if cid_fc and fname in _BLOCKING_LIVE_TOOLS:
                            self._awaiting_blocking_tools.add(cid_fc)
                    has_switch = any(f.get('name') == 'switch_persona' for f in fcalls)
                    if has_switch:
                        self._turn_wake_authorized = True
                        is_engaged = True
                        if self.on_wake_engaged:
                            try:
                                self.on_wake_engaged()
                            except Exception:
                                pass
                    if self._turn_redirected_to is not None and not has_switch:
                        pass
                    elif is_engaged:
                        log.info('GeminiLive toolCall calls=%s speaker=%s', [f.get('name') for f in fcalls], self.active_speaker_name or self.active_speaker_id)
                        if self.on_tool_call:
                            asyncio.create_task(self.on_tool_call(fcalls, self))
                    else:
                        self._pending_tool_calls.extend(fcalls)

                out_tr = sc.get('outputTranscription')
                if isinstance(out_tr, dict) and out_tr.get('text'):
                    self._pending_out_trans.append(str(out_tr['text']))

                parts = (sc.get('modelTurn') or {}).get('parts') or []
                for p in parts:
                    inl = p.get('inlineData') or {}
                    if 'audio/pcm' in str(inl.get('mimeType') or ''):
                        b64_raw = inl.get('data') or ''
                        if b64_raw and self.on_pcm_48k_stereo and self._turn_redirected_to is None:
                            stereo_48k, self._out_prev_sample = await asyncio.get_running_loop().run_in_executor(
                                _AUDIO_DSP_POOL,
                                _decode_and_upsample_24k_to_48k,
                                b64_raw,
                                self._out_prev_sample,
                            )
                            if stereo_48k:
                                if is_engaged:
                                    await self.on_pcm_48k_stereo(stereo_48k)
                                else:
                                    self._gate_buf.extend(stereo_48k)

                if sc.get('turnComplete'):
                    self._out_prev_sample = None
                    in_txt = ''.join(self._pending_in_trans).strip()
                    out_txt = ''.join(self._pending_out_trans).strip()
                    self._pending_in_trans.clear()
                    self._pending_out_trans.clear()

                    redirect_spec = self._turn_redirected_to or (detect_addressed_persona(in_txt) if in_txt else None)
                    if redirect_spec and redirect_spec.get('id') != self.persona_id and self.on_persona_redirect:
                        self._gate_buf.clear()
                        self._pending_tool_calls.clear()
                        self._turn_redirected_to = None
                        self._turn_wake_authorized = False
                        log.info('GeminiLive redirecting turn chat=%s from=%s to=%s in="%s"', self.chat_id, self.persona_id, redirect_spec.get('id'), in_txt[:120])
                        await self.on_persona_redirect(redirect_spec, in_txt, self)
                        continue

                    if not is_engaged and in_txt and WAKE_CALL_RE.search(in_txt):
                        is_engaged = True
                        self._turn_wake_authorized = True
                        if self.on_wake_engaged:
                            try:
                                self.on_wake_engaged()
                            except Exception:
                                pass

                    if not is_engaged:
                        self._gate_buf.clear()
                        self._pending_tool_calls.clear()
                        self._turn_redirected_to = None
                        self._turn_wake_authorized = False
                        if in_txt:
                            log.info('GeminiLive ignored unaddressed idle speech chat=%s in="%s"', self.chat_id, in_txt[:120])
                        continue

                    if self._gate_buf and self.on_pcm_48k_stereo:
                        flushed_pcm = bytes(self._gate_buf)
                        self._gate_buf.clear()
                        await self.on_pcm_48k_stereo(flushed_pcm)
                    if self._pending_tool_calls and self.on_tool_call:
                        flushed_tc = list(self._pending_tool_calls)
                        self._pending_tool_calls.clear()
                        asyncio.create_task(self.on_tool_call(flushed_tc, self))

                    self._turn_redirected_to = None
                    self._turn_wake_authorized = False
                    if self.on_wake_engaged and (in_txt or out_txt):
                        try:
                            self.on_wake_engaged()
                        except Exception:
                            pass
                    if in_txt or out_txt:
                        log.info('GeminiLive turnComplete persona=%s speaker=%s in="%s" out="%s"', self.persona_id, self.active_speaker_name or self.active_speaker_id, in_txt[:140], out_txt[:140])
                    if (in_txt or out_txt) and self.on_transcription:
                        await self.on_transcription({
                            'input_text': in_txt,
                            'output_text': out_txt,
                            'speaker_id': self.active_speaker_id,
                            'speaker_name': self.active_speaker_name,
                        })
                    if self.on_turn_complete:
                        await self.on_turn_complete()
        except asyncio.CancelledError:
            pass
        except Exception as err:
            log.warning('GeminiLive recv_loop error (%s): %s', type(err).__name__, str(err)[:200])
        finally:
            self._awaiting_blocking_tools.clear()
            close_code = close_frame_code if close_frame_code is not None else (getattr(self._ws, 'close_code', None) if self._ws is not None else None)
            close_reason = close_frame_reason or (getattr(self._ws, 'close_reason', None) if self._ws is not None else '')
            if close_code == 1007:
                self.session_handle = None
            if close_code is not None:
                log.info('GeminiLive ws closed chat=%s code=%s reason=%s', self.chat_id, close_code, str(close_reason or '')[:120])
            self.connected = False
            if self.on_close and not self.closed:
                try:
                    await self.on_close(close_code)
                except Exception:
                    pass

    async def send_audio_stream_end(self) -> bool:
        """Notify Gemini Live that the active microphone speech burst ended so server VAD commits cleanly."""
        if not self.connected or self._ws is None or self._awaiting_blocking_tools:
            self._in_buf.clear()
            return False
        tail = bytes(self._in_buf)
        self._in_buf.clear()
        while tail:
            part = tail[:1280]
            tail = tail[1280:]
            if len(part) < 1280:
                part = part + (b'\x00' * (1280 - len(part)))
            await self._send_realtime_audio(part)
        async with self._send_lock:
            if not self.connected or self._ws is None:
                return False
            try:
                maybe = self._ws.send_json({'realtimeInput': {'audioStreamEnd': True}})
                if asyncio.iscoroutine(maybe):
                    await maybe
                return True
            except Exception as err:
                log.debug('GeminiLive audioStreamEnd error (%s): %s', type(err).__name__, str(err)[:120])
                return False

    async def flush_tail(self):
        """Pad any partial `<40ms` input PCM tail + emit audioStreamEnd so Gemini VAD ends turns cleanly."""
        await self.send_audio_stream_end()

    async def push_pcm_chunk(
        self,
        pcm_bytes: bytes,
        src_rate: int = 36000,
        channels: int = 1,
        *,
        speaker_id: int | None = None,
        speaker_name: str = '',
    ):
        """Convert incoming PCM to 16 kHz mono and stream in 40ms WebSocket chunks."""
        if not self.connected or self._ws is None or not pcm_bytes:
            return
        if speaker_id is not None:
            self.active_speaker_id = int(speaker_id)
        if speaker_name:
            self.active_speaker_name = str(speaker_name)
        pcm_16k = await asyncio.get_running_loop().run_in_executor(
            _AUDIO_DSP_POOL,
            resample_pcm_to_16k_mono,
            pcm_bytes,
            src_rate,
            channels,
        )
        if not pcm_16k:
            return
        self._in_buf.extend(pcm_16k)
        # 40ms @ 16 kHz mono s16le = 1280 bytes (within 20ms-100ms guide recommendation)
        chunk_target = 1280
        chunks_to_send = []
        while len(self._in_buf) >= chunk_target:
            chunks_to_send.append(bytes(self._in_buf[:chunk_target]))
            del self._in_buf[:chunk_target]
        for part in chunks_to_send:
            await self._send_realtime_audio(part)

    async def send_context_update(self, summary_text: str) -> bool:
        """Silently update Lancy's live room/deck awareness without triggering an unsolicited reply."""
        clean = str(summary_text or '').strip()
        if not clean or not self.connected or self._ws is None:
            return False
        async with self._send_lock:
            if not self.connected or self._ws is None:
                return False
            try:
                await self._ws.send_json({
                    'clientContent': {
                        'turns': [{'role': 'user', 'parts': [{'text': f'[ROOM STATE UPDATE: {clean[:500]}]'}]}],
                        'turnComplete': False,
                    }
                })
                return True
            except Exception:
                return False

    async def send_text_turn(self, prompt_text: str) -> bool:
        """Send an immediate text turn (`turnComplete: True`) for seamless cross-persona voice handoff."""
        clean = str(prompt_text or '').strip()
        if not clean or not self.connected or self._ws is None:
            return False
        self._turn_wake_authorized = True
        async with self._send_lock:
            if not self.connected or self._ws is None:
                return False
            try:
                await self._ws.send_json({
                    'clientContent': {
                        'turns': [{'role': 'user', 'parts': [{'text': clean[:1200]}]}],
                        'turnComplete': True,
                    }
                })
                return True
            except Exception:
                return False

    async def _send_realtime_audio(self, pcm_16k_mono: bytes):
        if not self.connected or self._ws is None or not pcm_16k_mono or self._awaiting_blocking_tools:
            return
        async with self._send_lock:
            if not self.connected or self._ws is None or self._awaiting_blocking_tools:
                return
            try:
                await self._ws.send_json({
                    'realtimeInput': {
                        'audio': {
                            'mimeType': 'audio/pcm;rate=16000',
                            'data': base64.b64encode(pcm_16k_mono).decode('ascii'),
                        }
                    }
                })
            except Exception as err:
                log.debug('GeminiLive send audio error (%s): %s', type(err).__name__, str(err)[:120])
                self.connected = False

    async def send_tool_response(self, call_id: str, name: str, response: dict | None, *, scheduling: str | None = None):
        """Send strict structured FunctionResponse (with NON_BLOCKING `scheduling` when applicable)."""
        self._awaiting_blocking_tools.discard(str(call_id))
        if not self.connected or self._ws is None:
            return False
        self._turn_wake_authorized = True
        payload_resp = dict(response) if isinstance(response, dict) and response else {}
        if not payload_resp:
            payload_resp = {'status': 'error', 'retryable': False, 'message': 'Tool returned no response payload.'}
        elif 'status' not in payload_resp:
            payload_resp['status'] = 'ok' if payload_resp.get('ok', True) else 'error'
        payload_resp.setdefault('retryable', False)
        payload_resp.setdefault('message', 'Completed.')
        if str(name) not in _BLOCKING_LIVE_TOOLS:
            payload_resp.setdefault('scheduling', scheduling or 'WHEN_IDLE')
        async with self._send_lock:
            if not self.connected or self._ws is None:
                return False
            await self._ws.send_json({
                'toolResponse': {
                    'functionResponses': [{
                        'id': str(call_id),
                        'name': str(name),
                        'response': payload_resp,
                    }]
                }
            })
        return True

    async def send_turn_audio_or_text(
        self,
        *,
        pcm_16k_mono: bytes = b'',
        text_context: str = '',
        on_pcm_48k_stereo=None,
        on_tool_call=None,
        on_interrupted=None,
        timeout_sec: float = 8.0,
    ) -> dict:
        """One-shot helper when caller manages the turn without background reader."""
        if not self.connected or self._ws is None:
            return {'ok': False, 'error': 'NOT_CONNECTED'}
        t0 = time.monotonic()
        if pcm_16k_mono:
            await self._send_realtime_audio(pcm_16k_mono)
        if text_context:
            await self._ws.send_json({
                'clientContent': {
                    'turns': [{'role': 'user', 'parts': [{'text': text_context}]}],
                    'turnComplete': True,
                }
            })
        first_audio_ms = None
        total_out_bytes = 0
        tool_calls = []
        interrupted = False
        deadline = time.monotonic() + float(timeout_sec)
        while time.monotonic() < deadline:
            rem = max(0.2, deadline - time.monotonic())
            try:
                msg = await asyncio.wait_for(self._ws.receive(), timeout=rem)
            except asyncio.TimeoutError:
                break
            raw = msg.data.decode('utf-8', 'replace') if isinstance(msg.data, (bytes, bytearray)) else str(msg.data or '')
            if not raw:
                break
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            upd = obj.get('sessionResumptionUpdate')
            if isinstance(upd, dict) and upd.get('newHandle'):
                self.session_handle = str(upd['newHandle'])
            tc = obj.get('toolCall')
            if isinstance(tc, dict) and tc.get('functionCalls'):
                tool_calls.extend(tc['functionCalls'])
                if on_tool_call:
                    await on_tool_call(tc['functionCalls'])
            sc = obj.get('serverContent') or {}
            if sc.get('interrupted'):
                interrupted = True
                if on_interrupted:
                    await on_interrupted()
                break
            parts = (sc.get('modelTurn') or {}).get('parts') or []
            for p in parts:
                inl = p.get('inlineData') or {}
                if 'audio/pcm' in str(inl.get('mimeType') or ''):
                    pcm_24k = base64.b64decode(inl.get('data') or '')
                    if pcm_24k:
                        if first_audio_ms is None:
                            first_audio_ms = round((time.monotonic() - t0) * 1000.0, 1)
                        stereo_48k = pcm_24k_mono_to_48k_stereo(pcm_24k)
                        total_out_bytes += len(stereo_48k)
                        if on_pcm_48k_stereo and stereo_48k:
                            await on_pcm_48k_stereo(stereo_48k)
            if sc.get('turnComplete'):
                break
        return {
            'ok': bool(total_out_bytes > 0 or tool_calls),
            'first_audio_latency_ms': first_audio_ms,
            'audio_bytes_48k_stereo': total_out_bytes,
            'tool_calls': tool_calls,
            'interrupted': interrupted,
        }

    async def _close_transport(self):
        self.connected = False
        if self._recv_task is not None and not self._recv_task.done():
            self._recv_task.cancel()
            await asyncio.gather(self._recv_task, return_exceptions=True)
        self._recv_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        if self._sess is not None:
            try:
                await self._sess.close()
            except Exception:
                pass
            self._sess = None

    async def close(self):
        self.closed = True
        await self._close_transport()
