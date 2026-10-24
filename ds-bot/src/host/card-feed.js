// Card feed: the cards a Bot put on screen, published to the mobile gateway as
// `dsBotCards`.
//
// The gateway consumer is already written (dsh-plugin-mobile-gateway
// lib/mobile-v1/card-frames.mjs, fbd080d): it takes one snapshot of flat cards, then
// `kind: 'card'` frames whose ops are only `card.shown` (with the whole card),
// `card.answered` and `card.cleared` (id only). A card never changes after it is shown,
// so a changed card is a new id. The contract is docs/card-projection-v1.md.
//
// Secrets: a secret card carries its name, its purpose and `save: true`; the value never
// leaves the host. View cards are projected for reading only: the consumer keeps
// `view.title` / `view.text` / `view.body`, so the blueprint is flattened to text and the
// interactive answer stays on the desktop in v1.
import { randomUUID } from 'node:crypto'

const MAX_OPS = 200
const VIEW_TEXT_MAX = 2_000

const field = value => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '')

function flattenView(node, depth = 0) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 12) return []
  const type = node.type ?? node.component
  if (type === 'stack') return (Array.isArray(node.children) ? node.children : []).flatMap(child => flattenView(child, depth + 1))
  if (type === 'text') return [field(node.text)]
  if (type === 'metric') return [[field(node.label), field(node.value)].filter(Boolean).join(': ')]
  if (type === 'table') {
    const columns = Array.isArray(node.columns) ? node.columns : []
    const head = columns.map(column => field(column?.label) || field(column?.key)).filter(Boolean).join(' | ')
    const rows = (Array.isArray(node.rows) ? node.rows : []).map((row) => {
      if (!row || typeof row !== 'object') return ''
      return columns.map(column => field(row[column?.key])).join(' | ')
    })
    return [head, ...rows].filter(Boolean)
  }
  if (type === 'options') {
    const labels = (Array.isArray(node.options) ? node.options : []).map(option => field(option?.label)).filter(Boolean)
    return [labels.length === 0 ? '' : `Options: ${labels.join(' / ')}`]
  }
  if (type === 'confirm') {
    const label = field(node.confirmLabel) || 'Confirm'
    const cancel = field(node.cancelLabel) || 'Cancel'
    return [[field(node.label) || field(node.title), `[${label}] [${cancel}]`].filter(Boolean).join(' ')]
  }
  if (type === 'form') {
    const labels = (Array.isArray(node.fields) ? node.fields : []).map(item => field(item?.label) || field(item?.id)).filter(Boolean)
    return [labels.length === 0 ? 'Form' : `Form: ${labels.join(', ')}`]
  }
  if (type === 'progress') {
    const percent = Number.isFinite(node.percent) ? `${node.percent}%` : ''
    return [[field(node.label), percent].filter(Boolean).join(' ')]
  }
  return []
}

// The whole blueprint as one plain-text body; deterministic for the same input.
export function viewText(view) {
  const lines = flattenView(view).filter(line => line.trim() !== '')
  const text = lines.join('\n')
  return text.length <= VIEW_TEXT_MAX ? text : `${text.slice(0, VIEW_TEXT_MAX)}…`
}

export function install(rt) {
  const { ctx, state } = rt
  const instanceId = randomUUID()
  const listeners = new Set()
  // Cards each reader has already been sent, by id, and the ids the user answered (so a
  // card leaving the queue is `answered`, not `cleared`).
  let sent = new Map()
  const answered = new Set()
  let seq = 0
  let pending = false
  let timer = null
  let timerAt = 0

  const schedule = (delay) => {
    const at = Date.now() + delay
    if (timer !== null && timerAt <= at) return
    if (timer !== null) clearTimeout(timer)
    timerAt = at
    timer = setTimeout(() => { timer = null; timerAt = 0; flush() }, delay)
    timer.unref?.()
  }

  const questionCard = (meta, record) => ({
    ...meta,
    kind: 'question',
    questions: [{
      id: meta.id,
      question: String(record.question ?? ''),
      multiple: record.multiSelect === true,
      ...(record.detail ? { description: String(record.detail) } : {}),
      ...(record.allowCustom === true ? { custom: true } : {}),
      // Labels are the answer's identity: kept exactly as written.
      options: (Array.isArray(record.options) ? record.options : [])
        .filter(option => option !== null && typeof option === 'object' && typeof option.label === 'string')
        .map(option => ({ label: option.label, ...(option.description ? { description: String(option.description) } : {}) })),
    }],
  })

  const viewCard = (meta, record) => ({
    ...meta,
    kind: 'view',
    // The phone keeps title / text / body only; controls stay on the desktop in v1.
    view: { title: String(record.title ?? ''), text: viewText(record.view) },
  })

  const meta = (id, at, botId, sessionId, roomId) => ({
    id,
    at: Number.isSafeInteger(at) ? at : Date.now(),
    ...(botId === undefined ? {} : { botId }),
    sessionId,
    ...(roomId === undefined ? {} : { roomId }),
  })

  const collect = () => {
    const cards = new Map()
    for (const bot of Object.values(state.bots)) {
      const chat = rt.chatOf(bot.id)
      if (chat === undefined) continue
      const question = rt.own(state.questions, chat)
      if (question !== undefined) cards.set(question.id, questionCard(meta(question.id, question.askedAt, bot.id, chat), question))
      const view = rt.own(state.views, chat)
      if (view !== undefined) cards.set(view.id, viewCard(meta(view.id, view.askedAt, bot.id, chat), view))
      for (const request of state.secretRequests?.[bot.id] ?? []) {
        if (request.status !== 'pending') continue
        // A key card asked in a group answers by group id; the hidden Session stays internal.
        const inRoom = request.roomId === undefined ? undefined : rt.roomOf(request.roomId)
        cards.set(request.id, {
          ...meta(request.id, request.askedAt, bot.id, inRoom === undefined ? request.sessionId ?? chat : inRoom.id, inRoom?.id),
          kind: 'secret',
          // Values never leave the host; only what the card is for.
          secret: { name: String(request.name ?? ''), ...(request.purpose ? { description: String(request.purpose) } : {}), save: true },
        })
      }
    }
    for (const [roomId, list] of Object.entries(state.roomCards ?? {})) {
      if (!Array.isArray(list)) continue
      for (const card of list) {
        // In a group the answer goes back by group id; the hidden Session stays internal.
        const common = meta(card.id, card.askedAt, card.botId, roomId, roomId)
        if (card.kind === 'question') cards.set(card.id, questionCard(common, card))
        else if (card.kind === 'view') cards.set(card.id, viewCard(common, card))
      }
    }
    return new Map([...cards].sort(([left], [right]) => (cards.get(left).at - cards.get(right).at) || left.localeCompare(right)))
  }

  const snapshot = () => {
    // Read-only for the reader: the pending change goes to whoever was already here
    // first, so nobody is sent the same card twice.
    if (pending) {
      if (listeners.size > 0) flush()
      else {
        pending = false
        sent = collect()
      }
    }
    const now = collect()
    sent = now
    return { v: 1, kind: 'card-snapshot', instanceId, seq, at: Date.now(), cards: [...now.values()] }
  }

  const deliver = (listener, frame) => {
    try {
      listener(frame)
    } catch (error) {
      rt.warn?.('ds-bot: card feed subscriber failed: %s', error)
    }
  }

  function flush() {
    if (!pending) return
    pending = false
    const now = collect()
    const ops = []
    for (const id of now.keys()) if (!sent.has(id)) ops.push({ op: 'card.shown', id, card: now.get(id) })
    for (const id of sent.keys()) {
      if (now.has(id)) continue
      ops.push({ op: answered.has(id) ? 'card.answered' : 'card.cleared', id })
    }
    for (const id of answered) if (!now.has(id)) answered.delete(id)
    sent = now
    if (listeners.size === 0 || ops.length === 0) return
    if (ops.length > MAX_OPS) {
      const whole = snapshot()
      for (const listener of listeners) deliver(listener, whole)
      return
    }
    seq += 1
    const frame = { v: 1, kind: 'card', instanceId, seq, base: seq - 1, at: Date.now(), ops }
    for (const listener of listeners) deliver(listener, frame)
  }

  const feed = {
    v: 1,
    instanceId,
    seq: () => seq,
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    flush,
    // A card that came or went: diff on the next tick.
    touch() {
      pending = true
      schedule(0)
    },
    // The user answered this card; the gateway shows `card.answered`, not `card.cleared`.
    answered(id) {
      if (typeof id === 'string') answered.add(id)
      pending = true
      schedule(0)
    },
    // A write that failed puts the card back: the next frame must not call it answered.
    unanswered(id) {
      answered.delete(id)
      pending = true
      schedule(0)
    },
  }

  Object.assign(rt, { cardFeed: feed })
  ctx.provide?.('dsBotCards', feed)
}
