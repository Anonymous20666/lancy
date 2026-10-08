import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhatsAppNumber, isValidWhatsAppNumber, formatInternational, PhoneNumberError } from '../src/utils/phone.js';

/**
 * Number normalization — every accepted format must become the exact
 * digits-only, country-code-first string plogme's requestPairingCode needs.
 */

test('accepts all supported formats', () => {
  const cases = [
    ['+234 801 234 5678', '2348012345678'],
    ['234-801-234-5678', '2348012345678'],
    ['2348012345678', '2348012345678'],
    ['+2348012345678', '2348012345678'],
    ['(234) 801 234 5678', '2348012345678'],
    ['+234 (0) 801 234 5678', null], // leading 0 after cc is invalid
    ['00234 801 234 5678', '2348012345678'],
    ['+1 415 555 2671', '14155552671'],
    ['+44 20 7946 0958', '442079460958'],
    ['+91-9876543210', '919876543210']
  ];
  for (const [input, expected] of cases) {
    if (expected === null) {
      assert.throws(() => normalizeWhatsAppNumber(input), PhoneNumberError, input);
    } else {
      const result = normalizeWhatsAppNumber(input);
      assert.equal(result.e164, expected, input);
      assert.ok(!result.e164.includes('+'), 'no + in plogme format');
      assert.ok(!/\D/.test(result.e164), 'digits only');
    }
  }
});

test('rejects invalid numbers with friendly errors', () => {
  const bad = ['', 'abc', '+', '12345', '+234', '++234801234567', '234 801'];
  for (const input of bad) {
    assert.throws(() => normalizeWhatsAppNumber(input), PhoneNumberError, JSON.stringify(input));
  }
});

test('refuses to guess a missing country code', () => {
  assert.throws(() => normalizeWhatsAppNumber('8012345678'), /country code/i);
});

test('detects bad lengths and unknown country codes', () => {
  assert.throws(() => normalizeWhatsAppNumber('+999 12 34'), PhoneNumberError); // unknown cc
  assert.throws(() => normalizeWhatsAppNumber('+1 234'), PhoneNumberError); // too short
});

test('formats international display', () => {
  assert.equal(formatInternational('2348012345678'), '+234 801 234 567 8');
  const r = normalizeWhatsAppNumber('+234 801 234 5678');
  assert.equal(r.formatted, '+234 801 234 567 8');
  assert.equal(r.countryCode, '234');
  assert.equal(r.national, '8012345678');
});

test('isValidWhatsAppNumber', () => {
  assert.equal(isValidWhatsAppNumber('+2348012345678'), true);
  assert.equal(isValidWhatsAppNumber('hello'), false);
  assert.equal(isValidWhatsAppNumber('+1'), false);
});
