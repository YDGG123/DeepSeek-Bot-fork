// Card feed: the cards a Bot put on screen, published to the mobile gateway as
// `dsBotCards`. Shapes follow the gateway consumer in
// dsh-plugin-mobile-gateway lib/mobile-v1/card-frames.mjs (fbd080d).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { viewText } from '../src/host/card-feed.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', instructions: '', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', instructions: '', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  views: {},
  roomCards: {},
  secretRequests: {},
  prefs: {},
  revision: 0,
})

async function start(t, state = seed()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-cardfeed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const provided = new Map()
  const sent = []
  const agentOf = sessionId => ({
    session: { id: sessionId, header: { id: sessionId } },
    followup(message) { sent.push({ sessionId, message }) },
    steer(message) { sent.push({ sessionId, message }) },
    cancel() {},
  })
  Object.assign(ctx, {
    provide: (name, value) => { provided.set(name, value) },
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  // Start from a settled cache, so a test only sees its own cards.
  rt.cardFeed.touch()
  rt.cardFeed.flush()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, rt, call, sent, provided }
}

const question = (over = {}) => ({
  id: 'q1', question: '用哪个库？', options: [{ label: 'A' }, { label: 'B' }], askedAt: 10, ...over,
})

test('the feed is published as dsBotCards and its snapshot carries flat cards', async (t) => {
  const host = await start(t)
  assert.equal(host.provided.get('dsBotCards'), host.rt.cardFeed)
  assert.equal(host.rt.cardFeed.v, 1)
  host.rt.state.questions.b = question()
  host.rt.state.views.b = { id: 'v1', title: '选方案', view: { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }, askedAt: 20 }
  host.rt.state.secretRequests.b = [{ id: 's1', sessionId: 'b', name: 'GITHUB_TOKEN', purpose: '发版用', kind: 'fill', status: 'pending', askedAt: 30 }]
  const snap = host.rt.cardFeed.snapshot()
  assert.equal(snap.kind, 'card-snapshot')
  assert.equal(snap.seq, 0)
  assert.deepEqual(snap.cards.map(card => card.kind), ['question', 'view', 'secret'])
  const [q, v, s] = snap.cards
  assert.equal(q.id, 'q1')
  assert.equal(q.botId, 'b')
  assert.equal(q.sessionId, 'b')
  assert.equal(q.questions[0].question, '用哪个库？')
  assert.deepEqual(q.questions[0].options, [{ label: 'A' }, { label: 'B' }])
  assert.equal(v.view.title, '选方案')
  assert.equal(v.view.text, 'Options: A / B')
  assert.deepEqual(Object.keys(v.view).sort(), ['text', 'title'])
  assert.deepEqual(s.secret, { name: 'GITHUB_TOKEN', description: '发版用', save: true })
  // A second snapshot does not consume seq.
  assert.equal(host.rt.cardFeed.snapshot().seq, 0)
})

test('the answer target for a group card is the group id, and the hidden Session stays internal', async (t) => {
  const host = await start(t)
  host.rt.state.roomCards.r1 = [{ ...question({ id: 'g1', askedAt: 10 }), kind: 'question', botId: 'b', roomId: 'r1' }]
  const card = host.rt.cardFeed.snapshot().cards[0]
  assert.equal(card.sessionId, 'r1')
  assert.equal(card.roomId, 'r1')
  assert.equal(JSON.stringify(card).includes('gb'), false)
})

test('the question card keeps the labels it was asked with, exactly', async (t) => {
  const host = await start(t)
  host.rt.state.questions.b = question({ options: [{ label: 'A / B' }, { label: ' 带空格 ' }, { label: '中文！' }], multiSelect: true, allowCustom: true, detail: '一行说明' })
  const [card] = host.rt.cardFeed.snapshot().cards
  assert.deepEqual(card.questions[0].options.map(option => option.label), ['A / B', ' 带空格 ', '中文！'])
  assert.equal(card.questions[0].multiple, true)
  assert.equal(card.questions[0].custom, true)
  assert.equal(card.questions[0].description, '一行说明')
})

test('a card appears as card.shown with its whole body, and seq/base move together', async (t) => {
  const host = await start(t)
  const frames = []
  host.rt.cardFeed.subscribe(frame => frames.push(frame))
  host.rt.state.questions.b = question()
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].v, 1)
  assert.equal(frames[0].kind, 'card')
  assert.equal(frames[0].seq, 1)
  assert.equal(frames[0].base, 0)
  assert.deepEqual(frames[0].ops.map(op => op.op), ['card.shown'])
  assert.equal(frames[0].ops[0].card.questions[0].question, '用哪个库？')
  // The same card is not shown twice.
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  assert.equal(frames.length, 1)
})

test('answering a question card sends card.answered and drops it from the snapshot', async (t) => {
  const host = await start(t)
  host.rt.state.questions.b = question()
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  const frames = []
  host.rt.cardFeed.subscribe(frame => frames.push(frame))
  const answered = await host.call('answer-question', { sessionId: 'b', questionId: 'q1', answer: { selected: ['B'] } })
  assert.equal(answered.ok, true)
  host.rt.cardFeed.flush()
  assert.deepEqual(frames.flatMap(frame => frame.ops), [{ op: 'card.answered', id: 'q1' }])
  assert.equal(host.rt.cardFeed.snapshot().cards.length, 0)
})

test('skipping a card sends card.cleared, not card.answered', async (t) => {
  const host = await start(t)
  host.rt.state.roomCards.r1 = [{ ...question({ id: 'g1' }), kind: 'question', botId: 'b', roomId: 'r1' }]
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  const frames = []
  host.rt.cardFeed.subscribe(frame => frames.push(frame))
  const skipped = await host.call('dismiss-question', { sessionId: 'r1', cardId: 'g1' })
  assert.equal(skipped.ok, true)
  host.rt.cardFeed.flush()
  assert.deepEqual(frames.flatMap(frame => frame.ops), [{ op: 'card.cleared', id: 'g1' }])
})

test('a card whose answer failed is not reported answered later', async (t) => {
  const host = await start(t)
  host.rt.state.questions.b = question()
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  const frames = []
  host.rt.cardFeed.subscribe(frame => frames.push(frame))
  // The answer starts, the card is called answered, then the write fails and the card
  // comes back: it must no longer be marked as answered.
  host.rt.cardFeed.answered('q1')
  host.rt.cardFeed.unanswered('q1')
  host.rt.cardFeed.flush()
  assert.deepEqual(frames, [])
  // When it does leave the queue afterwards, it leaves as cleared, not answered.
  delete host.rt.state.questions.b
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  assert.deepEqual(frames.flatMap(frame => frame.ops), [{ op: 'card.cleared', id: 'q1' }])
})

test('a failed save leaves the card shown, not answered', async (t) => {
  const host = await start(t)
  host.rt.state.secretRequests.b = [{ id: 's1', sessionId: 'b', name: 'GITHUB_TOKEN', purpose: '发版用', kind: 'fill', status: 'pending', askedAt: 30 }]
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  const frames = []
  host.rt.cardFeed.subscribe(frame => frames.push(frame))
  const realSave = host.rt.save
  host.rt.save = async () => { throw new Error('disk full') }
  const failed = await host.call('secret-set', { requestId: 's1', value: 'test-value-9f3a2b' })
  host.rt.save = realSave
  assert.equal(failed.ok, false)
  // Whatever the frames raced to say, the card is back on screen and the last word about
  // it is not "answered".
  assert.equal(host.rt.cardFeed.snapshot().cards.some(card => card.id === 's1'), true)
  const ops = frames.flatMap(frame => frame.ops).filter(op => op.id === 's1')
  assert.notEqual(ops.at(-1)?.op, 'card.answered')
})

test('a secret card never carries the value', async (t) => {
  const host = await start(t)
  host.rt.state.secretRequests.b = [{ id: 's1', sessionId: 'b', name: 'GITHUB_TOKEN', purpose: '发版用', kind: 'fill', status: 'pending', askedAt: 30 }]
  const encoded = JSON.stringify(host.rt.cardFeed.snapshot().cards)
  assert.equal(encoded.includes('secret-value-must-not-leak'), false)
  const card = host.rt.cardFeed.snapshot().cards[0]
  assert.deepEqual(Object.keys(card.secret).sort(), ['description', 'name', 'save'])
  assert.equal(card.secret.save, true)
})

test('the view blueprint is flattened to readable text, the same way every time', () => {
  const blueprint = {
    type: 'stack',
    children: [
      { type: 'text', text: '本周进度' },
      { type: 'metric', label: '完成', value: '70%' },
      { type: 'table', columns: [{ key: 'n', label: '名称' }, { key: 'v', label: '值' }], rows: [{ n: 'A', v: '1' }, { n: 'B', v: '2' }] },
      { type: 'progress', label: '构建', percent: 40 },
    ],
  }
  assert.equal(viewText(blueprint), '本周进度\n完成: 70%\n名称 | 值\nA | 1\nB | 2\n构建 40%')
  assert.equal(viewText(blueprint), viewText(blueprint))
  // Options and forms become text too: the phone keeps no controls in v1.
  assert.equal(viewText({ type: 'options', id: 'p', options: [{ label: 'A' }, { label: 'B' }] }), 'Options: A / B')
  assert.equal(viewText({ type: 'form', id: 'f', fields: [{ id: 'name', label: 'Name' }] }), 'Form: Name')
  // Upstream 0.2.1's new view components flatten to one readable line each, so a group
  // card projected to the phone loses no information.
  assert.equal(viewText({ type: 'row', children: [{ type: 'metric', label: '完成', value: '70%' }] }), '完成: 70%')
  assert.equal(viewText({ type: 'chart', kind: 'bar', categories: ['一月', '二月'], series: [{ name: '下载', values: [3, 5] }] }), 'Chart (bar)\nCategories: 一月, 二月\n下载: 3, 5')
  assert.equal(viewText({ type: 'callout', text: '注意配额' }), '注意配额')
  assert.equal(viewText({ type: 'sources', items: [{ label: '文档', url: 'https://example.com' }] }), '文档 https://example.com')
  assert.equal(viewText({ type: 'slider', label: '阈值', min: 0, max: 10, value: 4 }), '阈值: 4')
  assert.equal(viewText({ type: 'toggle', label: '通知', value: true }), '通知: on')
  assert.equal(viewText({ type: 'choice', label: '渠道', options: [{ label: 'A' }, { label: 'B' }] }), '渠道: (A / B)')
  assert.equal(viewText({ type: 'html', summary: '一段沙箱演示' }), '一段沙箱演示')
  assert.equal(viewText({ type: 'submit', label: '发送' }), '[Submit: 发送]')
  // A formula value shows as its stored source: the phone resolves nothing.
  assert.equal(viewText({ type: 'metric', label: '合计', value: { '=': 'a * b' } }), '合计: =`a * b`')
})

test('without subscribers nothing is framed and seq stays put', async (t) => {
  const host = await start(t)
  host.rt.state.questions.b = question()
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  assert.equal(host.rt.cardFeed.seq(), 0)
  const frames = []
  host.rt.cardFeed.subscribe(frame => frames.push(frame))
  host.rt.state.questions.b = question({ id: 'q2' })
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].seq, 1)
})

test('a deleted group clears its cards; an unsubscribed reader gets nothing', async (t) => {
  const host = await start(t)
  host.rt.state.roomCards.r1 = [{ ...question({ id: 'g1' }), kind: 'question', botId: 'b', roomId: 'r1' }]
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  const frames = []
  const off = host.rt.cardFeed.subscribe(frame => frames.push(frame))
  const removed = await host.call('delete-room', { id: 'r1' })
  assert.equal(removed.ok, true)
  host.rt.cardFeed.flush()
  assert.deepEqual(frames.flatMap(frame => frame.ops), [{ op: 'card.cleared', id: 'g1' }])
  off()
  host.rt.state.questions.b = question()
  host.rt.cardFeed.touch()
  host.rt.cardFeed.flush()
  assert.equal(frames.length, 1)
})
