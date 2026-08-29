require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert');
const {
  effectivePosition,
  compareQueueOrder,
  waitingInOrder,
  positionAfter,
  countPatientsAhead,
} = require('../src/services/queueService');

const token = (number, status = 'waiting', queuePosition = null) => ({
  id: `id-${number}`,
  token_number: number,
  status,
  queue_position: queuePosition,
});

const numbersOf = (tokens) => tokens.map((t) => t.token_number);

// Applies a push-back the way the controller does.
const pushBack = (tokens, tokenNumber, places) => {
  const target = tokens.find((t) => t.token_number === tokenNumber)
  target.queue_position = positionAfter(tokens, target, places)
  target.status = 'waiting'
  return tokens
}

test('a queue nobody has deferred is ordered by token number', () => {
  const tokens = [token(3), token(1), token(2)]

  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [1, 2, 3])
})

test('a token with no queue_position sits at its own number', () => {
  assert.equal(effectivePosition(token(7)), 7)
  assert.equal(effectivePosition(token(7, 'waiting', 12.5)), 12.5)
})

test('pushing a patient back by three puts three patients in front of them', () => {
  const tokens = [token(1), token(2), token(3), token(4), token(5)]

  pushBack(tokens, 1, 3)

  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [2, 3, 4, 1, 5])
  assert.equal(countPatientsAhead(tokens, tokens[0]), 3)
})

test('each push back moves the patient further, never forwards', () => {
  // Counted from where they stand now. Measured from the front instead, the
  // second push here would be a no-op and a patient already well down the queue
  // would jump forwards.
  const tokens = [token(1), token(2), token(3), token(4), token(5), token(6)]

  pushBack(tokens, 1, 2)
  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [2, 3, 1, 4, 5, 6])

  pushBack(tokens, 1, 2)
  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [2, 3, 4, 5, 1, 6])

  pushBack(tokens, 1, 3)
  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [2, 3, 4, 5, 6, 1])
})

test('pushing back a patient who is already well down the queue moves them back', () => {
  const tokens = [token(1), token(2), token(3), token(4), token(5), token(6)]

  // #4 has three patients ahead. Two more should leave five ahead, not two.
  pushBack(tokens, 4, 2)

  const target = tokens.find((t) => t.token_number === 4)

  assert.equal(countPatientsAhead(tokens, target), 5)
  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [1, 2, 3, 5, 6, 4])
})

test('pushing back further than the queue is long puts them last', () => {
  const tokens = [token(1), token(2), token(3)]

  pushBack(tokens, 1, 99)

  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [2, 3, 1])
})

test('the only patient waiting cannot be pushed behind anybody', () => {
  const tokens = [token(1), token(2, 'done'), token(3, 'no_show')]

  pushBack(tokens, 1, 5)

  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [1])
})

test('a no-show returning late goes where staff put them, not to the front', () => {
  // The whole point. #2 was written off, turns up twenty minutes later, and
  // must not jump ahead of everyone who has been sitting there since.
  const tokens = [token(2, 'no_show'), token(7), token(8), token(9), token(10)]

  pushBack(tokens, 2, 2)

  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [7, 8, 2, 9, 10])
})

test('restoring without a push would have put them straight back at the front', () => {
  // Guards the old behaviour from creeping back: ordering purely by token
  // number is what made a returning no-show leapfrog the whole queue.
  const tokens = [token(2, 'waiting'), token(7), token(8)]

  assert.deepEqual(numbersOf(waitingInOrder(tokens)), [2, 7, 8])
})

test('deferred patients keep a stable order between polls', () => {
  // Two patients pushed to the same spot must not swap places on every refresh.
  const a = token(4, 'waiting', 9)
  const b = token(6, 'waiting', 9)

  assert.ok(compareQueueOrder(a, b) < 0)
  assert.ok(compareQueueOrder(b, a) > 0)
})

test('patients ahead counts queue order, not lower token numbers', () => {
  const tokens = [token(1, 'waiting', 4.5), token(2), token(3), token(4)]

  assert.equal(countPatientsAhead(tokens, tokens[0]), 3)
  assert.equal(countPatientsAhead(tokens, tokens[1]), 0)
})

test('a patient is never counted as being ahead of themselves', () => {
  const tokens = [token(1), token(2)]

  assert.equal(countPatientsAhead(tokens, tokens[0]), 0)
})
