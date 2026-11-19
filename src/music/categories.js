/**
 * 2026 Music Genres & Categories Directory
 * Covers Mainstream, Band & Instrumental, Dance & Electronic, Soul & Emotional,
 * African & Nigerian, International, Other Popular Listening Styles, and Internet & Underground.
 */

export const MUSIC_CATEGORIES_2026 = [
  {
    id: 'mainstream',
    emoji: '🔥',
    title: 'Mainstream & Trending',
    shortLabel: '🔥 Mainstream',
    subtitle: 'Chart-topping global hits, rap, pop, R&B, Afrobeats & Amapiano',
    seedQuery: 'top global trending hits 2026',
    subgenres: [
      { id: 'hip-hop-rap', name: 'Hip-Hop / Rap', query: 'Hip-Hop Rap top hits', artists: ['Kendrick Lamar', 'Drake', 'Travis Scott', 'Future', 'J. Cole', '21 Savage'], aliases: ['hip hop', 'hiphop', 'rap', 'rap music'] },
      { id: 'pop', name: 'Pop', query: 'Pop hits trending', artists: ['The Weeknd', 'Dua Lipa', 'Billie Eilish', 'Sabrina Carpenter', 'Ariana Grande', 'Taylor Swift'], aliases: ['pop music', 'top pop'] },
      { id: 'rnb', name: 'R&B', query: 'R&B soul hits', artists: ['SZA', 'Chris Brown', 'Brent Faiyaz', 'Summer Walker', 'Usher', 'Bryson Tiller'], aliases: ['r&b', 'r and b', 'rnb music'] },
      { id: 'afrobeats', name: 'Afrobeats', query: 'Afrobeats hits', artists: ['Burna Boy', 'Wizkid', 'Davido', 'Rema', 'Asake', 'Tems', 'Ayra Starr'], aliases: ['afrobeat', 'naija afrobeats'] },
      { id: 'amapiano', name: 'Amapiano', query: 'Amapiano hits', artists: ['Kabza De Small', 'DJ Maphorisa', 'Tyler ICU', 'Uncle Waffles', 'Focalistic', 'Young Stunna'], aliases: ['piano', 'yano', 'sa amapiano'] },
      { id: 'trap', name: 'Trap', query: 'Trap music hits', artists: ['Future', 'Metro Boomin', 'Young Thug', 'Lil Baby', 'Gunna', ' Travis Scott'], aliases: ['trap rap', 'atlanta trap'] },
      { id: 'drill', name: 'Drill', query: 'Drill rap hits', artists: ['Central Cee', 'Pop Smoke', 'Headie One', 'Russ Millions', 'Fivio Foreign', 'Sleepy Hallow'], aliases: ['uk drill', 'ny drill', 'brooklyn drill'] },
      { id: 'phonk', name: 'Phonk', query: 'Phonk music hits', artists: ['KORDHELL', 'DVRST', 'INTERWORLD', 'Playaphonk', 'KSLV Noh', 'Ghostface Playa'], aliases: ['gym phonk', 'phonk edit'] },
      { id: 'afro-pop', name: 'Afro-pop', query: 'Afro-pop hits', artists: ['Tyla', 'Rema', 'Ayra Starr', 'Omah Lay', 'Fireboy DML', 'CKay'], aliases: ['afropop'] },
      { id: 'street-pop', name: 'Street-pop', query: 'Nigerian Street-pop hits', artists: ['Asake', 'Seyivibez', 'Zlatan', 'Naira Marley', 'Shallipopi', 'Portable', 'Bella Shmurda'], aliases: ['street pop', 'naija street', 'trenches'] },
      { id: 'alternative', name: 'Alternative', query: 'Alternative hits', artists: ['Tame Impala', 'Gorillaz', 'Lana Del Rey', 'Twenty One Pilots', 'Glass Animals', 'Arctic Monkeys'], aliases: ['alt', 'alt music'] }
    ]
  },
  {
    id: 'band',
    emoji: '🎸',
    title: 'Band & Instrumental',
    shortLabel: '🎸 Band & Inst.',
    subtitle: 'Rock, indie, metal, jazz, blues, classical & orchestral masterpieces',
    seedQuery: 'rock indie jazz instrumental classics',
    subgenres: [
      { id: 'rock', name: 'Rock', query: 'Rock anthems hits', artists: ['Linkin Park', 'Queen', 'Foo Fighters', ' Imagine Dragons', 'AC/DC', 'Red Hot Chili Peppers'], aliases: ['classic rock', 'rock music'] },
      { id: 'alternative-rock', name: 'Alternative Rock', query: 'Alternative Rock hits', artists: ['Radiohead', 'Muse', 'The Killers', 'Paramore', 'Green Day', 'Nirvana'], aliases: ['alt rock'] },
      { id: 'indie-rock', name: 'Indie Rock', query: 'Indie Rock essential tracks', artists: ['Arctic Monkeys', 'The Strokes', 'Vampire Weekend', 'The 1975', 'Mac DeMarco', 'Fontaines D.C.'], aliases: ['indie'] },
      { id: 'metal', name: 'Metal', query: 'Metal music hits', artists: ['Metallica', 'Slipknot', 'System Of A Down', 'Bring Me The Horizon', 'Korn', 'Deftones'], aliases: ['nu metal', 'modern metal'] },
      { id: 'heavy-metal', name: 'Heavy Metal', query: 'Heavy Metal classics', artists: ['Iron Maiden', 'Black Sabbath', 'Judas Priest', 'Megadeth', 'Pantera', 'Avenged Sevenfold'], aliases: ['thrash metal'] },
      { id: 'punk', name: 'Punk', query: 'Punk rock anthems', artists: ['Blink-182', 'Green Day', 'The Offspring', 'Sum 41', 'My Chemical Romance', 'Ramones'], aliases: ['pop punk', 'punk rock'] },
      { id: 'jazz', name: 'Jazz', query: 'Jazz classics and smooth jazz', artists: ['Miles Davis', 'John Coltrane', 'Kamasi Washington', 'Robert Glasper', 'Norah Jones', 'Chet Baker'], aliases: ['smooth jazz', 'bebop'] },
      { id: 'blues', name: 'Blues', query: 'Blues guitar classics', artists: ['B.B. King', 'Gary Clark Jr.', 'Stevie Ray Vaughan', 'Joe Bonamassa', 'Eric Clapton', 'Muddy Waters'], aliases: ['rhythm and blues', 'delta blues'] },
      { id: 'classical', name: 'Classical', query: 'Classical music masterpieces', artists: ['Ludovico Einaudi', 'Max Richter', 'Yo-Yo Ma', 'Lang Lang', 'Beethoven', 'Mozart'], aliases: ['classical piano', 'piano classics'] },
      { id: 'opera', name: 'Opera', query: 'Opera arias classics', artists: ['Andrea Bocelli', 'Luciano Pavarotti', 'Maria Callas', 'Plácido Domingo', 'Sarah Brightman'], aliases: ['operatic', 'classical vocal'] },
      { id: 'instrumental', name: 'Instrumental', query: 'Instrumental chill guitar beats', artists: ['Polyphia', 'Buckets', 'Nujabes', 'Explosions in the Sky', 'Ludovico Einaudi', 'FKJ'], aliases: ['instrumentals', 'no vocals'] },
      { id: 'orchestral', name: 'Orchestral', query: 'Epic orchestral music', artists: ['Hans Zimmer', 'Two Steps From Hell', 'John Williams', 'Howard Shore', 'Audiomachine'], aliases: ['symphony', 'epic orchestral'] }
    ]
  },
  {
    id: 'electronic',
    emoji: '💃',
    title: 'Dance & Electronic',
    shortLabel: '💃 Dance & EDM',
    subtitle: 'Club anthems, house, techno, drum & bass, Jersey club & UK garage',
    seedQuery: 'electronic dance house club hits',
    subgenres: [
      { id: 'edm', name: 'EDM', query: 'EDM festival anthems', artists: ['Calvin Harris', 'David Guetta', 'Martin Garrix', 'Tiësto', 'Avicii', 'Zedd'], aliases: ['electronic dance music', 'festival edm'] },
      { id: 'house', name: 'House', query: 'House music club hits', artists: ['Fred again..', 'FISHER', 'Disclosure', 'Peggy Gou', 'John Summit', 'Chris Lake'], aliases: ['tech house', 'house music'] },
      { id: 'deep-house', name: 'Deep House', query: 'Deep House chill club mix', artists: ['Black Coffee', 'Lane 8', 'Ben Böhmer', 'Nora En Pure', 'RÜFÜS DU SOL', 'Keinemusik'], aliases: ['melodic house', 'afro deep house'] },
      { id: 'techno', name: 'Techno', query: 'Techno peak time rave', artists: ['Charlotte de Witte', 'Amelie Lens', 'Adam Beyer', 'Anyma', 'Tale Of Us', 'Reinier Zonneveld'], aliases: ['melodic techno', 'hard techno'] },
      { id: 'trance', name: 'Trance', query: 'Trance uplifting anthems', artists: ['Armin van Buuren', 'Above & Beyond', 'Paul van Dyk', 'Ferry Corsten', 'Gareth Emery'], aliases: ['psytrance', 'uplifting trance'] },
      { id: 'dubstep', name: 'Dubstep', query: 'Dubstep bass drops', artists: ['Skrillex', 'Excision', 'Subtronics', 'Zomboy', 'Virtual Riot', 'Illenium'], aliases: ['melodic dubstep', 'riddim'] },
      { id: 'drum-and-bass', name: 'Drum & Bass', query: 'Drum and Bass rollers liquid dnb', artists: ['Chase & Status', 'Sub Focus', 'Wilkinson', 'Dimension', 'Netsky', 'Pendulum'], aliases: ['dnb', 'drum n bass', 'liquid dnb'] },
      { id: 'electro', name: 'Electro', query: 'Electro house synth bangers', artists: ['Daft Punk', 'Justice', 'Deadmau5', 'Boys Noize', 'Gesaffelstein', 'Kavinsky'], aliases: ['electro house'] },
      { id: 'disco', name: 'Disco', query: 'Disco nu-disco dance classics', artists: ['Purple Disco Machine', 'Dua Lipa', 'Bee Gees', 'Earth, Wind & Fire', 'Chic', 'SG Lewis'], aliases: ['nu disco'] },
      { id: 'funk', name: 'Funk', query: 'Funk groove classics', artists: ['Bruno Mars', 'Silk Sonic', 'Anderson .Paak', 'Jamiroquai', 'Thundercat', 'James Brown'], aliases: ['funky', 'boogie'] },
      { id: 'synthwave', name: 'Synthwave', query: 'Synthwave retrowave outrun', artists: ['The Midnight', 'Kavinsky', 'Carpenter Brut', 'FM-84', 'Gunship', 'Timecop1983'], aliases: ['retrowave', 'outrun', 'vaporwave'] },
      { id: 'jersey-club', name: 'Jersey Club', query: 'Jersey Club bounce hits', artists: ['UNIIQU3', 'Cookiee Kawaii', 'Bandmanrill', 'MCVERTT', 'DJ Sliink', 'PinkPantheress'], aliases: ['jersey bounce'] },
      { id: 'uk-garage', name: 'UK Garage', query: 'UK Garage 2-step hits', artists: ['Sammy Virji', 'Conducta', 'Interplanetary Criminal', 'Craig David', 'MJ Cole', 'PinkPantheress'], aliases: ['ukg', '2-step', 'speed garage'] }
    ]
  },
  {
    id: 'soul',
    emoji: '💜',
    title: 'Soul & Emotional',
    shortLabel: '💜 Soul & Vibes',
    subtitle: 'Neo-soul, gospel, worship, reggae, dancehall, acoustic & slow jams',
    seedQuery: 'soul neo-soul gospel reggae slow jams',
    subgenres: [
      { id: 'soul', name: 'Soul', query: 'Soul music classics and modern soul', artists: ['Leon Bridges', 'Michael Kiwanuka', 'Adele', 'Amy Winehouse', 'Marvin Gaye', 'Stevie Wonder'], aliases: ['classic soul', 'motown'] },
      { id: 'neo-soul', name: 'Neo-Soul', query: 'Neo-Soul chill vibes', artists: ['Erykah Badu', 'Daniel Caesar', 'D’Angelo', 'Cleo Sol', 'Lauryn Hill', 'SiR', 'Sonder'], aliases: ['neosoul'] },
      { id: 'alternative-rnb', name: 'Alternative R&B', query: 'Alternative R&B moody vibes', artists: ['Frank Ocean', 'The Weeknd', 'Brent Faiyaz', 'PARTYNEXTDOOR', '6LACK', 'Giveon', 'Kehlani'], aliases: ['alt r&b', 'alt rnb', 'dark rnb'] },
      { id: 'gospel', name: 'Gospel', query: 'Gospel praise and choir hits', artists: ['Kirk Franklin', 'Maverick City Music', 'Tasha Cobbs Leonard', 'Nathaniel Bassey', 'Mercy Chinwo', 'CeCe Winans'], aliases: ['naija gospel', 'praise'] },
      { id: 'christian', name: 'Christian', query: 'Contemporary Christian music hits', artists: ['Lauren Daigle', 'Forrest Frank', 'Brandon Lake', 'Elevation Worship', 'Lecrae', 'Phil Wickham'], aliases: ['ccm', 'christian hip hop'] },
      { id: 'worship', name: 'Worship', query: 'Worship songs soaking praise', artists: ['Elevation Worship', 'Bethel Music', 'Hillsong Worship', 'Dunsin Oyekan', 'Victoria Orenze', 'Moses Bliss'], aliases: ['praise and worship'] },
      { id: 'reggae', name: 'Reggae', query: 'Reggae roots classics', artists: ['Bob Marley & The Wailers', 'Chronixx', 'Koffee', 'Damian Marley', 'Protoje', 'Buju Banton'], aliases: ['roots reggae'] },
      { id: 'dancehall', name: 'Dancehall', query: 'Dancehall party riddims', artists: ['Vybz Kartel', 'Sean Paul', 'Popcaan', 'Shenseea', 'Skillibeng', 'Alkaline', 'Masicka'], aliases: ['jamaican dancehall'] },
      { id: 'lovers-rock', name: 'Lovers Rock', query: 'Lovers Rock smooth reggae romance', artists: ['Beres Hammond', 'Gregory Isaacs', 'Sanchez', 'Maxi Priest', 'Romain Virgo', 'Christopher Martin'], aliases: ['romantic reggae'] },
      { id: 'ska', name: 'Ska', query: 'Ska upbeat brass classics', artists: ['Sublime', 'No Doubt', 'The Specials', 'Madness', 'Reel Big Fish', 'Toots and the Maytals'], aliases: ['ska punk', 'rocksteady'] },
      { id: 'acoustic', name: 'Acoustic', query: 'Acoustic guitar chill songs', artists: ['Ed Sheeran', 'John Mayer', 'Passenger', 'Vance Joy', 'Hozier', 'Noah Kahan'], aliases: ['unplugged', 'acoustic pop'] },
      { id: 'slow-jam', name: 'Slow Jam', query: 'Slow Jams late night R&B romance', artists: ['Usher', 'Boyz II Men', 'Jhené Aiko', 'Summer Walker', 'Ginuwine', 'Keith Sweat', 'Giveon'], aliases: ['slow jams', 'bedroom rnb'] }
    ]
  },
  {
    id: 'african',
    emoji: '🌍',
    title: 'African & Nigerian',
    shortLabel: '🌍 African & Naija',
    subtitle: 'Afrobeats, Amapiano, Highlife, Fuji, Apala, Alte, Bongo Flava & Gqom',
    seedQuery: 'Nigerian Afrobeats African hits 2026',
    subgenres: [
      { id: 'afrobeats-ng', name: 'Afrobeats', query: 'Nigerian Afrobeats top hits', artists: ['Burna Boy', 'Wizkid', 'Davido', 'Asake', 'Rema', 'Olamide', 'Kizz Daniel'], aliases: ['naija', 'nigerian music'] },
      { id: 'amapiano-af', name: 'Amapiano', query: 'South African Amapiano club hits', artists: ['Kabza De Small', 'DJ Maphorisa', 'Kelvin Momo', 'Tyla', 'Musa Keys', 'Daliwonga'], aliases: ['sa piano', 'private school amapiano'] },
      { id: 'afro-fusion', name: 'Afro-fusion', query: 'Afro-fusion Burna Boy BNXN', artists: ['Burna Boy', 'BNXN', 'Omah Lay', 'Victony', 'Fireboy DML', 'Gabzy'], aliases: ['afrofusion'] },
      { id: 'afropop-af', name: 'Afropop', query: 'Afropop African chart toppers', artists: ['Ayra Starr', 'Tems', 'Joeboy', 'Oxalade', 'Simi', 'Adekunle Gold', 'Tekno'], aliases: ['african pop'] },
      { id: 'highlife', name: 'Highlife', query: 'Nigerian Ghanaian Highlife music', artists: ['Flavour', 'The Cavemen.', 'Adekunle Gold', 'Umu Obiligbo', 'KCee', 'Gyakie', 'Kuami Eugene'], aliases: ['igbo highlife', 'ghana highlife'] },
      { id: 'fuji', name: 'Fuji', query: 'Nigerian Fuji music classics and street', artists: ['K1 De Ultimate', 'Pasuma', 'Saheed Osupa', 'Obesere', 'Adewale Ayuba', 'Asake'], aliases: ['fuji music', 'owambe fuji'] },
      { id: 'apala', name: 'Apala', query: 'Apala fusion Nigerian traditional', artists: ['Haruna Ishola', 'Musiliu Haruna Ishola', 'Terry Apala', 'Qdot', 'Seyivibez'], aliases: ['apala hip hop'] },
      { id: 'afrojuju', name: 'Afrojuju', query: 'Juju Afrojuju Nigerian owambe classics', artists: ['King Sunny Adé', 'Shina Peters', 'Ebenezer Obey', 'Dele Abiodun'], aliases: ['juju music', 'owambe'] },
      { id: 'alte', name: 'Alte', query: 'Nigerian Alte cruise alternative', artists: ['Cruel Santino', 'Odunsi (The Engine)', 'BOJ', 'Amaarae', 'Lady Donli', 'Tems', 'Show Dem Camp'], aliases: ['alté', 'naija alte'] },
      { id: 'bongo-flava', name: 'Bongo Flava', query: 'Tanzania Bongo Flava hits', artists: ['Diamond Platnumz', 'Harmonize', 'Rayvanny', 'Zuchu', 'Ali Kiba', 'Marioo'], aliases: ['tanzania music', 'east african hits'] },
      { id: 'gqom', name: 'Gqom', query: 'South African Gqom Durban beats', artists: ['DJ Lag', 'Babes Wodumo', 'Distruction Boyz', 'Dlala Thukzin', 'Mampintsha'], aliases: ['durban gqom', '3 step'] },
      { id: 'kwaito', name: 'Kwaito', query: 'South African Kwaito classics', artists: ['TKZee', 'Mandoza', 'Bongo Maffin', 'Zola', 'Trompies', 'Big Nuz'], aliases: ['sa kwaito'] },
      { id: 'maskandi', name: 'Maskandi', query: 'South African Maskandi Zulu music', artists: ['Khuzani', 'Mthandeni SK', 'Qhosha', 'Bhekumuzi Luthuli', 'Sjava'], aliases: ['zulu maskandi'] },
      { id: 'afro-house', name: 'Afro-house', query: 'Afro-house tribal deep club mix', artists: ['Black Coffee', 'Zakes Bantwini', 'Sun-EL Musician', 'Shimza', 'Caiiro', 'Da Capo'], aliases: ['afro house', 'tribal house'] },
      { id: 'azonto', name: 'Azonto', query: 'Ghana Azonto dance hits', artists: ['Sarkodie', 'Fuse ODG', 'R2Bees', 'EL', 'Guru', 'Shatta Wale', 'Stonebwoy'], aliases: ['ghana azonto', 'hiplife'] }
    ]
  },
  {
    id: 'international',
    emoji: '🌎',
    title: 'International',
    shortLabel: '🌎 International',
    subtitle: 'Latin, Reggaeton, Brazilian Funk, K-pop, J-pop, Bollywood, Arabic & Country',
    seedQuery: 'global latin k-pop international hits',
    subgenres: [
      { id: 'latin-pop', name: 'Latin Pop', query: 'Latin Pop global hits', artists: ['Shakira', 'Rosalía', 'Karol G', 'Rauw Alejandro', 'Camilo', 'Sebastian Yatra'], aliases: ['pop latino'] },
      { id: 'reggaeton', name: 'Reggaeton', query: 'Reggaeton perreo hits', artists: ['Bad Bunny', 'Feid', 'Karol G', 'J Balvin', 'Daddy Yankee', 'Ozuna', 'Rauw Alejandro'], aliases: ['perreo', 'urbano latino'] },
      { id: 'latin-trap', name: 'Latin Trap', query: 'Latin Trap hits', artists: ['Bad Bunny', 'Anuel AA', 'Eladio Carrión', 'Bryant Myers', 'Young Miko', 'Myke Towers'], aliases: ['trap latino'] },
      { id: 'salsa', name: 'Salsa', query: 'Salsa dance classics', artists: ['Marc Anthony', 'Héctor Lavoe', 'Grupo Niche', 'Willie Colón', 'Celia Cruz', 'Gilberto Santa Rosa'], aliases: ['salsa dura', 'salsa romantica'] },
      { id: 'bachata', name: 'Bachata', query: 'Bachata sensual hits', artists: ['Romeo Santos', 'Aventura', 'Prince Royce', 'Juan Luis Guerra', 'Manuel Turizo'], aliases: ['bachata sensual'] },
      { id: 'brazilian-funk', name: 'Brazilian Funk', query: 'Brazilian Funk baile funk Carioca', artists: ['Anitta', 'MC Kevin o Chris', 'Pedro Sampaio', 'Ludmilla', 'MC Ryan SP', 'Dennis DJ'], aliases: ['baile funk', 'funk carioca', 'funk mandelao'] },
      { id: 'samba', name: 'Samba', query: 'Brazilian Samba Pagode classics', artists: ['Seu Jorge', 'Zeca Pagodinho', 'Thiaguinho', 'Péricles', 'Jorge Ben Jor', 'Exaltasamba'], aliases: ['pagode', 'bossa nova'] },
      { id: 'k-pop', name: 'K-pop', query: 'K-pop trending hits', artists: ['BTS', 'BLACKPINK', 'NewJeans', 'Stray Kids', 'TWICE', 'SEVENTEEN', 'aespa', 'Jungkook'], aliases: ['kpop', 'korean pop'] },
      { id: 'j-pop', name: 'J-pop', query: 'J-pop Japanese hits', artists: ['YOASOBI', 'Fujii Kaze', 'Ado', 'Kenshi Yonezu', 'Official HIGE DANdism', 'Hikaru Utada'], aliases: ['jpop', 'city pop', 'japanese pop'] },
      { id: 'c-pop', name: 'C-pop', query: 'C-pop Mandopop hits', artists: ['Jay Chou', 'JJ Lin', 'G.E.M.', 'Eric Chou', 'Mayday', 'Jackson Wang'], aliases: ['cpop', 'mandopop', 'cantopop'] },
      { id: 'bollywood', name: 'Bollywood', query: 'Bollywood Hindi top songs', artists: ['Arijit Singh', 'Diljit Dosanjh', 'AP Dhillon', 'Shreya Ghoshal', 'A.R. Rahman', 'Badshah'], aliases: ['hindi songs', 'desi hits', 'punjabi'] },
      { id: 'arabic-music', name: 'Arabic Music', query: 'Arabic pop hits', artists: ['Amr Diab', 'Nancy Ajram', 'Mohamed Ramadan', 'Saad Lamjarred', 'Elissa', 'Wegz'], aliases: ['arabic pop', 'khaleeji', 'mahraganat'] },
      { id: 'country', name: 'Country', query: 'Country music top hits', artists: ['Morgan Wallen', 'Luke Combs', 'Zach Bryan', 'Chris Stapleton', 'Post Malone', 'Shaboozey'], aliases: ['country hits', 'nashville'] },
      { id: 'folk', name: 'Folk', query: 'Indie Folk acoustic hits', artists: ['Noah Kahan', 'Mumford & Sons', 'The Lumineers', 'Bon Iver', 'Fleet Foxes', 'Hozier'], aliases: ['indie folk', 'americana'] },
      { id: 'regional-mexican', name: 'Regional Mexican', query: 'Corridos Tumbados Regional Mexicano', artists: ['Peso Pluma', 'Natanael Cano', 'Fuerza Regida', 'Junior H', 'Grupo Frontera', 'Carin Leon'], aliases: ['corridos tumbados', 'mexican music', 'banda', 'norteno'] }
    ]
  },
  {
    id: 'styles',
    emoji: '🎬',
    title: 'Other Popular Listening Styles',
    shortLabel: '🎬 Moods & OSTs',
    subtitle: 'Anime, movie & game soundtracks, lo-fi, ambient, sad/love songs & freestyle',
    seedQuery: 'lofi anime ost movie soundtracks chill vibes',
    subgenres: [
      { id: 'anime-music', name: 'Anime Music', query: 'Anime openings OP ED hits', artists: ['LiSA', 'YOASOBI', 'Creepy Nuts', 'Kenshi Yonezu', 'Aimer', 'Eve', 'Linked Horizon'], aliases: ['anime op', 'anime ost', 'anison'] },
      { id: 'movie-soundtracks', name: 'Movie Soundtracks', query: 'Best Movie Soundtracks scores', artists: ['Hans Zimmer', 'Ludwig Göransson', 'John Williams', 'Trent Reznor', 'Ennio Morricone', 'Metro Boomin'], aliases: ['film score', 'cinema ost', 'movie ost'] },
      { id: 'video-game-ost', name: 'Video Game OST', query: 'Video Game OST iconic soundtracks', artists: ['Nobuo Uematsu', 'Mick Gordon', 'C418', 'Yoko Shimomura', 'Jeremy Soule', 'Gustavo Santaolalla'], aliases: ['game music', 'gaming ost', 'vgm'] },
      { id: 'lo-fi', name: 'Lo-fi', query: 'Lo-fi hip hop chill study beats', artists: ['Lofi Girl', 'Nujabes', 'Jinsang', 'Idealism', 'Kupla', 'eevee', ' Potsu'], aliases: ['lofi', 'lofi beats', 'study music', 'chillhop'] },
      { id: 'chillout', name: 'Chillout', query: 'Chillout lounge sunset vibes', artists: ['FKJ', 'Tom Misch', 'Khruangbin', 'Bonobo', 'Tycho', 'Nightmares on Wax'], aliases: ['chill', 'lounge', 'downtempo'] },
      { id: 'ambient', name: 'Ambient', query: 'Ambient atmospheric soundscapes', artists: ['Brian Eno', 'Aphex Twin', 'Hammock', 'Stars of the Lid', 'Ólafur Arnalds', 'Nils Frahm'], aliases: ['ambient drone', 'sleep music'] },
      { id: 'meditation', name: 'Meditation', query: 'Meditation zen healing frequencies', artists: ['Deuter', 'Snatam Kaur', 'Liquid Mind', 'Karunesh', 'Steven Halpern'], aliases: ['zen', 'mindfulness', 'healing music'] },
      { id: 'sad-songs', name: 'Sad Songs', query: 'Sad heartbreak emotional songs', artists: ['Juice WRLD', 'Billie Eilish', 'Joji', 'Olivia Rodrigo', 'Lewis Capaldi', 'Lana Del Rey', 'XXXTENTACION'], aliases: ['heartbreak', 'crying songs', 'melancholy'] },
      { id: 'love-songs', name: 'Love Songs', query: 'Romantic love songs classics & hits', artists: ['Ed Sheeran', 'Bruno Mars', 'John Legend', 'Adele', 'Beyoncé', 'Daniel Caesar', 'Simi'], aliases: ['romance', 'romantic songs', 'wedding songs'] },
      { id: 'freestyle', name: 'Freestyle', query: 'Hip Hop Freestyle cypher bars', artists: ['Juice WRLD', 'Harry Mack', 'Black Thought', 'Eminem', 'J. Cole', 'Central Cee'], aliases: ['rap freestyle', 'cypher', 'off the dome'] },
      { id: 'acapella', name: 'Acapella', query: 'Acapella vocal harmony covers', artists: ['Pentatonix', 'VoicePlay', 'Home Free', 'Jacob Collier', 'Boyz II Men'], aliases: ['a cappella', 'vocal only'] },
      { id: 'spoken-word', name: 'Spoken Word', query: 'Spoken Word poetry music', artists: ['Gil Scott-Heron', 'Kae Tempest', 'Suli Breaks', 'Prince Ea', 'Rupi Kaur'], aliases: ['poetry', 'monologue'] }
    ]
  },
  {
    id: 'underground',
    emoji: '⚡',
    title: 'Internet & Underground',
    shortLabel: '⚡ Underground',
    subtitle: 'Drift & Brazilian phonk, sigilkore, hyperpop, rage, cloud rap, pluggnb & emo rap',
    seedQuery: 'drift phonk rage cloud rap emo rap underground hits',
    subgenres: [
      { id: 'drift-phonk', name: 'Drift Phonk', query: 'Drift Phonk cowbell bass', artists: ['KORDHELL', 'DVRST', 'Pharmacist', 'KSLV Noh', 'Hensonn', 'Dxrk ダーク'], aliases: ['cowbell phonk', 'car drift music'] },
      { id: 'brazilian-phonk', name: 'Brazilian Phonk', query: 'Brazilian Phonk montagem automotivo', artists: [' Ariis', '6YNTHMANE', 'RXDXVIL', 'DJ FKU', 'eternxlkz', ' Nakama'], aliases: ['montagem', 'automotivo phonk'] },
      { id: 'sigilkore', name: 'Sigilkore', query: 'Sigilkore aesthetic underground', artists: ['Lumi Athena', 'odetari', '9lives', 'jnhygs', 'islurwhenitalk', 'kets4eki'], aliases: ['krushclub', 'scenecore'] },
      { id: 'hyperpop', name: 'Hyperpop', query: 'Hyperpop glitch pop anthems', artists: ['100 gecs', 'Charli xcx', 'SOPHIE', 'glaive', 'ericdoa', ' underscores'], aliases: ['glitchcore', 'digicore'] },
      { id: 'rage', name: 'Rage', query: 'Rage rap beats Opium style', artists: ['Playboi Carti', 'Yeat', 'Ken Carson', 'Destroy Lonely', 'Trippie Redd', 'SoFaygo'], aliases: ['rage rap', 'opium'] },
      { id: 'cloud-rap', name: 'Cloud Rap', query: 'Cloud Rap ethereal hip hop', artists: ['A$AP Rocky', 'Yung Lean', 'Bladee', 'Bones', 'Lil B', 'Lucki'], aliases: ['drain gang', 'sadboys'] },
      { id: 'pluggnb', name: 'PluggnB', query: 'PluggnB melodic underground rap', artists: ['Summrs', 'Autumn!', 'Kankan', 'Izaya Tiji', 'Texako', 'Xaviersobased'], aliases: ['plugg', 'plugg n b'] },
      { id: 'emo-rap', name: 'Emo Rap', query: 'Emo Rap melodic heartbreak hits', artists: ['Juice WRLD', 'XXXTENTACION', 'Lil Peep', 'Trippie Redd', 'Lil Uzi Vert', 'The Kid LAROI', 'Polo G', 'iann dior'], aliases: ['melodic rap', 'sad rap', 'juice wrld type'] },
      { id: 'experimental', name: 'Experimental', query: 'Experimental avant-garde electronic hip hop', artists: ['JPEGMAFIA', 'Death Grips', 'Arca', 'Aphex Twin', 'Yves Tumor', 'FKA twigs'], aliases: ['avant garde', 'industrial hip hop'] },
      { id: 'breakcore', name: 'Breakcore', query: 'Breakcore atmospheric amen break', artists: ['Sewerslvt', 'Machine Girl', 'Venetian Snares', 'Goreshit', 'Tokyopill', ' Rory in early 20s'], aliases: ['glitchbreak', 'amen break'] },
      { id: 'hardstyle', name: 'Hardstyle', query: 'Hardstyle euphoric raw gym kicks', artists: ['Headhunterz', 'Sub Zero Project', 'Brennan Heart', 'Wildstylez', 'Da Tweekaz', 'Tevvez'], aliases: ['zyzz hardstyle', 'rawstyle'] },
      { id: 'witch-house', name: 'Witch House', query: 'Witch House dark electronic wave', artists: ['Crystal Castles', 'Sidewalks and Skeletons', 'SALEM', 'IC3PEAK', 'Crim3s', 'Mareux'], aliases: ['darkwave', 'crystal castles style'] }
    ]
  }
];

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9&+]+/g, ' ')
    .trim();
}

export function getCategoryFamily(familyId) {
  const key = String(familyId || '').toLowerCase().trim();
  return MUSIC_CATEGORIES_2026.find(f => f.id === key) || null;
}

export function getSubgenreById(subgenreId) {
  const key = String(subgenreId || '').toLowerCase().trim();
  for (const family of MUSIC_CATEGORIES_2026) {
    const sub = family.subgenres.find(s => s.id === key);
    if (sub) return { ...sub, familyId: family.id, familyTitle: family.title, familyEmoji: family.emoji };
  }
  return null;
}

/**
 * Search across all 8 category families and 95+ subgenres by name, alias, or artist.
 */
export function searchCategories(query, { limit = 14 } = {}) {
  const q = normalizeToken(query);
  if (!q) {
    return MUSIC_CATEGORIES_2026.flatMap(f =>
      f.subgenres.slice(0, 2).map(s => ({ ...s, familyId: f.id, familyTitle: f.title, familyEmoji: f.emoji, score: 50 }))
    ).slice(0, limit);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const family of MUSIC_CATEGORIES_2026) {
    const famTitleNorm = normalizeToken(family.title);
    const famSubNorm = normalizeToken(family.subtitle);
    const famBonus = famTitleNorm.includes(q) ? 35 : (tokens.every(t => famTitleNorm.includes(t) || famSubNorm.includes(t)) ? 20 : 0);

    for (const sub of family.subgenres) {
      let score = famBonus;
      const subNameNorm = normalizeToken(sub.name);
      const subIdNorm = normalizeToken(sub.id);
      const aliasesNorm = (sub.aliases || []).map(normalizeToken);
      const artistsNorm = (sub.artists || []).map(normalizeToken);
      const queryNorm = normalizeToken(sub.query);

      if (subNameNorm === q || subIdNorm === q) score += 120;
      else if (subNameNorm.startsWith(q)) score += 95;
      else if (subNameNorm.includes(q)) score += 80;

      if (aliasesNorm.some(a => a === q)) score += 110;
      else if (aliasesNorm.some(a => a.includes(q) || q.includes(a))) score += 70;

      if (artistsNorm.some(a => a === q)) score += 105;
      else if (artistsNorm.some(a => a.includes(q) || q.includes(a))) score += 75;

      for (const tok of tokens) {
        if (tok.length < 2) continue;
        if (subNameNorm.includes(tok)) score += 25;
        if (aliasesNorm.some(a => a.includes(tok))) score += 20;
        if (artistsNorm.some(a => a.includes(tok))) score += 22;
        if (queryNorm.includes(tok)) score += 12;
      }

      if (score > 0) {
        scored.push({
          ...sub,
          familyId: family.id,
          familyTitle: family.title,
          familyEmoji: family.emoji,
          score
        });
      }
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Resolve the closest 2026 subgenre cluster for a given artist, track title, or raw genre string.
 * Powers Smart Infinite Mode so playing e.g. "Juice WRLD" maps to Emo Rap + Cloud Rap + Hip-Hop/Rap.
 */
export function inferArtistGenreCluster(artist = '', title = '', rawGenre = '') {
  const combined = `${artist} ${title} ${rawGenre}`.trim();
  const artistMatches = artist ? searchCategories(artist, { limit: 4 }) : [];
  const genreMatches = rawGenre ? searchCategories(rawGenre, { limit: 4 }) : [];
  const fullMatches = combined ? searchCategories(combined, { limit: 5 }) : [];

  const merged = new Map();
  for (const item of [...artistMatches, ...genreMatches, ...fullMatches]) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  const topSubgenres = [...merged.values()].slice(0, 3);
  if (!topSubgenres.length) {
    const fallback = getSubgenreById('hip-hop-rap') || MUSIC_CATEGORIES_2026[0].subgenres[0];
    topSubgenres.push(fallback);
  }

  const relatedArtists = [];
  const seenArtists = new Set([normalizeToken(artist)]);
  for (const sub of topSubgenres) {
    for (const candidateArtist of sub.artists || []) {
      const k = normalizeToken(candidateArtist);
      if (k && !seenArtists.has(k)) {
        seenArtists.add(k);
        relatedArtists.push(candidateArtist);
      }
    }
  }

  return {
    primarySubgenre: topSubgenres[0],
    subgenres: topSubgenres,
    relatedArtists: relatedArtists.slice(0, 12),
    clusterLabel: topSubgenres.map(s => s.name).join(' · ')
  };
}

/**
 * Formats the single-card 2026 Music Genres & Categories directory overview.
 */
export function formatMusicCategoriesCardHtml() {
  const lines = [
    `🎧 <b>MUSIC GENRES &amp; CATEGORIES · 2026</b>`,
    `<i>POPULAR · MAINSTREAM · UNDERGROUND · GLOBAL</i>`,
    ``
  ];
  for (const fam of MUSIC_CATEGORIES_2026) {
    const subList = fam.subgenres.map(s => s.name).join(' · ');
    lines.push(`${fam.emoji} <b>${fam.title}</b>`);
    lines.push(`<code>${subList}</code>`);
    lines.push(``);
  }
  lines.push(`<i>Tap any category family below, search any genre/subgenre, or ask AI DJ to mix styles live.</i>`);
  return lines.join('\n');
}
