// Team feed: the roster published to the mobile gateway as `dsBotTeam`.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { defaultColor, defaultShape, lookOf, SHAPES } from '../src/client/characters.js'
import { fakeContext } from './fake-ctx.js'

// Chief (a) and Writer (b) are in group 'r1'; Writer speaks there from 'gb'. Tester (c)
// keeps its own chat only.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', instructions: 'Run the team', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, segments: [{ sessionId: 'b-old', endedAt: 1 }] },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3, pinned: true },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true,
      notice: 'Be brief', sessions: { a: 'ga', b: 'gb' }, log: [], seq: 4, seen: {},
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  views: {},
  prefs: {},
  revision: 0,
})

async function start(t, { timers = false, config = {}, seedPatch } = {}) {
  if (timers) t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-teamfeed-'))
  const state = seed()
  seedPatch?.(state)
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const provided = new Map()
  const sent = []
  const agentOf = (sessionId) => ({
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
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false, ...config })
  await rt.load()
  // Settle the cache on the loaded team, so a test sees only its own changes.
  rt.teamFeed.touch()
  rt.teamFeed.flush()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const read = () => ({ ctx, rt, emit, sent, provided })
  return read()
}

const bot = (snapshot, id) => snapshot.bots.find(entry => entry.id === id)
const room = (snapshot, id) => snapshot.rooms.find(entry => entry.id === id)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('the feed is published as dsBotTeam and its snapshot carries the roster', async (t) => {
  const host = await start(t)
  assert.equal(host.provided.get('dsBotTeam'), host.rt.teamFeed)
  assert.equal(host.rt.teamFeed.v, 1)
  assert.equal(typeof host.rt.teamFeed.instanceId, 'string')

  const snap = host.rt.teamFeed.snapshot()
  assert.equal(snap.kind, 'snapshot')
  assert.equal(snap.mainBotId, 'a')
  assert.deepEqual(snap.mainBotIds, ['a'])
  assert.equal(snap.seq, 0)

  const chief = bot(snap, 'a')
  assert.deepEqual([chief.kind, chief.name, chief.role, chief.main, chief.pinned], ['bot', 'Chief', 'Boss', true, false])
  assert.equal(chief.instructions, 'Run the team')
  assert.equal(chief.activity, 'idle')
  assert.deepEqual(chief.pending, [])
  assert.deepEqual(chief.approvals, [])
  const writer = bot(snap, 'b')
  assert.deepEqual(writer.parts, ['b-old'])
  const tester = bot(snap, 'c')
  assert.equal(tester.pinned, true)

  const ops = room(snap, 'r1')
  assert.deepEqual([ops.kind, ops.name, ops.mode, ops.admin, ops.notice], ['room', 'Ops', 'everyone', 'a', 'Be brief'])
  assert.deepEqual(ops.members, ['a', 'b'])
})

test('roster resolves avatar shape and color before publishing (single source of truth)', async (t) => {
  const host = await start(t, {
    seedPatch: state => {
      // a：存值优先（用户选过角色 + 颜色）
      state.bots.a.color = 'magenta'
      state.bots.a.avatar = { shape: 'star' }
      // b：带图片，shape 仍是解析后的角色 id
      state.bots.b.avatar = { shape: 'acorn', image: 'data:image/png;base64,AA' }
      // c：什么都没有 → host 必须按 bot id 推导出稳定值
    },
  })
  const snap = host.rt.teamFeed.snapshot()

  const chief = bot(snap, 'a')
  assert.deepEqual([chief.avatar.shape, chief.color], ['star', 'magenta'])

  const writer = bot(snap, 'b')
  assert.deepEqual(writer.avatar, { shape: 'acorn', image: 'data:image/png;base64,AA' })

  const tester = bot(snap, 'c')
  assert.deepEqual([tester.avatar.shape, tester.color], [defaultShape('c'), defaultColor('c')])

  // 契约：shape / color 必有值，读者不需要（也不应该）自己推导。
  for (const entry of snap.bots) {
    assert.equal(typeof entry.avatar?.shape, 'string')
    assert.ok(entry.avatar.shape.length > 0)
    assert.equal(typeof entry.color, 'string')
    assert.ok(entry.color.length > 0)
  }
})

test('glyph 与电脑端同一张 SHAPES 表，不是第二份数据', async (t) => {
  const host = await start(t, {
    seedPatch: state => {
      state.bots.a.color = 'magenta'
      state.bots.a.avatar = { shape: 'star' }
      state.bots.b.avatar = { shape: 'acorn', image: 'data:image/png;base64,AA' }
    },
  })
  const snap = host.rt.teamFeed.snapshot()
  for (const entry of snap.bots) {
    const look = lookOf(host.rt.state.bots[entry.id])
    // 有自定义位图的不发 glyph（让位给照片），其余必须与桌面同源。
    if (look.image) { assert.equal(entry.glyph, undefined); continue }
    const def = SHAPES[look.shape]
    assert.equal(entry.glyph.shape, look.shape)
    assert.equal(entry.glyph.color, look.color)
    assert.equal(entry.glyph.size, def.size)
    // 逐字段同源：手机画的就是桌面这张表里的几何。
    assert.equal(entry.glyph.path, def.path)
    // layers 必须是结构化数组（不是 SVG 标记串）：手机端只消费数据、不解析字符串。
    assert.ok(Array.isArray(entry.glyph.layers))
    assert.ok(entry.glyph.layers.length > 0)
    for (const layer of entry.glyph.layers) {
      assert.equal(typeof layer.d, 'string')
      assert.ok(layer.d.length > 0)
      assert.equal(typeof layer.fill, 'string')
      assert.match(layer.fill, /^#[0-9a-fA-F]{3,8}$/)
      assert.equal(typeof layer.opacity, 'number')
    }
    assert.deepEqual(entry.glyph.layers, def.layerDefs)
    assert.equal(typeof entry.glyph.layers, 'object')
    assert.deepEqual(entry.glyph.eyes, def.eyes)
  }
  // 三层兜底的第 2 层：有自定义位图时让位，手机该看到用户自己的照片。
  assert.equal(bot(snap, 'b').glyph, undefined)
  assert.equal(bot(snap, 'b').avatar.image, 'data:image/png;base64,AA')
  assert.equal(bot(snap, 'a').glyph.color, 'magenta')
  // avatar 仍是对象（不是字符串），glyph 是可选字段。
  assert.equal(typeof bot(snap, 'a').avatar, 'object')
  assert.equal(typeof bot(snap, 'a').avatar.shape, 'string')
})

test('二十个 Bot 的 glyph 加起来仍然很小', async (t) => {
  const host = await start(t, {
    seedPatch: (state) => {
      state.bots = {}
      const shapes = Object.keys(SHAPES)
      for (let index = 0; index < 20; index += 1) {
        const id = `bot-${index}`
        state.bots[id] = { id, name: `Bot ${index}`, role: 'R', instructions: '', sessionId: id, createdAt: index + 1, avatar: { shape: shapes[index % shapes.length] } }
      }
    },
  })
  const snap = host.rt.teamFeed.snapshot()
  assert.equal(snap.bots.length, 20)
  const bytes = Buffer.byteLength(JSON.stringify(snap.bots.map(entry => entry.glyph)))
  // 红线：整份名单的字形远低于网关 1MB 分帧阈值；这里钉在 64KB。
  assert.ok(bytes < 64 * 1024, `20 glyphs = ${bytes} B`)
})

test('snapshot never consumes seq, and a delta bases on the frame the reader applied', async (t) => {
  const host = await start(t, { timers: true })
  const frames = []
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  const first = host.rt.teamFeed.snapshot()
  const second = host.rt.teamFeed.snapshot()
  assert.equal(first.seq, 0)
  assert.equal(second.seq, 0)
  host.emit('gb', 'turn/start', { turn: 1 })
  t.mock.timers.tick(400)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].kind, 'delta')
  assert.equal(frames[0].seq, 1)
  assert.equal(frames[0].base, 0)
  const snap = host.rt.teamFeed.snapshot()
  assert.equal(snap.seq, 1)
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(400)
  assert.equal(frames.length, 2)
  assert.equal(frames[1].base, 1)
})

test('a poke is coalesced for 400 ms, and the patch carries absolute values', async (t) => {
  const host = await start(t, { timers: true })
  const frames = []
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  // Drain whatever setup left scheduled, then start from an empty window.
  t.mock.timers.tick(1_000)
  frames.length = 0
  // Two pokes inside one window are one frame; nothing is read before the window closes.
  host.rt.state.bots.b.role = 'Docs'
  host.rt.teamFeed.poke()
  host.rt.teamFeed.poke()
  t.mock.timers.tick(399)
  assert.equal(frames.length, 0)
  t.mock.timers.tick(1)
  assert.equal(frames.length, 1)
  const update = frames[0].ops.find(op => op.op === 'bot.update' && op.id === 'b')
  assert.equal(update.set.role, 'Docs')
})

test('live work reaches the feed as a patch with the tool, its note, and the group', async (t) => {
  const host = await start(t, { config: { teamFeedThrottleMs: 20 } })
  const frames = []
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'bash', arguments: JSON.stringify({ description: 'run the tests' }) })
  await sleep(120)
  const ops = frames.flatMap(frame => frame.ops)
  const patch = ops.filter(op => op.op === 'bot.patch' && op.id === 'b').at(-1)
  assert.equal(patch.set.activity, 'working')
  assert.equal(patch.set.work.tool, 'bash')
  assert.equal(patch.set.work.note, 'run the tests')
  assert.equal(typeof patch.set.lastActivityAt, 'number')
  // The group knows it, too.
  const roomPatch = ops.filter(op => op.op === 'room.patch' && op.id === 'r1').at(-1)
  assert.equal(typeof roomPatch.set.lastActivityAt, 'number')
})

test('a structural change is sent at once as an update carrying the changed fields', async (t) => {
  const host = await start(t)
  const frames = []
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  host.rt.state.bots.b.name = 'Writer Two'
  host.rt.state.bots.b.role = 'Docs'
  await host.rt.save()
  await sleep(30)
  assert.equal(frames.length, 1)
  const update = frames[0].ops.find(op => op.op === 'bot.update' && op.id === 'b')
  assert.equal(update.set.name, 'Writer Two')
  assert.equal(update.set.role, 'Docs')
  assert.equal(update.set.instructions, undefined)
})

test('a new Bot and a removed Bot arrive as add and remove; main.set follows a Main Bot change', async (t) => {
  const host = await start(t)
  const frames = []
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  host.rt.teamFeed.snapshot()
  host.rt.state.bots.z = { id: 'z', name: 'Newcomer', role: '', instructions: '', createdAt: 9, capabilities: [] }
  host.rt.state.mainBotIds = ['a', 'z']
  await host.rt.save()
  await sleep(30)
  const ops = frames[0].ops.map(op => op.op)
  assert.ok(ops.includes('bot.add'))
  assert.ok(ops.includes('main.set'))
  const add = frames[0].ops.find(op => op.op === 'bot.add')
  assert.equal(add.set.name, 'Newcomer')
  delete host.rt.state.bots.z
  host.rt.state.mainBotIds = ['a']
  await host.rt.save()
  await sleep(30)
  const removed = frames[1].ops.find(op => op.op === 'bot.remove')
  assert.equal(removed.id, 'z')
})

test('the top-level pending list carries cards and approvals; approvals bring reason but not detail', async (t) => {
  const host = await start(t, { config: { teamFeedReconcileMs: 20 } })
  host.rt.state.questions.b = { id: 'q1', question: 'Which?', options: [{ label: 'A' }], askedAt: 5 }
  const approvalListeners = host.ctx.listeners.get('approval/request') ?? []
  assert.equal(approvalListeners.length, 1)
  const waiting = approvalListeners[0]({
    agent: { session: { id: 'gb' } },
    toolName: 'bash',
    reason: 'x'.repeat(300),
    callId: 'call-1',
  }, () => {})
  const snap = host.rt.teamFeed.snapshot()
  const writer = bot(snap, 'b')
  assert.equal(writer.pending[0].kind, 'question')
  assert.equal(writer.pending[0].sessionId, 'b')
  assert.equal(writer.approvals.length, 1)
  assert.equal(writer.approvals[0].tool, 'bash')
  assert.equal(writer.approvals[0].reason.length, 200)
  assert.equal(writer.approvals[0].detail, undefined)
  const top = snap.pending.map(entry => entry.kind).sort()
  assert.deepEqual(top, ['approval', 'question'])
  // Settle the cache on what is on screen now, then change derived state that nothing
  // touches: the reconcile tick is the only thing that can find it.
  host.rt.teamFeed.touch()
  host.rt.teamFeed.flush()
  const frames = []
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  host.rt.state.questions.c = { id: 'q2', question: 'Also?', options: [{ label: 'A' }], askedAt: 6 }
  await sleep(80)
  assert.ok(frames.length >= 1)
  const patch = frames.flatMap(frame => frame.ops).filter(op => op.op === 'bot.patch' && op.id === 'c').at(-1)
  assert.ok(patch !== undefined)
  assert.equal(patch.set.pending[0].kind, 'question')
  host.rt.answerApproval(host.rt.approvalsView()[0].id, 'allow')
  await waiting
})

test('waiting hands over who a Bot waits for, and lastActivityAt is best effort', async (t) => {
  const host = await start(t)
  host.rt.state.works = {
    w1: { id: 'w1', from: 'a', to: 'b', open: ['w2'] },
    w2: { id: 'w2', from: 'b', to: 'c', open: [] },
  }
  host.rt.teamFeed.touch()
  await sleep(20)
  const snap = host.rt.teamFeed.snapshot()
  const writer = bot(snap, 'b')
  assert.deepEqual(writer.waiting, { bots: ['c'], rooms: [], for: ['a'] })
  host.emit('gb', 'user/message', { content: [], source: { kind: 'room' } })
  await sleep(500)
  const after = host.rt.teamFeed.snapshot()
  assert.equal(typeof bot(after, 'b').lastActivityAt, 'number')
})

test('two readers get the same frames, and an unsubscribed one gets none', async (t) => {
  const host = await start(t, { timers: true })
  const one = []
  const two = []
  const off = host.rt.teamFeed.subscribe(frame => one.push(frame))
  host.rt.teamFeed.subscribe(frame => two.push(frame))
  host.emit('gb', 'turn/start', { turn: 1 })
  t.mock.timers.tick(400)
  assert.deepEqual(one, two)
  const seq = host.rt.teamFeed.seq()
  off()
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(400)
  assert.equal(one.length, 1)
  assert.equal(two.length, 2)
  assert.ok(host.rt.teamFeed.seq() > seq)
})

test('a listener that throws does not stop the others', async (t) => {
  const host = await start(t, { timers: true })
  const frames = []
  host.rt.teamFeed.subscribe(() => { throw new Error('boom') })
  host.rt.teamFeed.subscribe(frame => frames.push(frame))
  host.emit('gb', 'turn/start', { turn: 1 })
  t.mock.timers.tick(400)
  assert.equal(frames.length, 1)
})
