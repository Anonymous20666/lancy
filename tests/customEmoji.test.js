import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_EMOJI_MAP,
  getCustomEmojiId,
  toCustomEmojiHtml,
  enhanceRichText,
  applyCustomEmojisToBlocks
} from '../src/telegram/customEmoji.js';
import { RichMessageBuilder, richButton } from '../src/telegram/rich.js';

test('custom emoji map contains expected IDs', () => {
  assert.equal(getCustomEmojiId('🎀'), '5375129864179319277');
  assert.equal(getCustomEmojiId('🖤'), '5354812955177274307');
  assert.equal(getCustomEmojiId('🤍'), '5355221552596010343');
  assert.equal(getCustomEmojiId('🎬'), '5375464961822695044');
  assert.equal(getCustomEmojiId('🔍'), '4958587679361991667');
  assert.equal(getCustomEmojiId('nonexistent'), null);
});

test('toCustomEmojiHtml converts emojis to Telegram tg-emoji tags', () => {
  const html = toCustomEmojiHtml('Hello 🎀 and 🖤!');
  assert.equal(
    html,
    'Hello <tg-emoji emoji-id="5375129864179319277">🎀</tg-emoji> and <tg-emoji emoji-id="5354812955177274307">🖤</tg-emoji>!'
  );
});

test('enhanceRichText converts strings to rich text array with custom_emoji tokens', () => {
  const tokens = enhanceRichText('🔍 Search Pinterest');
  assert.deepEqual(tokens, [
    { type: 'custom_emoji', alternative_text: '🔍', custom_emoji_id: '4958587679361991667' },
    ' Search Pinterest'
  ]);
});

test('applyCustomEmojisToBlocks transforms blocks and buttons', () => {
  const blocks = [
    { type: 'paragraph', text: 'Welcome 🌸!' },
    { type: 'buttons', buttons: [{ text: '✨ Make Pack', callback_data: 'pack' }] }
  ];
  const transformed = applyCustomEmojisToBlocks(blocks);

  assert.deepEqual(transformed[0].text, [
    'Welcome ',
    { type: 'custom_emoji', alternative_text: '🌸', custom_emoji_id: '5375384680294025343' },
    '!'
  ]);
  assert.deepEqual(transformed[1].buttons[0].text, [
    { type: 'custom_emoji', alternative_text: '✨', custom_emoji_id: '5472164874886846699' },
    ' Make Pack'
  ]);
});

test('RichMessageBuilder.toJSON integrates custom emojis by default', () => {
  const b = new RichMessageBuilder();
  b.paragraph('Aesthetic 🎀 studio');
  b.buttons([richButton.callback('🔍 Search', 'search')]);
  const json = b.toJSON();

  assert.equal(json.blocks[0].type, 'paragraph');
  assert.deepEqual(json.blocks[0].text, [
    'Aesthetic ',
    { type: 'custom_emoji', alternative_text: '🎀', custom_emoji_id: '5375129864179319277' },
    ' studio'
  ]);
  assert.deepEqual(json.blocks[1].buttons[0].text, [
    { type: 'custom_emoji', alternative_text: '🔍', custom_emoji_id: '4958587679361991667' },
    ' Search'
  ]);
});
