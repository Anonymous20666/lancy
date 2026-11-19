import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { BUILTIN_PERSONAS, getPersonaById, resolvePersonaFromText } from '../src/ai/personas.js';
import { WebBrowser } from '../src/ai/browse.js';
import { LancyToolExecutor } from '../src/ai/lancyTools.js';
import { LancyAgent } from '../src/ai/lancyAgent.js';

test('Multi-Persona Cast resolves Pappy (default), Ava, Maya, Leo, Nana, Elder, archetypes & custom names cleanly', () => {
  assert.equal(BUILTIN_PERSONAS.pappy.geminiVoice, 'Charon');
  assert.equal(getPersonaById('lancy').id, 'pappy');
  assert.equal(getPersonaById('lady').id, 'ava');
  assert.equal(getPersonaById('ava').geminiVoice, 'Aoede');
  assert.equal(getPersonaById('girl').id, 'maya');
  assert.equal(getPersonaById('maya').geminiVoice, 'Leda');
  assert.equal(getPersonaById('boy').id, 'leo');
  assert.equal(getPersonaById('leo').geminiVoice, 'Puck');
  assert.equal(getPersonaById('old_woman').id, 'nana');
  assert.equal(getPersonaById('nana').geminiVoice, 'Gacrux');
  assert.equal(getPersonaById('old_man').id, 'elder');
  assert.equal(getPersonaById('elder').geminiVoice, 'Algenib');

  const swLady = resolvePersonaFromText('Hey Ava, tell me what you think', BUILTIN_PERSONAS.pappy, ['John']);
  assert.equal(swLady.switched, true);
  assert.equal(swLady.persona.id, 'ava');
  assert.equal(swLady.persona.gender, 'female');

  const swOldWoman = resolvePersonaFromText('Switch to an old woman voice abeg', BUILTIN_PERSONAS.pappy);
  assert.equal(swOldWoman.switched, true);
  assert.equal(swOldWoman.persona.id, 'nana');
  assert.equal(swOldWoman.persona.ageGroup, 'old_woman');

  const customGirl = resolvePersonaFromText('Hey Amara reply me', BUILTIN_PERSONAS.pappy, ['John']);
  assert.equal(customGirl.switched, true);
  assert.equal(customGirl.persona.name, 'Amara');
  assert.equal(customGirl.persona.gender, 'female');
  assert.equal(customGirl.persona.geminiVoice, 'Aoede');

  // Must NOT hijack real human VC participant names
  const humanTalk = resolvePersonaFromText('Hey John did you reach home?', BUILTIN_PERSONAS.pappy, ['John']);
  assert.equal(humanTalk.switched, false);
  assert.equal(humanTalk.persona.id, 'pappy');
});

test('Live web_research & tell_story_or_novel return real results (OpenLibrary dark romance + Wikipedia + TVMaze/iTunes)', async () => {
  const browser = new WebBrowser({ timeoutMs: 5000 });
  const structured = await browser.researchStructured('Burna Boy Last Last song', { maxResults: 3 });
  assert.ok(structured.results.length >= 1, 'Expected real Wikipedia/Web results');

  const executor = new LancyToolExecutor({ app: {} });
  const mediaRes = await executor.execute('web_research', { query: 'Stranger Things TV series' }, { chatId: -1001 });
  assert.equal(mediaRes.ok, true);
  assert.ok(mediaRes.results.length >= 1);

  const storyRes = await executor.execute('tell_story_or_novel', { query: 'Haunting Adeline', genre: 'dark_romance' }, { chatId: -1001 });
  assert.equal(storyRes.ok, true);
  assert.ok((storyRes.books?.length || 0) + (storyRes.plots?.length || 0) >= 1);
});

test('LancyAgent supports standalone per-speaker personas (Pappy + Ava) in same chat & passes persona edgeTtsVoice', async () => {
  const db = new Database(':memory:');
  db.migrate();
  const seenPrompts = [];
  const agent = new LancyAgent({
    app: {
      db,
      settings: { get: (_k, d) => d, getForUser: (_u, _k, d) => d },
      ai: {
        hasCredentials: () => true,
        getCapabilities: () => ({ primaryModel: 'gpt-6.2-astra:free', backupModel: 'gemini-4-neon:free', realtimeVoiceAvailable: true }),
        deepReason: async ({ system }) => {
          seenPrompts.push(system || '');
          return { content: 'Replying in character cleanly.', toolCalls: [], rawMessage: {} };
        }
      }
    }
  });

  // Speaker 201 talks to Pappy, Speaker 202 calls Ava in the same group chat
  const r1 = await agent.handleBotTurn({ chatId: -100555, tgId: '201', user: { id: 201, first_name: 'Tunde' } }, 'Pappy how far?', { surface: 'group_text' });
  const r2 = await agent.handleBotTurn({ chatId: -100555, tgId: '202', user: { id: 202, first_name: 'Bola' } }, 'Ava tell us a dark romance story', { surface: 'group_text' });

  assert.equal(r1.persona.id, 'pappy');
  assert.equal(r1.persona.edgeTtsVoice, 'pappy');
  assert.equal(r2.persona.id, 'ava');
  assert.equal(r2.persona.edgeTtsVoice, 'ava');
  assert.match(seenPrompts[0], /You are Pappy/i);
  assert.match(seenPrompts[1], /You are Ava/i);
  db.close?.();
});
