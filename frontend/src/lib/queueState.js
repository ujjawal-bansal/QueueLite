/**
 * Merging a queue in the browser.
 *
 * The dashboard applies each staff action optimistically so the desk sees it
 * land instantly, then reconciles with the server's answer. That means the same
 * change arrives more than once, by more than one route, and these helpers are
 * what keep the counts honest when it does.
 */

export function updateToken(queue, updatedToken) {
  if (!queue) {
    return queue
  }

  const previousToken = queue.tokens.find((token) => token.id === updatedToken.id)
  const wasWaiting = previousToken?.status === 'waiting'
  const isWaiting = updatedToken.status === 'waiting'
  let waitingCount = queue.waiting_count

  if (wasWaiting && !isWaiting) {
    waitingCount = Math.max(0, waitingCount - 1)
  } else if (!wasWaiting && isWaiting) {
    waitingCount += 1
  }

  let currentTokenNumber = queue.current_token_number

  if (updatedToken.status === 'in_progress') {
    currentTokenNumber = updatedToken.token_number
  } else if (previousToken?.status === 'in_progress') {
    currentTokenNumber = null
  }

  return {
    ...queue,
    current_token_number: currentTokenNumber,
    waiting_count: waitingCount,
    tokens: queue.tokens.map((token) => {
      if (token.id === updatedToken.id) {
        return updatedToken
      }

      if (updatedToken.status === 'in_progress' && token.status === 'in_progress') {
        return { ...token, status: 'done' }
      }

      return token
    }),
  }
}

export function setTokenStatus(queue, tokenId, status) {
  if (!queue) {
    return queue
  }

  const changedToken = queue.tokens.find((token) => token.id === tokenId)
  const wasWaiting = changedToken?.status === 'waiting'
  const isWaiting = status === 'waiting'
  let waitingCount = queue.waiting_count

  if (wasWaiting && !isWaiting) {
    waitingCount = Math.max(0, waitingCount - 1)
  } else if (!wasWaiting && isWaiting) {
    waitingCount += 1
  }

  let currentTokenNumber = queue.current_token_number

  if (status === 'in_progress' && changedToken) {
    currentTokenNumber = changedToken.token_number
  } else if (changedToken?.status === 'in_progress') {
    currentTokenNumber = null
  }

  return {
    ...queue,
    current_token_number: currentTokenNumber,
    waiting_count: waitingCount,
    tokens: queue.tokens.map((token) => {
      if (token.id === tokenId) {
        return { ...token, status }
      }

      if (status === 'in_progress' && token.status === 'in_progress') {
        return { ...token, status: 'done' }
      }

      return token
    }),
  }
}

/**
 * Adds a freshly issued token, once.
 *
 * A poll that overlaps the create can already have brought this row in. Adding
 * it again showed the patient twice in the waiting list and counted them twice
 * against the waiting total, until the next poll happened to replace the list.
 */
export function addTokenToQueue(queue, token) {
  if (!queue) {
    return queue
  }

  if (queue.tokens.some((existing) => existing.id === token.id)) {
    return queue
  }

  return {
    ...queue,
    waiting_count: queue.waiting_count + 1,
    tokens: [...queue.tokens, token].sort((a, b) => a.token_number - b.token_number),
  }
}

/**
 * Where a token sits in today's queue.
 *
 * Mirrors the server's ordering exactly. Almost always the token's own number:
 * queue_position is set only for a patient who has been pushed back, so an
 * ordinary day never touches it.
 */
export function effectivePosition(token) {
  const deferred = token?.queue_position

  return deferred === null || deferred === undefined
    ? Number(token?.token_number)
    : Number(deferred)
}

/**
 * Queue order. Token number breaks ties, so two patients pushed to the same
 * spot keep a stable order instead of swapping places on every poll.
 */
export function compareQueueOrder(a, b) {
  return effectivePosition(a) - effectivePosition(b) || a.token_number - b.token_number
}

export function waitingInOrder(tokens = []) {
  return tokens.filter((token) => token.status === 'waiting').sort(compareQueueOrder)
}
