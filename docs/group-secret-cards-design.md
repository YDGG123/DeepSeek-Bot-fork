# 群内密钥卡设计（第二批）

> 需求 9 补充（密钥卡）+ 需求 10 来源②。状态：**设计推演，待 QA 复核后落码**。
> 日期：2026-10-24 · 分支 `feat/group-chat-cards`
> 体例照 `docs/group-cards-design.md`（第一批），本文只写**差异与新增**。

---

## 0. 一句话

群内 `request_secret` 复用第一批的「卡片按群索引 + 槽位等待 + 答案回投」骨架，但**值不进任何卡片/状态/帧**：
卡片只有 `name` / `purpose` / `requestKind`，用户输入的密钥只从输入框直接 POST 到 `secret-set`，
落盘在 `secrets.json`；后续 note 投回提问者的隐藏群会话，其任务继续。

---

## 1. 与第一批（ask_user / show_view）的差异

| 维度 | 第一批 | 密钥卡 |
|---|---|---|
| 卡片正文 | 问题/选项/蓝图，进 `state.roomCards` | 只有 `name` / `purpose` / `kind: 'allow'\|'fill'`；**值不出现** |
| 生命周期 | roomCards 是唯一真相 | `state.secretRequests[botId]` 是**生命周期真相**；`state.roomCards[roomId]` 放**同 id 的镜像**（仅供 dock 排序/渲染） |
| 落盘 | state.json | 值只进 `secrets.json`（600），request 记录只进 state.json |
| 作答通道 | `answer-question` / `view-reply` | `secret-set` / `secret-allow` / `secret-cancel`（`requestId` 全局可查） |
| 回投 note | 答案是卡片文本 | note 是**不含值**的一句话（已保存/已允许/已取消），投回隐藏群会话 |
| 默认 scope | 无 | 群里默认 **`'bot'`**（只给提问者）；用户在卡上明确选「全团队」才 `'all'` |
| 清理 | 删群/移人清卡 | 同上，且要**把 pending request 一并置 canceled**（否则 note 无处投） |

---

## 2. 数据模型

`state.roomCards[roomId]` 新增一种：

```js
{ id, kind: 'secret', botId, roomId, askedAt,
  name: 'GITHUB_TOKEN', purpose: '发版用', requestKind: 'fill' | 'allow' }
```

- **`id` 与 `state.secretRequests[botId][i].id` 相同**（单一身份，作答就是 `secret-set {requestId: id}`）。
- `state.secretRequests` 的 request 增加 `roomId`；`sessionId` 仍是提问时的隐藏群会话（内部用，不下发 UI/帧）。
- `kind: 'allow'` = 密钥已存在、只问「允许这个 Bot 用吗」；`'fill'` = 需要用户输入值。

不改 `secrets.json` 结构。

---

## 3. 工具：`request_secret` 群分支

现状（`secrets.js:400` 附近）：`if (rt.groupOwners.has(id)) return 'Secret cards only work in your own chat…'`。

改为：

1. `owner = rt.groupOwners.get(id)` 存在时走群分支：
   - 取 `room = rt.roomOf(owner.roomId)`；不在群里则退回错误提示。
   - 用户已可用该密钥 → 和 own chat 一样直接返回用法（不弹卡）。
   - 同 Bot 同名的 pending request **先置 canceled 并删其镜像卡**（沿用 own chat 的取代语义）。
   - 写 request：`{ id, kind: secret ? 'allow' : 'fill', status:'pending', roomId, sessionId: id, name, purpose, askedAt }`；
     `exec.callId` 不记（群里工具格隐藏，dock 才是落点）。
   - 写镜像卡进 `state.roomCards[roomId]`；`rt.save()`。
   - `rt.waitRoomTurn?.(id)` → 槽位 `waiting-answer`（同第一批）；`exec.concludeTurn?.()`。
   - 返回：`The key card is waiting in the group …`（提到其它成员照常推进、答案是 note）。
2. 非群路径不变。

---

## 4. note 回投（`tell` 的房间分支）

`secrets.js` 的 `tell(botId, text)` 目前投到 Bot 自己的对话（`role:'secret'`）。新增：

```js
const tell = async (botId, text, request) => {
  const room = request?.roomId === undefined ? undefined : rt.roomOf(request.roomId)
  if (room !== undefined) {
    // 与第一批同一条路径：hidden group session + role 'room' + roomId
    await rt.deliverRoomCardNote(room, { id: request.id, botId }, text, { note: 'secret card' })
    return
  }
  … 原逻辑（own chat，role 'secret'）
}
```

- 投递后 turn/end 走 `lateRoomReply → postToRoom`，所以成员在群里的后续发言**不需要重开一轮**（不关联不停）。
- `commit(notes)` 需要携带 request：把 notes 从 `[botId, text]` 扩成 `[botId, text, request]`。
- 所有会 settle 的路径都要把 note 投到**该 request 的房间**：`secret-set`、`secret-allow`、`secret-cancel`、`reconcile`（同一密钥被其它卡保存后，pending 的群卡也自动 settle）。

---

## 5. 作答与状态收口

### 5.1 `secret-set`（requestId 分支）

```js
const { botId, request } = pendingRequest(body.requestId)
const scope = body.scope === 'all' ? 'all' : [botId]     // 群里默认只给提问者
…写入 secrets（原逻辑）…
settle(botId, request, 'saved')
rt.dropRoomCard?.(request.roomId, request.id)            // 镜像卡出队
rt.appendRoomAnswer?.(room, `Key card answered: ${request.name}`)   // 不含值
rt.cardFeed?.answered(request.id)
commit(notes)                                             // note 投回隐藏群会话
```

失败回滚：`pendingRequest` 校验通过后先不改状态；`commit` 抛出时把 `request.status` 恢复 `'pending'`、删 `settledAt`、把镜像卡放回（`restoreRoomCard`），保证用户可重试且不会出现「卡没了但值没存」。

### 5.2 `secret-allow`

同 5.1 的收口（no scope 参数；`canUse` 判断后可加 bot scope），镜像卡出队 + `answered` + note。

### 5.3 `secret-cancel`

`settle(canceled)` → 镜像卡出队（`cleared`，不是 answered）→ note「用户取消了」投回隐藏群会话 → 提问者继续。

### 5.4 `reconcile`

同一密钥被另一张卡保存/删除时，`reconcile` 会 settle 其它 pending request。它对**群里**的 request 也要：
- 删除对应镜像卡；
- note 投到该 request 的隐藏群会话（而不是 own chat）。

实现：`reconcile` 的 notes 元素带 request，`commit` 统一按 request.roomId 分流。

### 5.5 清理

| 事件 | 处理 |
|---|---|
| 删群 | 群下所有 pending 的 secret request → `canceled`，镜像卡随 `dropRoomCards` 一起走 |
| 成员移出群 | 该成员在该群的 pending request → `canceled`；镜像卡删 |
| Bot 删除 | 已有 `forgetBotSecrets(botId)` 删 `state.secretRequests[botId]`；补：删它在各群的镜像卡 |
| `trimRequests` 逐出 | 逐出的是 settled 记录，镜像卡早已出不冲突 |

---

## 6. 客户端（桌面）

- `secret-card.js` 新增 `RoomSecretDock({ roomId, useRoster, actions })`：
  - 读 `roster.roomCards[roomId]`，`filter(kind === 'secret')`；队首 + 同款 chip（与问题/view dock 一致，状态里本就一条 FIFO，dock 只按 kind 过滤）。
  - 复用 `SecretCard`，但 `bot` 从 `roster.roomCards[roomId][i].botId` 取、`sessionId` 传 `roomId`、`request` 用镜像卡字段（name/purpose/requestKind/kind）。
  - `scope` 默认 `'bot'`（`Only {name}`），可切「All Bots」。
  - 提交走现有 `actions.secretSet({ requestId, value, scope })`；允许走 `secretAllow(requestId)`；取消走 `secretCancel(requestId)`。
  - **值只存在于组件 state 与一次 POST**；不写 localStorage、不进 roster 视图。
  - 30 分钟等待提示与第一批一致。
- `channel.js` 的 `view()` 已经把 `roomCards` 下发，镜像卡随之可见；`secrets` 视图不变。

---

## 7. 卡片投影（`dsBotCards`，手机）

- `card-feed.js` 的 secret 收集改为：
  - `request.roomId` 存在 → `roomId` + `sessionId = roomId`（作答目标），`group: true` 由消费者自动加；
  - `roomId` 不存在 → 现状（own chat）。
- 仍然只有 `{ name, description←purpose, save: true }`；**值、scope、requestKind 都不下发**（allow/fill 的区别在手机端只影响按钮文案，本批手机不提供密钥作答入口，见 §9）。
- 作答成功/取消/清理 → 复用 `cardFeed.answered(id)` / 默认 `cleared`。

---

## 8. 断言点（落码时逐条测）

1. 群内 `request_secret` 生成 request（带 `roomId`）+ 镜像卡（同 id、`kind:'secret'`），且**不写 `state.questions`**。
2. 槽位语义：群内问密钥卡 → `waiting-answer`，同轮其它成员照常发言，relay 的 `waitingAnswers` 含 `kind:'secret'`。
3. `secret-set`：值写进 `secrets.json`（内存 map），scope=`[botId]`；镜像卡出队；快照里该卡消失；note 投到**隐藏群会话**（role 'room'、roomId 正确）。
4. `secret-set` 失败（persist 抛错）→ request 仍 pending、镜像卡回位、可重试。
5. `secret-allow`、`secret-cancel` 各自的出队与 note 路径；取消是 `cleared` 不是 `answered`。
6. `reconcile`：同名密钥被另一张卡保存后，群里 pending 卡自动 settle、镜像卡消失、note 投到群会话。
7. 删群/移出成员/删 Bot → pending request 置 canceled、镜像卡消失。
8. **值不外泄**：`state.roomCards`、`roomCardsView()`、`cardFeed.snapshot()`、群日志答题行 JSON 序列化后都**搜不到密钥值**；群日志只有 `Key card answered: <NAME>`。
9. 卡片归属：镜像卡 `botId`/`roomId` 正确；手机投影 `sessionId===roomId`、`roomId` 存在。
10. 回归：own chat 密钥卡（`secrets.test.js`）、`card-feed` 既有 10 例、群卡片 13 例全绿。

---

## 9. 边界与待确认

1. **手机端密钥输入界面本批不做**：手机只投影密钥卡（name/description），不提供作答入口；作答在桌面。与第一批的 view 只读同口径。
2. **桌面群内 scope 默认 `'bot'`**：与手机契约 §6 的强制 `scope:'bot'` 一致；选「全团队」是显式动作。
3. 群内 `allow` 卡（密钥已存在、问授权）沿用 `secret-allow`，不改语义。
4. 值的最小长度/上限沿用 `MIN_VALUE=4` / `MAX_VALUE=16384`；群的 dock 不做额外限制。

## 10. 改动文件预估

| 文件 | 改动 |
|---|---|
| `src/host/secrets.js` | 群分支写卡；`tell` 房间分流；`commit` 带 request；`secret-set/allow/cancel/reconcile` 收口与回滚；清理钩子 |
| `src/host/room-cards.js` | 支持 `kind:'secret'` 的进入/去重（按 id 与 name+kind）/清理；镜像卡不受 question/view 的 payload 去重影响 |
| `src/host/store.js` | 迁移时保留 `kind:'secret'` 的镜像卡（当前只允许 question/view，需放宽） |
| `src/host/roster.js` | 删群/移人/删 Bot 时取消对应 pending request |
| `src/host/card-feed.js` | secret 卡的 roomId/sessionId 映射 |
| `src/client/secret-card.js` | `RoomSecretDock` + scope 默认 bot |
| `src/client/index.js` 或 dock 挂载处 | 群会话渲染 RoomSecretDock（与问题/view dock 并列） |
| `client.js` | `npm run build` |
| `test/group-secret-cards.test.js`（新增） | §8 的 10 条 |

> 注：`state.roomCards` 迁移当前在 `store.js` 里只接受 `question|view`；落码时放宽到 `secret`，并保持旧 state 兼容。
