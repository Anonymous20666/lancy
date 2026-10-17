/**
 * Trivia Dataset & Dynamic AI Generator for Lancy Game Arena.
 * Contains curated high-engagement questions plus real-time AI generation via Ollama.
 */

export const CURATED_TRIVIA = [
  {
    question: 'Which planet in our solar system has the most moons?',
    options: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'],
    correctIndex: 1,
    explanation: 'Saturn leads with 146 confirmed moons, overtaking Jupiter in 2023!',
    category: 'Science & Cosmos',
    difficulty: 'MEDIUM'
  },
  {
    question: 'What is the fastest land animal in the world?',
    options: ['Cheetah', 'Pronghorn Antelope', 'Lion', 'Peregrine Falcon'],
    correctIndex: 0,
    explanation: 'The Cheetah can sprint up to 120 km/h (75 mph)!',
    category: 'Animal Kingdom',
    difficulty: 'EASY'
  },
  {
    question: 'Which anime holds the Guinness World Record for the most published comic book series by a single author?',
    options: ['Dragon Ball', 'Naruto', 'One Piece', 'Detective Conan'],
    correctIndex: 2,
    explanation: 'Eiichiro Oda’s One Piece has sold over 516 million copies worldwide!',
    category: 'Anime & Manga',
    difficulty: 'EASY'
  },
  {
    question: 'Which of these car brands produces the world-famous "911" sports car?',
    options: ['Ferrari', 'Porsche', 'McLaren', 'Aston Martin'],
    correctIndex: 1,
    explanation: 'Porsche has been producing the iconic rear-engine 911 since 1964.',
    category: 'Automotive',
    difficulty: 'EASY'
  },
  {
    question: 'What is the smallest independent country in the world by land area?',
    options: ['Monaco', 'Vatican City', 'Nauru', 'San Marino'],
    correctIndex: 1,
    explanation: 'Vatican City measures just 0.49 square kilometers (121 acres)!',
    category: 'Geography',
    difficulty: 'EASY'
  },
  {
    question: 'Which element on the periodic table has the chemical symbol "Au"?',
    options: ['Silver', 'Gold', 'Argon', 'Platinum'],
    correctIndex: 1,
    explanation: 'From the Latin "aurum", meaning shining dawn!',
    category: 'Science',
    difficulty: 'EASY'
  },
  {
    question: 'In the Marvel Cinematic Universe, what is the fictional metal vibranium mined from?',
    options: ['Sokovia', 'Latveria', 'Wakanda', 'Genosha'],
    correctIndex: 2,
    explanation: 'Wakanda was built on the site of a prehistoric meteorite made of vibranium.',
    category: 'Pop Culture',
    difficulty: 'EASY'
  },
  {
    question: 'Which artist released the global record-shattering hit "Blinding Lights"?',
    options: ['Bruno Mars', 'The Weeknd', 'Drake', 'Post Malone'],
    correctIndex: 1,
    explanation: 'The Weeknd released Blinding Lights on his 2020 album After Hours!',
    category: 'Music & Celebrities',
    difficulty: 'EASY'
  },
  {
    question: 'How many hearts does an octopus have?',
    options: ['1', '2', '3', '4'],
    correctIndex: 2,
    explanation: 'An octopus has 3 hearts: two pump blood to the gills, one to the body!',
    category: 'Nature',
    difficulty: 'MEDIUM'
  },
  {
    question: 'Which country invented the modern concept of paper money (banknotes)?',
    options: ['Italy', 'China', 'United Kingdom', 'Greece'],
    correctIndex: 1,
    explanation: 'Paper money was first developed during the Tang Dynasty in 7th century China.',
    category: 'History',
    difficulty: 'MEDIUM'
  }
];

/**
 * Generates a fresh AI trivia question on demand via Ollama (qwen2.5:0.5b).
 * Falls back to curated trivia if AI is offline or times out.
 */
export async function getAiOrCuratedTrivia(category = 'General Knowledge', ollamaUrl = 'http://127.0.0.1:11434') {
  try {
    const prompt = `Generate a single fun, clear multiple-choice trivia question about ${category}.
Return strictly a valid JSON object matching this schema and nothing else:
{
  "question": "Question text here?",
  "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
  "correctIndex": 0,
  "explanation": "Brief fun explanation why."
}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:0.5b',
        prompt,
        stream: false,
        format: 'json'
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const parsed = JSON.parse(data.response);
      if (
        typeof parsed.question === 'string' &&
        Array.isArray(parsed.options) &&
        parsed.options.length === 4 &&
        typeof parsed.correctIndex === 'number' &&
        parsed.correctIndex >= 0 &&
        parsed.correctIndex <= 3
      ) {
        return {
          ...parsed,
          category,
          difficulty: 'MEDIUM',
          isAiGenerated: true
        };
      }
    }
  } catch {
    // Fall back to curated bank
  }

  const picked = CURATED_TRIVIA[Math.floor(Math.random() * CURATED_TRIVIA.length)];
  return {
    ...picked,
    isAiGenerated: false
  };
}
