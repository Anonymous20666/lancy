/**
 * Emoji assignment for stickers — small heuristics so packs feel curated,
 * never random spam. The pack's configured emoji always wins when set.
 */

const MOOD_EMOJIS = {
  cute: ['♡', '🥺', '🌸', '✨', '🐰', '💗', '☁️', '🎀'],
  funny: ['😭', '💀', '😂', '🤡', '😹', '🫠', '🙃', '😮‍💨'],
  rage: ['😤', '💢', '😾', '🔥', '⚡', '😡', '🗯️', '💥'],
  sad: ['😿', '💔', '😞', '🌧️', '🖤', '🥀', '😔', '💧'],
  love: ['🥰', '😘', '💕', '💞', '💘', '❤️‍🔥', '🫶', '🌹'],
  chaos: ['🌀', '🤪', '👁️', '🗿', '🛸', '🧠', '⚠️', '🚨'],
  cool: ['😎', '🕶️', '🧊', '🖤', '✨', '🐍', '🌙', '⭐'],
  anime: ['⚡', '🌸', '👊', '💫', '🎌', '🗾', '🔥', '💢']
};

const ALL = [...new Set(Object.values(MOOD_EMOJIS).flat())];

const QUERY_MOODS = [
  [/cute|kawaii|soft|adorable|fluff/, 'cute'],
  [/rage|angry|mad|furious|unhinged/, 'rage'],
  [/funny|meme|lol|laugh|hilarious/, 'funny'],
  [/sad|cry|tears|melancholy|angst/, 'sad'],
  [/love|heart|romance|date/, 'love'],
  [/chaos|wild|crazy|unhinged|feral/, 'chaos'],
  [/cool|aesthetic|swag|chill/, 'cool'],
  [/anime|manga|gojo|jujutsu|naruto|one piece|demon slayer/, 'anime']
];

export function moodForQuery(query) {
  const q = String(query ?? '').toLowerCase();
  for (const [pattern, mood] of QUERY_MOODS) {
    if (pattern.test(q)) return mood;
  }
  return 'cute';
}

/** Pick 1–3 emojis for a sticker, deterministic per index + mood. */
export function emojisForSticker({ query = '', packEmoji = null, index = 0, assignment = 'auto' } = {}) {
  if (assignment === 'pack' && packEmoji) return [packEmoji];
  if (assignment === 'first') return [ALL[index % ALL.length]];
  if (packEmoji) return [packEmoji, ...pickMoodEmojis(query, index).slice(0, 1)];
  return pickMoodEmojis(query, index).slice(0, 2);
}

function pickMoodEmojis(query, index) {
  const mood = moodForQuery(query);
  const list = MOOD_EMOJIS[mood] ?? ALL;
  // Rotate deterministically so a pack gets a tasteful variety.
  const primary = list[index % list.length];
  const secondary = list[(index * 3 + 1) % list.length];
  return primary === secondary ? [primary] : [primary, secondary];
}
