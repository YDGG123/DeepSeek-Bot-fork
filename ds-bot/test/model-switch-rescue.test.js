import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A model switch has to bring the history below the destination model's threshold
// first: compaction-basic prices the proposed header and condenses through
// compactRegion. For a Bot Session that condensation is DS Bot's own job and the
// wrapper refuses it, so the switch fails whole — and keeps failing, because a
// failed request never commits its route, so every later request re-proposes the
// switch. The user's message had already left the inbox for the step, so the turn
// dies with the input only in the session log. The rescue moves the part on the way
// an overflow does: a fresh part is small, so the picked model serves its first
// request without a switch check, and the stopped turn goes on there, with the
// user's message carried in the latest messages.

// A Bot in a group room, as the reported failure had it: the room session 'gb' is
// Writer's part in "Ops".
function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-switch-model-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  // What each Session logged, oldest first. Input the loop spliced from the inbox
  // lives here only, which is where a handoff reads it from.
  const logs = new Map()
  const seqs = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: {
          id: sessionId,
          // The route the part last served; a fresh part falls back to it when the
          // Bot has no model of its own.
          requestHeader: () => ({ config: { provider: 'loomy', model: 'DeepSeek-V4.1-Flash', maxTokens: 8192 } }),
          // The next seq the Session would write; reading the log goes through it.
          get seq() { return (seqs.get(sessionId) ?? 0) + 1 },
          deriveMessages: () => [],
        },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  const archived = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ context: { contextWindow: 65_536 }, defaultMaxTokens: 8192 }),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      // The stored events of one page, oldest first; the handoff reads them backwards.
      page: async (query) => {
        const all = logs.get(query.address.sessionId) ?? []
        const kept = all.filter(event => event.seq <= (query.throughSeq ?? Number.POSITIVE_INFINITY)
          && (query.beforeSeq === undefined || event.seq < query.beforeSeq))
        const start = Math.max(0, kept.length - query.maxMessages)
        return { records: kept.slice(start).map(event => ({ event })), hasMore: start > 0 }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  apply(ctx, { home })
  const emit = (id, type, data) => {
    const seq = (seqs.get(id) ?? 0) + 1
    seqs.set(id, seq)
    const event = { type, seq, data, time: Date.now() }
    logs.set(id, [...(logs.get(id) ?? []), event])
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, event)
    }
  }
  // Runs the waterfall the way the loop does: each listener's next() goes to the one
  // after it, and undefined from the last settles the chain.
  const fire = (name, payload) => {
    const listeners = [...(ctx.listeners.get(name) ?? [])]
    const run = index => index >= listeners.length
      ? Promise.resolve(undefined)
      : listeners[index](payload, () => run(index + 1))
    return run(0)
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes the request-error handlers filter by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, fire, archived, logs, state, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')
const settled = async check => { for (let count = 0; count < 400 && !check(); count += 1) await delay(5) }

test('a model switch the compaction wrapper refuses moves the part on with the user\'s message', async t => {
  const { agents, agentOf, emit, fire, archived, logs, state, stop } = await start(team())
  t.after(stop)

  // The group turn: the user's message left the inbox for the step (the loop splices
  // it before the request), so only the session log holds it. The request then failed
  // whole: switching to the picked model needs the history condensed first, and the
  // wrapper refuses to condense a Bot Session.
  const bot = agentOf('gb')
  emit('gb', 'turn/start', { turn: 40218 })
  emit('gb', 'user/message', { content: [{ type: 'text', text: 'GitHub README 要自己重写' }], source: { kind: 'user' } })
  assert.deepEqual([...bot.inbox.nextStep, ...bot.inbox.nextTurn], [])
  await fire('agent/request-error', {
    agent: bot,
    failure: {
      code: 'MODEL_SWITCH_COMPACTION_FAILED',
      message: 'Cannot switch to magpie/group/auto-glm-5-3-flash: context compaction failed: A Bot conversation makes room on its own, and read_own_chat searches all of it.. The previous request model is preserved; retry or select a model with a larger context window.',
    },
    signal: AbortSignal.timeout(60_000),
  })
  emit('gb', 'turn/end', { turn: 40218, reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED' } } })

  // The part moved on: the fresh part of the room opens with the handoff package,
  // the user's message travels in the latest messages, and the package tells the Bot
  // the stopped turn goes on — no resend asked for, no failure notice.
  const handoffOf = () => agents.get('s1')?.calls.find(([, message]) => message.source?.handoff === true)?.[1]
  await settled(() => handoffOf() !== undefined)
  const handoff = handoffOf()
  assert.ok(handoff !== undefined, 'the part did not move on: the fresh part got no handoff')
  assert.equal(handoff.source.resume, true)
  assert.equal(agents.get('s1').calls[0][0], 'followup')
  assert.match(textOf(handoff.content), /User: GitHub README 要自己重写/)
  assert.match(textOf(handoff.content), /You were in the middle of your turn in the group/)

  // The fresh part is the Bot's session in the room now; the old one is archived as
  // an earlier part, and no switch is left marked.
  assert.equal(state().rooms.r1.sessions.b, 's1')
  assert.equal(state().rooms.r1.segments.b.at(-1).sessionId, 'gb')
  assert.deepEqual(archived, [['gb', { stopActivity: true }]])
  // The mark the switch held goes out with its last state write.
  await settled(() => Object.keys(state().switching).length === 0)
  assert.deepEqual(state().switching, {})

  // The fresh part's first turn is the resumed one: it takes the handoff as turn 1
  // and answers the carried message there.
  emit('s1', 'turn/start', { turn: 1 })
  emit('s1', 'user/message', { content: handoff.content, source: handoff.source })
  emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '好，README 我来重写' }] } })
  emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.ok((logs.get('s1') ?? []).some(event => event.type === 'assistant/message'))
})

test('only the model-switch failure moves the part on', async t => {
  const { agents, agentOf, emit, fire, state, stop } = await start(team())
  t.after(stop)

  emit('gb', 'turn/start', { turn: 1 })
  emit('gb', 'user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await fire('agent/request-error', {
    agent: agentOf('gb'),
    failure: { code: 'RATE_LIMITED', message: 'provider busy' },
    signal: AbortSignal.timeout(60_000),
  })
  await delay(50)
  assert.equal(agents.get('s1'), undefined)
  assert.equal(state().rooms.r1.sessions.b, 'gb')
})
