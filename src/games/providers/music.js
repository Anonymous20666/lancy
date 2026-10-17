/**
 * Live Music & Lyrics Provider for Lancy Game Arena:
 * 1. Guess the Song (Live 30s audio stream from Deezer/iTunes + 4 Multiple-Choice Options + Typed Sniping)
 * 2. Finish the Lyric / Chorus (Iconic, recognizable choruses with Nigerian/Afrobeats, Global Pop & Hip-Hop categories)
 */

export const MUSIC_CATEGORIES = {
  afro: { id: 'afro', label: '🇳🇬 Naija & Afrobeats', shortLabel: '🇳🇬 Naija/Afro' },
  pop: { id: 'pop', label: '🌍 Global Pop', shortLabel: '🌍 Global Pop' },
  rap: { id: 'rap', label: '🎤 Hip-Hop & R&B', shortLabel: '🎤 Rap & R&B' },
  all: { id: 'all', label: '🔥 All Viral Hits', shortLabel: '🔥 All Mix' }
};

const AFRO_SONG_SEEDS = [
  'Burna Boy Last Last', 'Burna Boy City Boys', 'Burna Boy Ye', 'Burna Boy On The Low', 'Burna Boy Location', 'Burna Boy Higher',
  'Wizkid Essence', 'Wizkid Ojuelegba', 'Wizkid Joro', 'Wizkid Piece of My Heart', 'Wizkid Kese', 'Wizkid Fever',
  'Davido Unavailable', 'Davido Kante', 'Davido Feel', 'Davido Fall', 'Davido FIA', 'Davido If', 'Davido Awuke',
  'Rema Calm Down', 'Rema Ozeba', 'Rema Benin Boys', 'Rema Charm', 'Rema Woman', 'Rema Dumebi', 'Rema Holiday',
  'Asake Lonely At The Top', 'Asake Active', 'Asake Sungba', 'Asake Terminator', 'Asake 2:30', 'Asake Amapiano', 'Asake Remember',
  'Ayra Starr Rush', 'Ayra Starr Commas', 'Ayra Starr Sability', 'Ayra Starr Bloody Samaritan', 'Ayra Starr Bad Vibes',
  'Tems Love Me JeJe', 'Tems Me & U', 'Tems Free Mind', 'Tems Burning',
  'Omah Lay Soso', 'Omah Lay Holy Ghost', 'Omah Lay Understand', 'Omah Lay Moving', 'Omah Lay Bad Influence',
  'Kizz Daniel Buga', 'Kizz Daniel Twe Twe', 'Kizz Daniel Cough', 'Kizz Daniel Marhaba',
  'Shallipopi Elon Musk', 'Shallipopi Ex Convict', 'Shallipopi Cast', 'Shallipopi Oscroh',
  'Odumodublvck Declan Rice', 'Odumodublvck Blood On The Dance Floor', 'OdumodublvckPicanto',
  'Fireboy DML Peru', 'Fireboy DML Bandana', 'Fireboy DML Vibration', 'Fireboy DML Everyday',
  'Seyi Vibez Different Pattern', 'Seyi Vibez Hat-trick', 'Seyi Vibez Cana',
  'Oxlade Ku Lo Sa', 'CKay Love Nwantiti', 'CKay Emiliana',
  'Ruger Asiwaju', 'Ruger Dior', 'Victony Soweto', 'Victony Stubborn',
  'BNXN Finesse', 'BNXN Gwagwalada', 'Young Jonn Aquafina', 'Young Jonn Big Big Things',
  'Adekunle Gold Party No Dey Stop', 'Adekunle Gold Rodo', 'Chike Egwu',
  'Mohbad Peace', 'Mohbad Ask About Me', 'Zinoleesky Personal', 'Joeboy Baby',
  'Tekno Pana', 'Flavour Big Baller', 'Pheelz Finesse', 'Lojay Monalisa', 'Tyla Water'
];

const POP_SONG_SEEDS = [
  'The Weeknd Blinding Lights', 'The Weeknd Starboy', 'The Weeknd Save Your Tears',
  'Billie Eilish Birds of a Feather', 'Billie Eilish Bad Guy', 'Billie Eilish Lunch',
  'Sabrina Carpenter Espresso', 'Sabrina Carpenter Please Please Please',
  'Bruno Mars Die With A Smile', 'Bruno Mars APT', 'Bruno Mars 24K Magic',
  'Olivia Rodrigo Vampire', 'Olivia Rodrigo Good 4 U', 'Olivia Rodrigo Drivers License',
  'Taylor Swift Cruel Summer', 'Taylor Swift Anti-Hero',
  'Dua Lipa Levitating', 'Dua Lipa Don\'t Start Now', 'Dua Lipa Houdini',
  'Ariana Grande We Can\'t Be Friends', 'Ariana Grande 7 Rings',
  'Rihanna Diamonds', 'Rihanna Umbrella', 'Beyonce Cuff It', 'Beyonce Texas Hold Em',
  'Post Malone Sunflower', 'Harry Styles As It Was', 'Coldplay Viva La Vida'
];

const RAP_SONG_SEEDS = [
  'Kendrick Lamar Not Like Us', 'Kendrick Lamar Luther', 'Kendrick Lamar HUMBLE', 'Kendrick Lamar Money Trees',
  'Drake God\'s Plan', 'Drake One Dance', 'Drake Jimmy Cooks', 'Drake Passionfruit',
  'Travis Scott FE!N', 'Travis Scott SICKO MODE', 'Travis Scott Goosebumps',
  'SZA Kill Bill', 'SZA Snooze', 'SZA Saturn', 'SZA Good Days',
  'Future Wait For U', 'Future Like That', 'Metro Boomin Creepin',
  'Central Cee Doja', 'Central Cee Band4Band', 'Dave Sprinter',
  '21 Savage redrum', 'Don Toliver Bandit', 'Juice WRLD Lucid Dreams',
  'Playboi Carti Timeless', 'Nicki Minaj Super Bass', 'Megan Thee Stallion Mamushi'
];

function getSeedsForCategory(category = 'afro') {
  const cat = String(category || 'afro').toLowerCase();
  if (cat === 'afro' || cat === 'naija') return AFRO_SONG_SEEDS;
  if (cat === 'pop') return POP_SONG_SEEDS;
  if (cat === 'rap' || cat === 'rnb') return RAP_SONG_SEEDS;
  return [...AFRO_SONG_SEEDS, ...POP_SONG_SEEDS, ...RAP_SONG_SEEDS];
}

function getDecoyTracksForCategory(category = 'afro', excludeTitle = '') {
  const pool = getSeedsForCategory(category);
  const cleanEx = String(excludeTitle || '').toLowerCase();
  const candidates = pool.filter((s) => !s.toLowerCase().includes(cleanEx));
  return candidates.sort(() => Math.random() - 0.5).slice(0, 3);
}

function buildFourSongOptions(correctLabel, category = 'afro') {
  const decoys = getDecoyTracksForCategory(category, correctLabel.split('—')[0].trim());
  const all = [correctLabel, ...decoys].slice(0, 4);
  while (all.length < 4) {
    all.push('Burna Boy — Last Last');
  }
  const shuffled = [...all].sort(() => Math.random() - 0.5);
  return {
    options: shuffled,
    correctIndex: shuffled.indexOf(correctLabel)
  };
}

function cleanTrackTitle(raw = '') {
  return String(raw)
    .replace(/\s*[\(\[][^)\]]*(feat\.?|ft\.?|with|remix|version|edit|remaster|live|deluxe|bonus|from|official)[^)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*(Single|EP|Remastered.*|feat\..*)$/i, '')
    .trim();
}

function maskWordPattern(str = '') {
  return String(str)
    .split(/\s+/)
    .map((w) => {
      if (w.length <= 2) return w[0] + '_';
      return w[0] + '_'.repeat(Math.min(6, w.length - 2)) + w[w.length - 1];
    })
    .join('  ');
}

async function fetchAudioBuffer(url, timeoutMs = 5000) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 5000 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Fetches a live playable mystery song with 30s audio buffer, 4 multiple-choice buttons, and progressive hints.
 */
export async function getLiveSongChallenge({ seenIds = new Set(), musicCategory = 'afro' } = {}) {
  const cat = MUSIC_CATEGORIES[musicCategory] ? musicCategory : 'afro';
  const genreLabel = MUSIC_CATEGORIES[cat].label;
  const seedPool = getSeedsForCategory(cat);
  const shuffledSeeds = [...seedPool].sort(() => Math.random() - 0.5);

  for (const seed of shuffledSeeds.slice(0, 5)) {
    try {
      // 1. Try Deezer API first (provides direct MP3 previewUrl that plays natively everywhere in Telegram)
      const dzCtrl = new AbortController();
      const dzTimer = setTimeout(() => dzCtrl.abort(), 4000);
      const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(seed)}&limit=10`, {
        signal: dzCtrl.signal
      });
      clearTimeout(dzTimer);

      if (dzRes.ok) {
        const dzJson = await dzRes.json();
        const tracks = (dzJson?.data || []).filter(
          (t) => t?.preview && t?.title && !seenIds.has(`song_dz_${t.id}`)
        );
        if (tracks.length > 0) {
          const picked = tracks[0];
          const audioBuffer = await fetchAudioBuffer(picked.preview);
          if (audioBuffer) {
            const cleanTitle = cleanTrackTitle(picked.title_short || picked.title);
            const artist = picked.artist?.name || seed.split(' ')[0];
            const choiceLabel = `${artist} — ${cleanTitle}`;
            const { options, correctIndex } = buildFourSongOptions(choiceLabel, cat);

            return {
              id: `song_dz_${picked.id}`,
              name: cleanTitle,
              displayName: `${cleanTitle} — ${artist}`,
              artist,
              genreLabel,
              audioBuffer,
              audioFilename: 'mystery_beat.mp3',
              audioContentType: 'audio/mpeg',
              coverUrl: picked.album?.cover_big || picked.album?.cover_medium || null,
              options,
              correctIndex,
              difficulty: 'EASY',
              hint1: `🎤 Artist: ${artist} • Vibe: ${genreLabel}`,
              hint2: `🔤 Song Title Pattern: ${maskWordPattern(cleanTitle)}`,
              aliases: Array.from(new Set([
                cleanTitle.toLowerCase(),
                picked.title.toLowerCase(),
                `${cleanTitle} ${artist}`.toLowerCase(),
                `${artist} ${cleanTitle}`.toLowerCase(),
                artist.toLowerCase()
              ]))
            };
          }
        }
      }

      // 2. Fallback to iTunes Search API
      const itCtrl = new AbortController();
      const itTimer = setTimeout(() => itCtrl.abort(), 4000);
      const itRes = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(seed)}&entity=song&limit=10`,
        { signal: itCtrl.signal }
      );
      clearTimeout(itTimer);

      if (itRes.ok) {
        const itJson = await itRes.json();
        const tracks = (itJson?.results || []).filter(
          (t) => t?.previewUrl && t?.trackName && !seenIds.has(`song_it_${t.trackId}`)
        );
        if (tracks.length > 0) {
          const picked = tracks[0];
          const audioBuffer = await fetchAudioBuffer(picked.previewUrl);
          if (audioBuffer) {
            const cleanTitle = cleanTrackTitle(picked.trackName);
            const artist = picked.artistName || seed.split(' ')[0];
            const year = picked.releaseDate ? picked.releaseDate.slice(0, 4) : '2024';
            const choiceLabel = `${artist} — ${cleanTitle}`;
            const { options, correctIndex } = buildFourSongOptions(choiceLabel, cat);

            return {
              id: `song_it_${picked.trackId}`,
              name: cleanTitle,
              displayName: `${cleanTitle} — ${artist} (${year})`,
              artist,
              genreLabel,
              audioBuffer,
              audioFilename: 'mystery_beat.m4a',
              audioContentType: 'audio/mp4',
              coverUrl: picked.artworkUrl100?.replace('100x100bb', '600x600bb') || null,
              options,
              correctIndex,
              difficulty: 'EASY',
              hint1: `🎤 Artist: ${artist} • Released: ${year}`,
              hint2: `🔤 Song Title Pattern: ${maskWordPattern(cleanTitle)}`,
              aliases: Array.from(new Set([
                cleanTitle.toLowerCase(),
                picked.trackName.toLowerCase(),
                `${cleanTitle} ${artist}`.toLowerCase(),
                artist.toLowerCase()
              ]))
            };
          }
        }
      }
    } catch {
      // try next seed
    }
  }

  // Instant Fallback if audio stream couldn't be fetched
  const { options, correctIndex } = buildFourSongOptions('Burna Boy — Last Last', 'afro');
  return {
    id: `song_fb_${Date.now()}`,
    name: 'Last Last',
    displayName: 'Last Last — Burna Boy',
    artist: 'Burna Boy',
    genreLabel,
    audioBuffer: null,
    options,
    correctIndex,
    difficulty: 'EASY',
    promptOverride: '🎵 "E don cast, last last, na everybody go chop breakfast!"',
    hint1: '🎤 Artist: Burna Boy (Love, Damini)',
    hint2: '🔤 Pattern: L__t  L__t',
    aliases: ['last last', 'burna boy', 'breakfast']
  };
}

/**
 * Iconic, famous & fun Finish-the-Lyric Choruses (Heavy Nigerian / Afrobeats + Global Hits).
 * Designed so players immediately recognize the vibe and can either click A/B/C/D or type the word!
 */
const CURATED_LYRIC_CHALLENGES = [
  // ── 🇳🇬 NIGERIAN / AFROBEATS ANTHEMS ──
  {
    id: 'lyr_ng_1',
    category: 'afro',
    context: '🇳🇬 Burna Boy — "Last Last"',
    quote: 'E don cast, last last, na everybody go chop ______!',
    answer: 'breakfast',
    options: ['breakfast', 'dinner', 'wahala', 'heartbreak'],
    hint1: 'Nigerian slang for heartbreak / morning meal',
    aliases: ['breakfast', 'last last']
  },
  {
    id: 'lyr_ng_2',
    category: 'afro',
    context: '🇳🇬 Rema — "Calm Down"',
    quote: 'Baby, calm down, calm down / Girl, this your body e put my ______ for lockdown!',
    answer: 'heart',
    options: ['heart', 'mind', 'soul', 'body'],
    hint1: 'Beats inside your chest (5 letters)',
    aliases: ['heart', 'calm down']
  },
  {
    id: 'lyr_ng_3',
    category: 'afro',
    context: '🇳🇬 Davido — "Unavailable"',
    quote: 'I\'m unavailable, dem no dey see ______! (Whoosh!)',
    answer: 'me',
    options: ['me', 'us', 'you', 'money'],
    hint1: '2-letter pronoun — "Dem no dey see ___"',
    aliases: ['me', 'unavailable']
  },
  {
    id: 'lyr_ng_4',
    category: 'afro',
    context: '🇳🇬 Asake — "Lonely At The Top"',
    quote: 'It\'s lonely at the ______, lonely, lonely, lonely / Money on my mind,Focus on my grind!',
    answer: 'top',
    options: ['top', 'peak', 'club', 'bank'],
    hint1: 'Opposite of bottom (3 letters)',
    aliases: ['top', 'lonely at the top']
  },
  {
    id: 'lyr_ng_5',
    category: 'afro',
    context: '🇳🇬 Ayra Starr — "Rush"',
    quote: 'E dey rush, e dey rush / E dey push,ודות e deyuff / Na onlychetta I dey ______!',
    answer: 'count',
    options: ['count', 'spend', 'chase', 'stack'],
    hint1: 'What you do with money / numbers',
    aliases: ['count', 'rush']
  },
  {
    id: 'lyr_ng_6',
    category: 'afro',
    context: '🇳🇬 Wizkid ft. Tems — "Essence"',
    quote: 'You don\'t need no other ______, Only you fi hold my body!',
    answer: 'body',
    options: ['body', 'lover', 'person', 'touch'],
    hint1: 'Rhymes with "hold my ___" (4 letters)',
    aliases: ['body', 'essence']
  },
  {
    id: 'lyr_ng_7',
    category: 'afro',
    context: '🇳🇬 Kizz Daniel & Tekno — "Buga"',
    quote: 'Let me see you go low, lo-lo / ______, won lo!',
    answer: 'buga',
    options: ['buga', 'japa', 'jaiye', 'shayo'],
    hint1: 'Title of the viral shoulder-flexing anthem!',
    aliases: ['buga', 'buga won']
  },
  {
    id: 'lyr_ng_8',
    category: 'afro',
    context: '🇳🇬 Omah Lay — "Soso"',
    quote: 'Soso, take my ______ away / Soso,ardon my sins I pray!',
    answer: 'pain',
    options: ['pain', 'stress', 'tears', 'shame'],
    hint1: '4-letter word: "Soso take my ___ away"',
    aliases: ['pain', 'soso']
  },
  {
    id: 'lyr_ng_9',
    category: 'afro',
    context: '🇳🇬 Burna Boy — "City Boys"',
    quote: 'City boys, city ______! / When you see me, better lemme be!',
    answer: 'boys',
    options: ['boys', 'kings', 'vibes', 'life'],
    hint1: 'Second word of the song title',
    aliases: ['boys', 'city boys']
  },
  {
    id: 'lyr_ng_10',
    category: 'afro',
    context: '🇳🇬 Shallipopi — "Elon Musk"',
    quote: 'Pluto Presido! Pass me the ______, make I puff pass!',
    answer: 'lighter',
    options: ['lighter', 'money', 'champagne', 'speaker'],
    hint1: 'Used to spark a flame',
    aliases: ['lighter', 'elon musk']
  },
  {
    id: 'lyr_ng_11',
    category: 'afro',
    context: '🇳🇬 Fireboy DML — "Peru"',
    quote: 'Pour me water, holy water / I\'m in San Francisco, jamming in ______!',
    answer: 'peru',
    options: ['peru', 'lagos', 'london', 'paris'],
    hint1: 'South American country & title of the song!',
    aliases: ['peru']
  },
  {
    id: 'lyr_ng_12',
    category: 'afro',
    context: '🇳🇬 Odumodublvck — "Declan Rice"',
    quote: 'Active! They call me Declan ______, I dey clear am!',
    answer: 'rice',
    options: ['rice', 'james', 'cole', 'kane'],
    hint1: 'Arsenal & England midfielder\'s last name',
    aliases: ['rice', 'declan rice']
  },
  {
    id: 'lyr_ng_13',
    category: 'afro',
    context: '🇳🇬 BNXN & Pheelz — "Finesse"',
    quote: 'Ahh, Finesse! If I broke, na my ______!',
    answer: 'business',
    options: ['business', 'problem', 'wahala', 'matter'],
    hint1: '"Folake for the night o, if I broke na my ___!"',
    aliases: ['business', 'finesse']
  },
  {
    id: 'lyr_ng_14',
    category: 'afro',
    context: '🇳🇬 Davido — "Fall"',
    quote: 'Money fall on you, ______ fall on you / Prada fall on you!',
    answer: 'banana',
    options: ['banana', 'dollar', 'blessing', 'diamond'],
    hint1: 'Iconic yellow fruit in Davido\'s famous chorus!',
    aliases: ['banana', 'fall']
  },
  {
    id: 'lyr_ng_15',
    category: 'afro',
    context: '🇳🇬 Asake — "Sungba"',
    quote: 'Sungba! Fo\'ju mi, omo, baby, no dey ______!',
    answer: 'form',
    options: ['form', 'run', 'hide', ' dull'],
    hint1: 'Naija slang for acting aloof / playing hard to get',
    aliases: ['form', 'sungba']
  },
  {
    id: 'lyr_ng_16',
    category: 'afro',
    context: '🇳🇬 CKay — "Love Nwantiti"',
    quote: 'My baby, my Valentine / Girl, na you dey make my temperature ______!',
    answer: 'rise',
    options: ['rise', 'drop', 'burn', 'glow'],
    hint1: 'Go up (4 letters)',
    aliases: ['rise', 'love nwantiti']
  },
  {
    id: 'lyr_ng_17',
    category: 'afro',
    context: '🇳🇬 Oxlade — "KU LO SA"',
    quote: 'Omo, I want to make you mine / Girl, you dey make me want to ______ closer!',
    answer: 'ku lo sa',
    options: ['ku lo sa', 'pull up', 'dance', 'slide'],
    hint1: 'Title of Oxlade\'s COLORS mega-hit!',
    aliases: ['ku lo sa', 'kulosa']
  },
  {
    id: 'lyr_ng_18',
    category: 'afro',
    context: '🇳🇬 Ayra Starr — "Commas"',
    quote: 'I dey carry my ______, I dey carry my grace / Put some more commas for my bank account!',
    answer: 'steez',
    options: ['steez', 'vibes', 'money', 'crown'],
    hint1: 'Gen-Z & Naija word for effortless style & composure',
    aliases: ['steez', 'commas']
  },
  {
    id: 'lyr_ng_19',
    category: 'afro',
    context: '🇳🇬 Rema — "Ozeba"',
    quote: 'Bigstepper, March am! / Omo, na ______ get the city!',
    answer: 'rema',
    options: ['rema', 'benin', 'raver', 'prince'],
    hint1: 'The Afrorave prince himself!',
    aliases: ['rema', 'ozeba']
  },
  {
    id: 'lyr_ng_20',
    category: 'afro',
    context: '🇳🇬 Victony — "Soweto"',
    quote: 'Join my एक्सप्रेस, make we go ______ / Oya, baby, show me the way o!',
    answer: 'soweto',
    options: ['soweto', 'lagos', 'accra', 'miami'],
    hint1: 'Famous South African township & song title',
    aliases: ['soweto']
  },
  {
    id: 'lyr_ng_21',
    category: 'afro',
    context: '🇳🇬 Burna Boy — "Ye"',
    quote: 'I no fit die for nothing / All my people just want to chop ______!',
    answer: 'life',
    options: ['life', 'money', 'food', 'peace'],
    hint1: '"Chop ___" = enjoy living!',
    aliases: ['life', 'ye']
  },
  {
    id: 'lyr_ng_22',
    category: 'afro',
    context: '🇳🇬 Davido — "If"',
    quote: 'Thirty ______ for the akant o! / Versace and Gucci for your body o!',
    answer: 'billion',
    options: ['billion', 'million', 'thousand', 'hundred'],
    hint1: '30BG! (7 letters)',
    aliases: ['billion', '30 billion']
  },
  {
    id: 'lyr_ng_23',
    category: 'afro',
    context: '🇳🇬 Tems — "Love Me JeJe"',
    quote: 'Love me jeje, love me ______ / Everything you need, I get am plenty!',
    answer: 'tender',
    options: ['tender', 'softly', 'always', 'better'],
    hint1: 'Classic Seyi Sodimu / Tems chorus word (6 letters)',
    aliases: ['tender', 'love me jeje']
  },
  {
    id: 'lyr_ng_24',
    category: 'afro',
    context: '🇳🇬 Asake & Travis Scott — "Active"',
    quote: 'Oh man, I\'m ______, I\'m active! / Stepping in the building looking attractive!',
    answer: 'active',
    options: ['active', 'ready', 'chosen', 'winning'],
    hint1: 'Title of the 2024 Lungu Boy smash hit!',
    aliases: ['active']
  },

  // ── 🌍 GLOBAL POP ANTHEMS ──
  {
    id: 'lyr_pop_1',
    category: 'pop',
    context: '🌍 The Weeknd — "Blinding Lights"',
    quote: 'I said, ooh, I\'m blinded by the ______, No, I can\'t sleep until I feel your touch!',
    answer: 'lights',
    options: ['lights', 'night', 'stars', 'flames'],
    hint1: 'Starts with L (6 letters)',
    aliases: ['lights', 'blinding lights']
  },
  {
    id: 'lyr_pop_2',
    category: 'pop',
    context: '🌍 Billie Eilish — "BIRDS OF A FEATHER"',
    quote: 'Birds of a feather, we should stick ______, I know I said I\'d never think I wasn\'t better alone!',
    answer: 'together',
    options: ['together', 'forever', 'whatever', 'closer'],
    hint1: 'Rhymes with feather (8 letters)',
    aliases: ['together']
  },
  {
    id: 'lyr_pop_3',
    category: 'pop',
    context: '🌍 Sabrina Carpenter — "Espresso"',
    quote: 'Say you can\'t sleep, baby, I know / That\'s that me ______!',
    answer: 'espresso',
    options: ['espresso', 'affogato', 'macchiato', 'cappuccino'],
    hint1: 'Coffee shot & title of the summer smash hit!',
    aliases: ['espresso']
  },
  {
    id: 'lyr_pop_4',
    category: 'pop',
    context: '🌍 Lady Gaga & Bruno Mars — "Die With A Smile"',
    quote: 'If the world was ending, I\'d wanna be next to ______!',
    answer: 'you',
    options: ['you', 'home', 'love', 'heaven'],
    hint1: '3-letter word: "next to ___"',
    aliases: ['you', 'die with a smile']
  },
  {
    id: 'lyr_pop_5',
    category: 'pop',
    context: '🌍 ROSÉ & Bruno Mars — "APT."',
    quote: 'Don\'t you want me like I want you, baby? / Sleep tomorrow, but tonight go ______!',
    answer: 'crazy',
    options: ['crazy', 'wild', 'party', 'dancing'],
    hint1: 'Rhymes with baby (5 letters)',
    aliases: ['crazy', 'apt']
  },
  {
    id: 'lyr_pop_6',
    category: 'pop',
    context: '🌍 Rihanna — "Diamonds"',
    quote: 'Shine bright like a ______, We\'re beautiful like diamonds in the sky!',
    answer: 'diamond',
    options: ['diamond', 'crystal', 'starlight', 'sapphire'],
    hint1: 'Precious gem in the song title',
    aliases: ['diamond', 'diamonds']
  },
  {
    id: 'lyr_pop_7',
    category: 'pop',
    context: '🌍 Olivia Rodrigo — "vampire"',
    quote: 'Bleeding me dry like a goddamn ______!',
    answer: 'vampire',
    options: ['vampire', 'monster', 'phantom', 'villain'],
    hint1: 'Title of the GUTS lead single',
    aliases: ['vampire']
  },
  {
    id: 'lyr_pop_8',
    category: 'pop',
    context: '🌍 Tyla — "Water"',
    quote: 'Make me ______, make me hotter / Make me lose my breath, make me water!',
    answer: 'sweat',
    options: ['sweat', 'dance', 'shine', 'smile'],
    hint1: 'Rhymes with breath (5 letters)',
    aliases: ['sweat', 'water']
  },

  // ── 🎤 HIP-HOP, RAP & R&B ──
  {
    id: 'lyr_rap_1',
    category: 'rap',
    context: '🎤 Kendrick Lamar — "Not Like Us"',
    quote: 'They not like us, they not like us — Mustard on the ______, ho!',
    answer: 'beat',
    options: ['beat', 'track', 'mic', 'bass'],
    hint1: 'Producer tag for DJ Mustard (4 letters)',
    aliases: ['beat', 'not like us']
  },
  {
    id: 'lyr_rap_2',
    category: 'rap',
    context: '🎤 SZA — "Kill Bill"',
    quote: 'I might kill my ex, not the best ______, His new girlfriend\'s next, how\'d I get here?',
    answer: 'idea',
    options: ['idea', 'plan', 'move', 'choice'],
    hint1: '4-letter word meaning thought/plan',
    aliases: ['idea', 'kill bill']
  },
  {
    id: 'lyr_rap_3',
    category: 'rap',
    context: '🎤 Travis Scott — "FE!N"',
    quote: 'Just come outside for the ______, Take your time, get your light — FE!N, FE!N, FE!N!',
    answer: 'night',
    options: ['night', 'vibe', 'show', 'rage'],
    hint1: 'Rhymes with light (5 letters)',
    aliases: ['night', 'fein']
  },
  {
    id: 'lyr_rap_4',
    category: 'rap',
    context: '🎤 Drake — "God\'s Plan"',
    quote: 'She say, "Do you love me?" I tell her, "Only ______" / I only love my bed and my momma, I\'m sorry!',
    answer: 'partly',
    options: ['partly', 'maybe', 'sometimes', 'rarely'],
    hint1: 'Famous meme line: "Only ___" (6 letters)',
    aliases: ['partly', 'gods plan']
  },
  {
    id: 'lyr_rap_5',
    category: 'rap',
    context: '🎤 Central Cee & Lil Baby — "BAND4BAND"',
    quote: 'We can go band for ______, F*** that, we can go M for M!',
    answer: 'band',
    options: ['band', 'cash', 'rack', 'stack'],
    hint1: 'Slang for $1,000 & part of the song title',
    aliases: ['band', 'band4band']
  },
  {
    id: 'lyr_rap_6',
    category: 'rap',
    context: '🎤 Future ft. Drake & Tems — "WAIT FOR U"',
    quote: 'I will wait for ______, for you / Early in the morning, late at night!',
    answer: 'you',
    options: ['you', 'love', 'time', 'peace'],
    hint1: 'Last word of the song title',
    aliases: ['you', 'wait for u']
  },
  {
    id: 'lyr_rap_7',
    category: 'rap',
    context: '🎤 SZA — "Snooze"',
    quote: 'I can\'t lose when I\'m with ______, How can I snooze and miss the moment?',
    answer: 'you',
    options: ['you', 'love', 'us', 'him'],
    hint1: 'Rhymes with lose & snooze (3 letters)',
    aliases: ['you', 'snooze']
  }
];

/**
 * Fetches an iconic, fun Finish-the-Lyric challenge filtered by the chat's chosen music category!
 */
export async function getLiveLyricChallenge({ seenIds = new Set(), musicCategory = 'afro' } = {}) {
  const cat = MUSIC_CATEGORIES[musicCategory] ? musicCategory : 'afro';
  const categoryPool = cat === 'all'
    ? CURATED_LYRIC_CHALLENGES
    : CURATED_LYRIC_CHALLENGES.filter((c) => c.category === cat);

  const unseen = categoryPool.filter((c) => !seenIds.has(c.id));
  const activePool = unseen.length > 0 ? unseen : categoryPool;
  const item = activePool[Math.floor(Math.random() * activePool.length)];

  const shuffledOptions = [...item.options].sort(() => Math.random() - 0.5);
  const correctIndex = shuffledOptions.findIndex(
    (opt) => opt.toLowerCase() === item.answer.toLowerCase()
  );

  return {
    id: item.id,
    name: item.answer,
    displayName: `${item.answer.toUpperCase()} (${item.context})`,
    context: item.context,
    quote: item.quote,
    options: shuffledOptions,
    correctIndex: correctIndex >= 0 ? correctIndex : 0,
    difficulty: 'EASY',
    hint1: `💡 Clue: ${item.hint1}`,
    hint2: `🔤 Word Pattern: ${maskWordPattern(item.answer)} (${item.answer.length} letters)`,
    aliases: item.aliases
  };
}
