import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveHistoryMessageLimit } from '../src/autoreply-context.js'

test('defaults recent conversation context to 50 messages', () => {
  assert.equal(resolveHistoryMessageLimit(undefined), 50)
  assert.equal(resolveHistoryMessageLimit(''), 50)
})

test('accepts owner-selected context windows including zero', () => {
  assert.equal(resolveHistoryMessageLimit('0'), 0)
  assert.equal(resolveHistoryMessageLimit('25'), 25)
  assert.equal(resolveHistoryMessageLimit('50'), 50)
  assert.equal(resolveHistoryMessageLimit('100'), 100)
  assert.equal(resolveHistoryMessageLimit('180'), 180)
})

test('rejects invalid or unsafe context-window values', () => {
  assert.equal(resolveHistoryMessageLimit('-1'), 50)
  assert.equal(resolveHistoryMessageLimit('12.5'), 50)
  assert.equal(resolveHistoryMessageLimit('501'), 500)
  assert.equal(resolveHistoryMessageLimit('not-a-number'), 50)
})
