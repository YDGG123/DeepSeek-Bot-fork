// Room cards: a member asks in a group chat, its part of the round waits for the user,
// the other members carry on, and the answer comes back to the member that asked.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Chief is the admin of group 'r1' and speaks there from 'ga'; Writer from 'gb'; Tester
// from 'gc'. Everyone answers a plain message in turn (mode 'everyone').
const seed = (extra = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Outsider', role: 'Elsewhere', sessionId: 'd', createdAt: 4 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
  ...extra,
})

async function start(t, state = seed()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roomcards-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const held = []
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) {
          const at = held.findIndex(message => message.id === id)
          if (at === -1) return false
          held.splice(at, 1)
          return true
        },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const team = async () => (await call('state', {})).value
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    if (reply !== undefined) emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    return () => result
  }
  const say = value => ({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
  const takePost = () => agentOf('r1').calls.shift()
  await tool('list_bots', {}, 'a')
  return { ctx, rt, agentOf, emit, tool, call, team, begin, finish, round, say, takePost }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const questions = (host) => host.rt.state.roomCards?.r1 ?? []

test('ask_user in a group queues the card in the group, not on the member\'s Session', async (t) => {
  const host = await start(t)
  const args = { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }
  let concluded = 0
  await host.tool('ask_user', args, 'gb', { callId: 'q1', concludeTurn() { concluded += 1 } })
  assert.equal(concluded, 1)
  assert.equal(host.rt.state.questions.gb, undefined)
  const cards = questions(host)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'question')
  assert.equal(cards[0].botId, 'b')
  assert.equal(cards[0].question, '用哪个库？')

  // The same card asked again is the same waiting card.
  await host.tool('ask_user', args, 'gb', { callId: 'q2', concludeTurn() {} })
  assert.equal(questions(host).length, 1)

  // A different question from the same member is a second legitimate card.
  await host.tool('ask_user', { question: '要不要写文档？', options: [{ label: '要' }, { label: '不要' }] }, 'gb', { callId: 'q3', concludeTurn() {} })
  assert.equal(questions(host).length, 2)
  assert.deepEqual(questions(host).map(card => card.question), ['用哪个库？', '要不要写文档？'])
})

test('a member asking in a round keeps its slot waiting while the next member speaks', async (t) => {
  const host = await start(t)
  const done = host.round('c1', host.say('大家说一下方案'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '先说我：按 A 方案。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  host.finish('gb', undefined)
  // The round goes on: the third member still gets its turn.
  await settle(() => host.agentOf('gc').calls.length === 1)
  const slots = host.rt.roomProgress.get('c1').slots.map(slot => [slot.id, slot.status])
  assert.deepEqual(slots, [['a', 'posted'], ['b', 'waiting-answer'], ['c', 'speaking']])
  host.begin('gc')
  host.finish('gc', '我看 B 更稳。')
  await settle(() => done() !== undefined)
  assert.deepEqual(done().waitingAnswers, [{ botId: 'b', name: 'Writer', kind: 'question' }])
  assert.equal(host.rt.state.questions.gb, undefined)
})

test('the answer goes back to the member\'s hidden group Session and lands in the log', async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  const cardId = questions(host)[0].id
  const answered = await host.call('answer-question', { sessionId: 'r1', questionId: cardId, answer: { selected: ['B'] } })
  assert.equal(answered.ok, true)
  assert.equal(questions(host).length, 0)
  const sent = host.agentOf('gb').calls.at(-1)
  assert.equal(sent.source.kind, 'user-question-reply')
  assert.equal(sent.source.role, 'room')
  assert.equal(sent.source.roomId, 'r1')
  assert.match(text(sent), /^\[Group chat "Ops" · the user answered your question card\]/)
  assert.match(text(sent), /answer_to_pending_question/)
  // The choice is in the log as a kind 'answer' line, which the preview leaves out.
  const line = host.rt.state.rooms.r1.log.find(entry => entry.kind === 'answer')
  assert.deepEqual([line.who, line.text], ['User', 'Question card answered: B'])
  const room = (await host.team()).rooms.find(entry => entry.id === 'r1')
  assert.equal(room.preview, undefined)
  // A second answer is refused: the card was claimed before it was sent.
  const again = await host.call('answer-question', { sessionId: 'r1', questionId: cardId, answer: { selected: ['A'] } })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'bot/stale')
})

test('a view card answers the same way and validates its values', async (t) => {
  const host = await start(t)
  const view = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
  await host.tool('show_view', { title: '选方案', view }, 'gb', { callId: 'v1', concludeTurn() {} })
  const card = questions(host)[0]
  assert.equal(card.kind, 'view')
  const bad = await host.call('view-reply', { sessionId: 'r1', viewId: card.id, action: 'pick', values: { selected: ['nope'] } })
  assert.equal(bad.ok, false)
  const ok = await host.call('view-reply', { sessionId: 'r1', viewId: card.id, action: 'pick', values: { selected: ['A'] } })
  assert.equal(ok.ok, true)
  assert.equal(questions(host).length, 0)
  assert.equal(host.agentOf('gb').calls.at(-1).source.kind, 'user-question-reply')
  assert.match(host.rt.state.rooms.r1.log.find(entry => entry.kind === 'answer').text, /^View card answered/)
})

test('skipping a card tells the member, so its task resumes instead of waiting forever', async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  const cardId = questions(host)[0].id
  const skipped = await host.call('dismiss-question', { sessionId: 'r1', cardId })
  assert.equal(skipped.ok, true)
  assert.equal(questions(host).length, 0)
  const sent = host.agentOf('gb').calls.at(-1)
  assert.equal(sent.source.role, 'room')
  assert.match(text(sent), /skipped your question card/)
  // It is a note, not an answer: the member's history does not call it an answer.
  assert.equal(sent.source.kind, undefined)
})

test('a plain group message leaves the waiting card alone', async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  const cardId = questions(host)[0].id
  host.emit('r1', 'user/message', host.say('等等，先别定'))
  await settle(() => host.agentOf('r1').calls?.length > 0 || true)
  assert.deepEqual(questions(host).map(card => card.id), [cardId])
})

test("two members' cards both stay answerable, and the queue keeps its order", async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '第一个问题？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  await host.tool('ask_user', { question: '第二个问题？', options: [{ label: 'C' }, { label: 'D' }] }, 'gc', { callId: 'q2', concludeTurn() {} })
  assert.deepEqual(questions(host).map(card => card.botId), ['b', 'c'])
  // Answering the second one first is allowed; the first stays.
  const second = questions(host)[1]
  const answered = await host.call('answer-question', { sessionId: 'r1', questionId: second.id, answer: { selected: ['D'] } })
  assert.equal(answered.ok, true)
  assert.deepEqual(questions(host).map(card => card.botId), ['b'])
  assert.equal(host.agentOf('gc').calls.at(-1).source.role, 'room')
})

test('the answer follows the member\'s current group Session after a part move', async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  // The member's group Session moved on (a context reset retires the old one).
  host.rt.state.rooms.r1.sessions.b = 'gb2'
  const cardId = questions(host)[0].id
  const answered = await host.call('answer-question', { sessionId: 'r1', questionId: cardId, answer: { selected: ['A'] } })
  assert.equal(answered.ok, true)
  assert.equal(host.agentOf('gb2').calls.at(-1).source.roomId, 'r1')
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('a display-only view is refused in a group and leaves no card', async (t) => {
  const host = await start(t)
  const text = await host.tool('show_view', { title: '信息', view: { type: 'text', text: '嗯' } }, 'gb', { callId: 'v1', concludeTurn() {} })
  assert.equal(text, 'A display-only view cannot be shown in a group chat. Give the card controls (options, confirm, or form) so it waits for the user\'s answer, or write the content in your message.')
  assert.equal(questions(host).length, 0)
})

test('the answer line stays out of the preview and the member\'s late reply wakes only who it names', async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  const cardId = questions(host)[0].id
  await host.call('answer-question', { sessionId: 'r1', questionId: cardId, answer: { selected: ['A'] } })
  // The member picks its task back up in a turn of its own and posts into the group.
  host.begin('gb')
  host.finish('gb', '收到，我按 A 办。')
  await settle(() => host.agentOf('r1').calls.length > 0)
  const post = host.takePost()
  assert.match(text(post), /\[Group post from Writer\]\n收到，我按 A 办。/)
  assert.equal(post.source.late, true)
  // A late post that names nobody opens a round nobody speaks in: the other members are
  // not woken up.
  const calls = {}
  for (const id of ['ga', 'gc']) calls[id] = host.agentOf(id).calls.length
  const done = host.round('c2', post)
  await settle(() => done() !== undefined)
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [calls.ga, calls.gc])
})

test('a deleted group takes its waiting cards with it, and cards survive a restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roomcards-state-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const card = { id: 'card-1', kind: 'question', botId: 'b', roomId: 'r1', askedAt: 1, question: '问？', options: [{ label: 'A' }] }
  const stale = { ...card, id: 'card-2', roomId: 'gone' }
  const stranger = { ...card, id: 'card-3', botId: 'd' }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed({ roomCards: { r1: [card, stranger], gone: [stale] } })))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  // The card from a member still in the group stays; the group that is gone and the card
  // from a Bot that is not a member are dropped.
  assert.deepEqual(rt.state.roomCards.r1.map(entry => entry.id), ['card-1'])
  assert.equal(rt.state.roomCards.gone, undefined)
  // A restart reads the same cards back.
  await ctx.dispose()
  const again = fakeContext()
  Object.assign(again, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const second = createRuntime(again, { home, github: false, diagnosticsFile: false })
  await second.load()
  assert.deepEqual(second.state.roomCards.r1.map(entry => entry.id), ['card-1'])
  await again.dispose()
})

test('deleting the group drops its cards at once', async (t) => {
  const host = await start(t)
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  assert.equal(questions(host).length, 1)
  const removed = await host.call('delete-room', { id: 'r1' })
  assert.equal(removed.ok, true)
  assert.equal(host.rt.state.roomCards.r1, undefined)
})

test('the tools, the prompt, and the view tell a Bot that a group card waits for the user', async (t) => {
  const host = await start(t)
  const ask = host.ctx.registeredTools.get('ask_user')
  const show = host.ctx.registeredTools.get('show_view')
  assert.match(ask.description, /works in an own chat and in a group chat/)
  assert.match(show.description, /In a group chat only an interactive card can be shown/)
  const prompt = host.ctx.sections.get('bot-identity').text({ agent: { id: 'b' } })
  assert.match(prompt, /In a group chat the card waits above the group's composer/)
  assert.match(prompt, /In a group chat only a card with controls can be shown/)
  assert.doesNotMatch(prompt, /It only works in your own chat, not in a group/)
  // The view hands the group's queue to the desktop dock.
  await host.tool('ask_user', { question: '用哪个库？', options: [{ label: 'A' }] }, 'gb', { callId: 'q1', concludeTurn() {} })
  assert.equal((await host.team()).roomCards.r1.length, 1)
})
