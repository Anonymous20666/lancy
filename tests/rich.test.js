import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RichMessageBuilder, rt, richButton, block, encodeCallback, decodeCallback,
  inlineKeyboard, collectAttachmentRefs, RICH_LIMITS, richTextToString,
  richButtonHtml, richMessage, stripMarkup
} from '../src/telegram/rich.js';

test('builder produces valid InputRichMessage JSON', () => {
  const b = new RichMessageBuilder();
  b.heading('✦ LANCY BOT ✦', 1);
  b.divider();
  b.paragraph(rt.concat(rt.bold('hello'), rt.text(' world')));
  b.table([
    [{ text: 'Name', is_header: true, align: 'left', valign: 'middle' }, { text: 'Value', is_header: true, align: 'right', valign: 'middle' }],
    [{ text: 'Stickers', align: 'left', valign: 'middle' }, { text: rt.bold('100'), align: 'right', valign: 'middle' }]
  ]);
  b.buttons([richButton.callback('♡ Open', 'l1:pack:open:1')]);
  b.footer(rt.italic('made with love'));
  const json = b.toJSON();
  assert.ok(Array.isArray(json.blocks));
  assert.equal(json.blocks[0].type, 'heading');
  assert.equal(json.blocks[1].type, 'divider');
  assert.equal(json.blocks[2].type, 'paragraph');
  assert.equal(json.blocks[3].type, 'table');
  assert.equal(json.blocks[4].type, 'buttons');
  assert.equal(json.blocks[5].type, 'footer');
  assert.equal(json.skip_entity_detection, true);
  b.validate();
});

test('rich text helpers produce correct shapes', () => {
  assert.deepEqual(rt.bold('x'), { type: 'bold', text: 'x' });
  assert.deepEqual(rt.italic('x'), { type: 'italic', text: 'x' });
  assert.deepEqual(rt.underline('x'), { type: 'underline', text: 'x' });
  assert.deepEqual(rt.strikethrough('x'), { type: 'strikethrough', text: 'x' });
  assert.deepEqual(rt.marked('x'), { type: 'marked', text: 'x' });
  assert.deepEqual(rt.code('x'), { type: 'code', text: 'x' });
  assert.deepEqual(rt.url('x', 'https://t.me'), { type: 'url', text: 'x', url: 'https://t.me' });
  const c = rt.concat(rt.bold('a'), 'b', rt.italic('c'));
  assert.ok(Array.isArray(c));
  assert.equal(richTextToString(c), 'abc');
});

test('richTextToString flattens everything', () => {
  assert.equal(richTextToString('plain'), 'plain');
  assert.equal(richTextToString([rt.bold('a'), 'b', { type: 'url', text: 'c', url: 'u' }]), 'abc');
  assert.equal(richTextToString({ type: 'mathematical_expression', expression: 'x^2' }), 'x^2');
});

test('buttons block caps at 8 per row and supports styles', () => {
  const buttons = Array.from({ length: 10 }, (_, i) => richButton.callback(`b${i}`, `l1:x:y:${i}`));
  const blk = block.buttons(buttons);
  assert.equal(blk.buttons.length, RICH_LIMITS.maxButtonsPerRow);
  assert.equal(blk.buttons[0].style, 'primary');
  const danger = richButton.callback('Delete', 'l1:x:del', { style: 'danger' });
  assert.equal(danger.style, 'danger');
  const link = richButton.url('Open', 'https://t.me/addstickers/x');
  assert.equal(link.style, 'primary');
  assert.equal(link.url, 'https://t.me/addstickers/x');
});

test('callback codec round-trips and enforces 64 bytes', () => {
  const data = encodeCallback('whatsapp', 'togglePack', 42, 3);
  const decoded = decodeCallback(data);
  assert.equal(decoded.screen, 'whatsapp');
  assert.equal(decoded.action, 'togglePack');
  assert.deepEqual(decoded.args, ['42', '3']);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.equal(decodeCallback('garbage'), null);
  assert.throws(() => encodeCallback('s', 'a', 'x'.repeat(100)), /too long/);
});

test('inline keyboard supports 10.3 styles and disabled', () => {
  const kb = inlineKeyboard([[
    { text: 'Post', callback_data: 'l1:wa:post_confirm', style: 'success' },
    { text: 'Delete', callback_data: 'l1:x:del', style: 'danger', disabled: true }
  ]]);
  assert.equal(kb.inline_keyboard[0][0].style, 'success');
  assert.equal(kb.inline_keyboard[0][1].disabled, true);
});

test('collectAttachmentRefs finds attach:// references', () => {
  const rich = new RichMessageBuilder().photo('attach://preview_0').photo('attach://preview_1').toJSON();
  const refs = collectAttachmentRefs(rich);
  assert.deepEqual([...refs.keys()].sort(), ['preview_0', 'preview_1']);
});

test('collage and slideshow blocks build valid albums and collect attachments', () => {
  const b = new RichMessageBuilder();
  b.collage(['attach://c_0', 'attach://c_1']);
  b.slideshow(['attach://s_0', 'attach://s_1']);
  const json = b.toJSON();
  assert.equal(json.blocks[0].type, 'collage');
  assert.equal(json.blocks[0].blocks.length, 2);
  assert.equal(json.blocks[1].type, 'slideshow');
  assert.equal(json.blocks[1].blocks.length, 2);
  const refs = collectAttachmentRefs(json);
  assert.deepEqual([...refs.keys()].sort(), ['c_0', 'c_1', 's_0', 's_1']);
});

test('validate enforces block and char limits', () => {
  const b = new RichMessageBuilder();
  for (let i = 0; i < RICH_LIMITS.maxBlocks + 1; i++) b.paragraph('x');
  assert.throws(() => b.validate(), /blocks/);
  const b2 = new RichMessageBuilder();
  b2.paragraph('y'.repeat(RICH_LIMITS.maxChars + 1));
  assert.throws(() => b2.validate(), /chars/);
});

test('table normalizes cells with required align/valign', () => {
  const blk = block.table([['a', { text: 'b', is_header: true, colspan: 2 }]]);
  assert.equal(blk.cells[0][0].align, 'left');
  assert.equal(blk.cells[0][0].valign, 'top');
  assert.equal(blk.cells[0][1].is_header, true);
  assert.equal(blk.cells[0][1].colspan, 2);
});

test('Bot API 10.3: b.header and block.header produce valid heading blocks', () => {
  const b = new RichMessageBuilder();
  b.header('𓆩♡𓆪 SPOTIFY / MUSIC 𓆩♡𓆪', 1);
  const json = b.toJSON();
  assert.equal(json.blocks[0].type, 'heading');
  assert.equal(json.blocks[0].size, 1);
  assert.equal(json.blocks[0].text, '𓆩♡𓆪 SPOTIFY / MUSIC 𓆩♡𓆪');
});

test('Bot API 10.3: b.bannerHeader constructs clean heading, subtitle, and divider', () => {
  const b = new RichMessageBuilder();
  b.bannerHeader(['𓆩♡𓆪 PINTEREST SEARCH 𓆩♡𓆪', 'mode: images • depth: deep']);
  const json = b.toJSON();
  assert.equal(json.blocks[0].type, 'heading');
  assert.equal(json.blocks[0].text, '𓆩♡𓆪 PINTEREST SEARCH 𓆩♡𓆪');
  assert.equal(json.blocks[1].type, 'paragraph');
  assert.deepEqual(json.blocks[1].text, { type: 'italic', text: '₊˚⊹♡  mode: images • depth: deep  ˙ᵕ˙' });
  assert.equal(json.blocks[2].type, 'divider');
});

test('Bot API 10.3: rt.html converts HTML markup into clean structured RichText', () => {
  const parsed = rt.html('<b>Bold text</b> &amp; <i>Italic text</i> with <code>/play</code> &lt;3');
  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed[0], { type: 'bold', text: 'Bold text' });
  assert.equal(parsed[1], ' & ');
  assert.deepEqual(parsed[2], { type: 'italic', text: 'Italic text' });
  assert.equal(parsed[3], ' with ');
  assert.deepEqual(parsed[4], { type: 'code', text: '/play' });
  assert.equal(parsed[5], ' <3');

  const customEmojiParsed = rt.html('<tg-emoji emoji-id="5375129864179319277">🎀</tg-emoji>');
  assert.deepEqual(customEmojiParsed, {
    type: 'custom_emoji',
    alternative_text: '🎀',
    custom_emoji_id: '5375129864179319277'
  });
});

test('Bot API 10.3: b.html parses block-level HTML tags into RichBlocks', () => {
  const b = new RichMessageBuilder();
  b.html(
    '<header>𓆩♡𓆪 SPOTIFY DOWNLOAD 𓆩♡𓆪</header>' +
    '<p>🎵 <b>Starboy</b> — <i>The Weeknd</i></p>' +
    '<hr>' +
    '<blockquote expandable>📱 Platform: Spotify ♡</blockquote>'
  );
  const json = b.toJSON();
  assert.equal(json.blocks[0].type, 'heading');
  assert.equal(json.blocks[0].size, 1);
  assert.equal(json.blocks[0].text, '𓆩♡𓆪 SPOTIFY DOWNLOAD 𓆩♡𓆪');

  assert.equal(json.blocks[1].type, 'paragraph');
  assert.equal(json.blocks[2].type, 'divider');
  assert.equal(json.blocks[3].type, 'expandable_blockquote');
});

test('Bot API 10.3: richButtonHtml and richMessage produce structured HTML with buttons and emojis', () => {
  const btn = {
    text: 'Play Song',
    emojiId: '5472164874886846699',
    style: 'primary',
    action: { callback_data: 'l1:downloader:play:track1' }
  };
  const btnHtml = richButtonHtml(btn);
  assert.match(btnHtml, /<tg-button type="callback_data" style="primary" data="l1:downloader:play:track1">/);
  assert.match(btnHtml, /<tg-emoji emoji-id="5472164874886846699">⭐<\/tg-emoji>/);
  assert.match(btnHtml, /Play Song<\/tg-button>/);

  const msg = richMessage({
    header: 'SPOTIFY / MUSIC',
    body: 'High-speed audio streaming',
    quote: '🎵 Starboy — The Weeknd',
    footer: 'Delivered with aesthetic love ♡',
    buttons: [
      [
        btn,
        { text: 'Telegram Link', action: { url: 'https://t.me/Lancy_easy_bot' } }
      ]
    ]
  });

  assert.ok(typeof msg.html === 'string');
  assert.match(msg.html, /<h2>SPOTIFY \/ MUSIC<\/h2>/);
  assert.match(msg.html, /<p>High-speed audio streaming<\/p>/);
  assert.match(msg.html, /<blockquote>🎵 Starboy — The Weeknd<\/blockquote>/);
  assert.match(msg.html, /<footer>Delivered with aesthetic love ♡<\/footer>/);
  assert.match(msg.html, /<tg-button-row align="center">/);

  // Parse HTML into InputRichMessage blocks using fromHtml
  const b = RichMessageBuilder.fromHtml(msg.html);
  const json = b.toJSON();

  assert.equal(json.blocks[0].type, 'heading');
  assert.equal(json.blocks[0].size, 2);
  assert.equal(json.blocks[0].text, 'SPOTIFY / MUSIC');

  assert.equal(json.blocks[1].type, 'paragraph');
  assert.equal(json.blocks[1].text, 'High-speed audio streaming');

  assert.equal(json.blocks[2].type, 'blockquote');
  assert.equal(json.blocks[3].type, 'footer');

  assert.equal(json.blocks[4].type, 'buttons');
  assert.equal(json.blocks[4].buttons.length, 2);
  assert.equal(json.blocks[4].buttons[0].callback_data, 'l1:downloader:play:track1');
  assert.equal(json.blocks[4].buttons[1].url, 'https://t.me/Lancy_easy_bot');
});
