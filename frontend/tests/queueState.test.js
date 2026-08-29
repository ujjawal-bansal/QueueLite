import test from 'node:test'
import assert from 'node:assert'
import {
  addTokenToQueue,
  setTokenStatus,
  updateToken,
} from '../src/lib/queueState.js'

const token = (number, status, overrides = {}) => ({
  id: `id-${number}`,
  token_number: number,
  status,
  patient_name: `Patient ${number}`,
  ...overrides,
})

const queueOf = (...tokens) => ({
  tokens,
  waiting_count: tokens.filter((t) => t.status === 'waiting').length,
  current_token_number:
    tokens.find((t) => t.status === 'in_progress')?.token_number ?? null,
})

test('a newly issued token is added once', () => {
  const queue = queueOf(token(1, 'done'), token(2, 'waiting'))
  const next = addTokenToQueue(queue, token(3, 'waiting'))

  assert.equal(next.tokens.length, 3)
  assert.equal(next.waiting_count, 2)
})

test('a token a poll already brought in is not added a second time', () => {
  // The exact race the desk saw: a poll that overlapped the create returned the
  // new row first, then the create response tried to append it again, showing
  // the patient twice until the next poll happened to replace the list.
  const fresh = token(3, 'waiting')
  const queue = queueOf(token(1, 'done'), token(2, 'waiting'), fresh)

  const next = addTokenToQueue(queue, { ...fresh })

  assert.equal(next.tokens.length, 3, 'the patient was listed twice')
  assert.equal(
    next.waiting_count,
    queue.waiting_count,
    'the waiting count was inflated'
  )
  assert.equal(next, queue, 'an unchanged queue should keep its identity')
})

test('tokens stay ordered by number after an insert', () => {
  const queue = queueOf(token(1, 'waiting'), token(3, 'waiting'))
  const next = addTokenToQueue(queue, token(2, 'waiting'))

  assert.deepEqual(
    next.tokens.map((t) => t.token_number),
    [1, 2, 3]
  )
})

test('calling a patient in closes out whoever was being seen', () => {
  const queue = queueOf(token(1, 'in_progress'), token(2, 'waiting'))
  const next = updateToken(queue, token(2, 'in_progress'))

  assert.equal(next.current_token_number, 2)
  assert.equal(next.waiting_count, 0)
  assert.equal(next.tokens.find((t) => t.token_number === 1).status, 'done')
})

test('finishing the current patient leaves nobody being seen', () => {
  const queue = queueOf(token(1, 'in_progress'), token(2, 'waiting'))
  const next = updateToken(queue, token(1, 'done'))

  assert.equal(next.current_token_number, null)
  assert.equal(next.waiting_count, 1)
})

test('a no-show comes off the waiting count', () => {
  const queue = queueOf(token(1, 'waiting'), token(2, 'waiting'))
  const next = setTokenStatus(queue, 'id-1', 'no_show')

  assert.equal(next.waiting_count, 1)
})

test('restoring a no-show puts them back on the waiting count', () => {
  const queue = queueOf(token(1, 'no_show'), token(2, 'waiting'))
  const next = setTokenStatus(queue, 'id-1', 'waiting')

  assert.equal(next.waiting_count, 2)
})

test('the waiting count never goes negative', () => {
  const queue = { tokens: [token(1, 'no_show')], waiting_count: 0, current_token_number: null }
  const next = setTokenStatus(queue, 'id-1', 'done')

  assert.equal(next.waiting_count, 0)
})

test('merging into an empty queue is a no-op rather than a crash', () => {
  assert.equal(addTokenToQueue(null, token(1, 'waiting')), null)
  assert.equal(updateToken(null, token(1, 'waiting')), null)
  assert.equal(setTokenStatus(null, 'id-1', 'waiting'), null)
})

test('the browser orders the queue the same way the server does', async () => {
  const { waitingInOrder, effectivePosition } = await import('../src/lib/queueState.js')

  const t = (number, queuePosition = null) => ({
    id: `id-${number}`,
    token_number: number,
    status: 'waiting',
    queue_position: queuePosition,
  })

  // #1 was pushed back three places; the desk must show that, or the row
  // positions disagree with the reminders patients are actually receiving.
  const tokens = [t(1, 4.5), t(2), t(3), t(4), t(5)]

  assert.deepEqual(
    waitingInOrder(tokens).map((token) => token.token_number),
    [2, 3, 4, 1, 5]
  )
  assert.equal(effectivePosition(t(7)), 7)
  assert.equal(effectivePosition(t(7, 12.5)), 12.5)
})

test('a queue nobody has deferred still reads in token order', async () => {
  const { waitingInOrder } = await import('../src/lib/queueState.js')

  const tokens = [3, 1, 2].map((n) => ({
    id: `id-${n}`,
    token_number: n,
    status: 'waiting',
    queue_position: null,
  }))

  assert.deepEqual(
    waitingInOrder(tokens).map((token) => token.token_number),
    [1, 2, 3]
  )
})
