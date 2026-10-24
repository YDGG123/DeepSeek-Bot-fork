// Team feed: the roster the mobile gateway reads (a cordis service, `dsBotTeam`).
//
// The gateway lives in the same host process, so this publishes plain objects: one
// `snapshot()` for everything, then `subscribe(listener)` frames with only what changed.
// Volatile fields (who works where, on which tool, which cards wait) are coalesced for
// 400 ms; structural changes are flushed at once. A 3 s reconcile re-reads the views and
// sends whatever a missed touch left behind, so a stale phone can never stay stale for
// long. Static fields travel only in a snapshot or an add/update, never in a patch.
//
// The contract is frozen in docs/roster-publish-v1.md (v2): `snapshot()` never consumes
// `seq`; `delta.base` is the seq of the last frame the reader applied; ordering for the
// team page is the gateway's own session `updatedAt`, not our best-effort lastActivityAt.
import { randomUUID } from 'node:crypto'
// 头像/颜色的**唯一事实源**：与电脑端同一个 `lookOf`（纯函数，无 DOM 依赖）。
// roster 下发前就把缺省的 shape / color 解析好，手机端只渲染、不推导 —— 否则
// 「同一个 Bot 在电脑端和手机端形状不同」会一直复现（QA 实测）。
import { lookOf } from '../client/characters.js'

const RECONCILE_MS = 3_000
const MAX_OPS = 200
const REASON_MAX = 200
// Events that change what the feed publishes. A token stream alone does not.
const WATCHED = new Set(['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const head = (text, max) => (text.length <= max ? text : text.slice(0, max))
const changed = (before, after) => [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  .filter(key => !same(before?.[key], after?.[key]))
  .map(key => [key, after?.[key]])

export function install(rt) {
  const { ctx, state } = rt
  // Tests shorten these; the contract is 400 ms coalescing and a 3 s safety net.
  const THROTTLE_MS = rt.config.teamFeedThrottleMs ?? 400
  const RECONCILE_EVERY_MS = rt.config.teamFeedReconcileMs ?? RECONCILE_MS
  const instanceId = randomUUID()
  const listeners = new Set()
  // What each reader has already been sent, by entity: Map<'bot:…'|'room:…', { static, volatile }>.
  const sent = new Map()
  let sentMain
  let seq = 0
  let pending = false
  let timer = null
  let timerAt = 0
  // Best effort: when this process last saw each Bot or group active. It starts over with
  // the process; the gateway's session `updatedAt` stays the authority for ordering.
  const activeAt = new Map()

  const schedule = (delay) => {
    const at = Date.now() + delay
    if (timer !== null && timerAt <= at) return
    if (timer !== null) clearTimeout(timer)
    timerAt = at
    timer = setTimeout(() => { timer = null; timerAt = 0; flush() }, delay)
    timer.unref?.()
  }

  const touchActivity = (sessionId) => {
    if (sessionId === undefined) return
    const at = Date.now()
    const owner = rt.groupOwners.get(sessionId)
    if (owner !== undefined) {
      activeAt.set(`bot:${owner.botId}`, at)
      activeAt.set(`room:${owner.roomId}`, at)
    }
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) activeAt.set(`bot:${chat}`, at)
    if (rt.roomOf(sessionId) !== undefined) activeAt.set(`room:${sessionId}`, at)
  }

  // Everything the feed publishes, read from the views the desktop already uses. No new
  // state is kept here: this is a projection, not a second source of truth.
  const readState = () => {
    const activity = rt.activityView()
    const work = rt.workView()
    const roomWork = rt.roomWorkView()
    const approvals = rt.approvalsView()
    const waiting = rt.waitingView?.() ?? {}
    const cards = state.roomCards ?? {}
    const pendingByBot = new Map()
    const addPending = (botId, entry) => {
      const list = pendingByBot.get(botId) ?? []
      list.push(entry)
      pendingByBot.set(botId, list)
    }
    const bots = Object.values(state.bots).map((bot) => {
      const chat = rt.chatOf(bot.id)
      const question = rt.own(state.questions, chat)
      if (question !== undefined) addPending(bot.id, { kind: 'question', sessionId: chat, at: question.askedAt })
      const view = rt.own(state.views, chat)
      if (view !== undefined) addPending(bot.id, { kind: 'view', sessionId: chat, at: view.askedAt })
      for (const request of state.secretRequests?.[bot.id] ?? []) {
        if (request.status === 'pending') addPending(bot.id, { kind: 'secret', sessionId: request.sessionId ?? chat, at: request.askedAt })
      }
      return { bot, chat }
    })
    for (const [roomId, list] of Object.entries(cards)) {
      if (!Array.isArray(list)) continue
      const room = rt.roomOf(roomId)
      for (const card of list) {
        if (rt.botOf(card.botId) === undefined) continue
        // A key card in a group is a mirror of `state.secretRequests`, which above is
        // already the authoritative source for the Bot dimension; counting the dock's
        // copy here too would list the same card twice. The room entity still carries it.
        if (card.kind === 'secret') continue
        addPending(card.botId, { kind: card.kind, roomId, ...(room?.sessions?.[card.botId] ? { sessionId: room.sessions[card.botId] } : {}), at: card.askedAt })
      }
    }

    const botEntities = new Map()
    for (const { bot, chat } of bots) {
      const doing = work[bot.id]
      // 存值优先，缺省按 bot id 稳定推导（契约 v2 起 shape/color 必定有值）。
      const look = lookOf(bot)
      const approvalLines = approvals.filter(entry => entry.botId === bot.id).map(entry => ({
        sessionId: entry.sessionId,
        ...(entry.roomId ? { roomId: entry.roomId } : {}),
        ...(entry.tool ? { tool: entry.tool } : {}),
        ...(entry.reason ? { reason: head(String(entry.reason), REASON_MAX) } : {}),
        at: entry.at,
        answerable: entry.answerable === true,
      }))
      const entity = {
        static: {
          id: bot.id,
          kind: 'bot',
          name: bot.name,
          role: bot.role ?? '',
          color: look.color,
          // 图片是可选的；shape 永远有值（读者不得再自行推导）。
          avatar: look.image ? { shape: look.shape, image: look.image } : { shape: look.shape },
          ...(bot.model ? { model: bot.model } : {}),
          ...(bot.effort ? { effort: bot.effort } : {}),
          ...(bot.workDir ? { workDir: bot.workDir } : {}),
          instructions: bot.instructions ?? '',
          main: rt.isMain(bot.id),
          pinned: bot.pinned === true,
          ...(bot.hidden === true ? { hidden: true } : {}),
          createdAt: bot.createdAt ?? 0,
          sessionId: chat,
          parts: (bot.segments ?? []).map(segment => segment.sessionId),
        },
        volatile: {
          activity: activity[bot.id] ?? 'idle',
          ...(doing === undefined ? {} : { work: doing }),
          approvals: approvalLines,
          pending: pendingByBot.get(bot.id) ?? [],
          waiting: waiting[bot.id] ?? { bots: [], rooms: [], for: [] },
          ...(activeAt.has(`bot:${bot.id}`) ? { lastActivityAt: activeAt.get(`bot:${bot.id}`) } : {}),
        },
      }
      botEntities.set(`bot:${bot.id}`, entity)
    }

    const roomEntities = new Map()
    for (const room of Object.values(state.rooms)) {
      const last = (room.log ?? []).filter(line => line.kind === undefined).at(-1)
      const roomCards = (Array.isArray(cards[room.id]) ? cards[room.id] : []).map(card => ({ kind: card.kind, botId: card.botId, at: card.askedAt }))
      roomEntities.set(`room:${room.id}`, {
        static: {
          id: room.id,
          kind: 'room',
          name: room.name,
          pinned: room.pinned === true,
          members: [...(room.members ?? [])],
          admin: room.admin ?? null,
          mode: room.mode ?? 'everyone',
          notice: room.notice ?? '',
          createdAt: room.createdAt ?? 0,
          ...(room.named === true ? { named: true } : {}),
        },
        volatile: {
          ...(roomWork[room.id] === undefined ? {} : { work: roomWork[room.id] }),
          ...(last === undefined ? {} : { preview: last.who === 'User' ? last.text : `${last.who}：${last.text}` }),
          ...(roomCards.length === 0 ? {} : { pending: roomCards }),
          ...(activeAt.has(`room:${room.id}`) ? { lastActivityAt: activeAt.get(`room:${room.id}`) } : {}),
        },
      })
    }

    // The cross-entity list the phone's badges read once: cards and approvals waiting.
    const pendingTop = []
    for (const [botId, list] of pendingByBot) {
      for (const entry of list) pendingTop.push({ botId, ...entry })
    }
    for (const entry of approvals) {
      pendingTop.push({
        kind: 'approval',
        botId: entry.botId,
        sessionId: entry.sessionId,
        ...(entry.roomId ? { roomId: entry.roomId } : {}),
        at: entry.at,
      })
    }
    pendingTop.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

    return { entities: new Map([...botEntities, ...roomEntities]), pending: pendingTop, mainBotIds: [...state.mainBotIds] }
  }

  const syncSent = (now) => {
    sent.clear()
    for (const [key, entity] of now.entities) sent.set(key, entity)
    sentMain = now.mainBotIds.join(',')
  }

  const frame = (ops) => {
    if (listeners.size === 0 || ops.length === 0) return
    // A frame this large is cheaper and safer as a fresh snapshot.
    if (ops.length > MAX_OPS) {
      const whole = snapshot()
      for (const listener of listeners) deliver(listener, whole)
      return
    }
    seq += 1
    const delta = { v: 1, kind: 'delta', instanceId, seq, base: seq - 1, at: Date.now(), ops }
    for (const listener of listeners) deliver(listener, delta)
  }

  const deliver = (listener, value) => {
    try {
      listener(value)
    } catch (error) {
      rt.warn?.('ds-bot: team feed subscriber failed: %s', error)
    }
  }

  const snapshot = () => {
    const now = readState()
    // Read-only: no frame, no seq. When nothing was waiting to be sent, the cache follows,
    // so the next delta only carries real changes; when a change is still pending, the
    // cache stays as it was and the next delta carries it to the readers that were here first.
    if (!pending) syncSent(now)
    return {
      v: 1,
      kind: 'snapshot',
      instanceId,
      seq,
      at: Date.now(),
      mainBotId: now.mainBotIds[0] ?? null,
      mainBotIds: now.mainBotIds,
      bots: [...now.entities].filter(([key]) => key.startsWith('bot:')).map(([, entity]) => ({ ...entity.static, ...entity.volatile })),
      rooms: [...now.entities].filter(([key]) => key.startsWith('room:')).map(([, entity]) => ({ ...entity.static, ...entity.volatile })),
      pending: now.pending,
    }
  }

  function flush() {
    if (!pending) return
    pending = false
    const now = readState()
    const adds = []
    const updates = []
    const patches = []
    const removes = []
    for (const [key, entity] of now.entities) {
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      const before = sent.get(key)
      if (before === undefined) {
        adds.push({ op: `${kind}.add`, id, set: { ...entity.static, ...entity.volatile } })
        continue
      }
      const staticChanged = changed(before.static, entity.static)
      const volatileChanged = changed(before.volatile, entity.volatile)
      if (staticChanged.length > 0) {
        // A structural change carries the whole entity's changed fields, static and volatile.
        updates.push({ op: `${kind}.update`, id, set: Object.fromEntries([...staticChanged, ...volatileChanged]) })
        continue
      }
      if (volatileChanged.length > 0) patches.push({ op: `${kind}.patch`, id, set: Object.fromEntries(volatileChanged) })
    }
    for (const key of sent.keys()) {
      if (now.entities.has(key)) continue
      const kind = key.slice(0, key.indexOf(':'))
      removes.push({ op: `${kind}.remove`, id: key.slice(key.indexOf(':') + 1) })
    }
    const ops = []
    const mainNow = now.mainBotIds.join(',')
    if (sentMain !== undefined && sentMain !== mainNow) ops.push({ op: 'main.set', mainBotIds: now.mainBotIds })
    ops.push(...adds, ...updates, ...patches, ...removes)
    syncSent(now)
    frame(ops)
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
    // Structural or state changes written to state.json: send at once.
    touch() {
      pending = true
      schedule(0)
    },
    // Live work (turns, tools, cards): coalesce.
    poke() {
      pending = true
      schedule(THROTTLE_MS)
    },
  }

  ctx.on('session/event', (session, event) => {
    if (!WATCHED.has(event?.type)) return
    touchActivity(session?.id)
    feed.poke()
  })
  ctx.on('agent/status', ({ agent } = {}) => {
    touchActivity(agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id)
    feed.poke()
  })
  // The safety net for derived fields (activity, approvals, waiting): a missed touch can
  // only leave the phone up to 3 s behind.
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (listeners.size === 0) return
      pending = true
      flush()
    }, RECONCILE_EVERY_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: team feed reconcile')

  Object.assign(rt, { teamFeed: feed })
  // The mobile gateway reads it as `ctx.get('dsBotTeam')`.
  ctx.provide?.('dsBotTeam', feed)
}
