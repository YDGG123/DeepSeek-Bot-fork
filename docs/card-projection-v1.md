# 卡片投影接口 v1（ds-bot → 移动网关 `dsBotCards`）

> 需求 10 来源②。状态：**已实现（2026-10-24），待 QA 验证；契约按网关 fbd080d 消费者冻结**。
> 日期：2026-10-24 · 分支 `feat/group-chat-cards`
> 对齐对象：网关仓库 `fbd080d` 的消费者 `lib/mobile-v1/card-frames.mjs`（`CARD_SERVICE_CONTRACT` 已写死形状）。本草案**按消费者已实现的归一化规则反向定义**，保证服务一到就能用，不再出现「消费者先写、服务后到」的占位态。

---

## 0. 结论

| 项 | 决定 |
|---|---|
| 服务名 | `dsBotCards`（网关 `lib/index.mjs:2994` `resolveCardService: () => optionalService(ctx, 'dsBotCards')` 写死） |
| 形态 | `ctx.provide('dsBotCards', rt.cardFeed)`；`{ v, instanceId, seq(), snapshot(): {seq, at, cards[]}, subscribe(fn) }` |
| 帧 | `v:1, kind:'card', seq, base?, at, ops[]`；op 只有 `card.shown` / `card.answered` / `card.cleared` |
| 静态/易变 | 卡片正文随 `card.shown` 一次给全（**无 update op**：内容变化就是新 id）；answered/cleared 只带 id |
| seq | `snapshot()` 不消耗 seq；每个 delta `seq+=1`，`base=seq-1`；消费者只接受 `seq > 自己 head` 的帧 |
| 节流 | 卡片是低频事件，**不做时间窗节流**；同一 tick 的多张卡合并成一帧 |
| 密钥 | **值永不下发**：secret 卡只有 `name` / `description` / `save` |

---

## 1. 服务形态（与消费者契约逐字一致）

```js
// ds-bot/index.js
export const provide = ['dsBotTeam', 'dsBotCards']
// src/host/card-feed.js 内
ctx.provide('dsBotCards', rt.cardFeed)
```

```ts
interface DsBotCards {
  readonly v: 1
  readonly instanceId: string          // 每次 host 进程启动生成
  seq(): number                         // 当前 head
  snapshot(): { seq: number, at: number, instanceId: string, cards: Card[] }
  subscribe(listener: (frame: CardFrame) => void): () => void
}
```

读者加入顺序（契约要求）：**先 `subscribe()`，再 `snapshot()`**；随后只应用 `seq > 本地 head` 的 delta。`snapshot.seq = head`，不增加 seq。

---

## 2. 帧

```json
{
  "v": 1,
  "kind": "card",
  "instanceId": "…",
  "seq": 7,
  "base": 6,
  "at": 1761264000000,
  "ops": [
    { "op": "card.shown", "id": "c1", "card": { } },
    { "op": "card.answered", "id": "c0" }
  ]
}
```

| op | 载荷 | 语义 |
|---|---|---|
| `card.shown` | `id` + `card` | 有卡出现（一次性给全正文） |
| `card.answered` | `id` | 用户已作答；卡从队列移除 |
| `card.cleared` | `id` | 卡消失但**没有答案**：跳过（skip）、群被删、成员被移出、Bot 被删 |

规则：
- 同一帧内同一 id 只出现一次；`shown` 之后不会有 `update`（内容变 = 新卡新 id）。
- `answered` / `cleared` 是终态，之后同 id 不再出现。
- 消费者会丢弃 `seq <= 本地 head` 的帧，因此每个 delta 的 seq 必须严格递增。

---

## 3. 卡片字段（按消费者 `normalizeCard` 对齐）

公共：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一、稳定 |
| `kind` | `"question"\|"view"\|"secret"` | 其它值消费者按 question 处理，不利用 |
| `at` | number | 出现时间（各卡的 `askedAt`） |
| `botId` | string | 提问的 Bot |
| `sessionId` | string | **作答时要用的目标 id**：own chat = Bot 当前对话；群内卡 = 群 id（即 `roomId`） |
| `roomId` | string? | 群内卡才有；消费者见到它就置 `group: true` |

> `sessionId` 是「答复目标」，不是隐藏群会话 id。隐藏会话 id 不下发——它内部使用、且换 part 会变。

### 3.1 question（`ask_user`）

```json
{
  "id": "c1", "kind": "question", "at": 1761264000000,
  "botId": "b1", "sessionId": "r1", "roomId": "r1",
  "questions": [{
    "id": "q1",
    "question": "用哪个库？",
    "multiple": false,
    "description": "可选的一行说明",
    "custom": true,
    "options": [{ "label": "A" }, { "label": "B", "description": "更快" }]
  }]
}
```

映射：`questions[]` 是数组（消费者协议如此），DS Bot 的单卡映射成一项；
`multiple` ← `multiSelect`、`custom` ← `allowCustom`、`description` ← `detail`；
**`label` 逐字保留**（答复时按 label 权威匹配，禁止 trim/改写/翻译）；
`approval` 不发（消费者默认 false）。

### 3.2 view（`show_view`）

```json
{
  "id": "c2", "kind": "view", "at": 1761264000000,
  "botId": "b1", "sessionId": "b1",
  "view": { "title": "选方案", "text": "Options: A / B" }
}
```

消费者只保留 `view.title` / `view.text` / `view.body`，其它字段一律丢弃。所以**只发 title + text**：
text 是蓝图的纯文本压平（`src/shared/views.js` 的节点），确定性规则：

- `text` 节点 → 原文
- `metric` → `label: value`
- `table` → 表头一行 + 每行 `值 | 值`
- `options` → `Options: A / B`
- `confirm` → 提示 + `[confirmLabel] [cancelLabel]`
- `form` → `Form: field1, field2`
- `progress` → `label percent%`
- `stack` → 子节点按顺序换行拼接
- 超过 2000 字截断并加 `…`

**v1 的 view 卡在手机上只读**（消费者不保留控件结构）。要可点需要消费者扩协议——建议下一版，见 §8。

### 3.3 secret（`request_secret`）

```json
{ "id": "c3", "kind": "secret", "at": 1761264000000, "botId": "b1", "sessionId": "b1",
  "secret": { "name": "GITHUB_TOKEN", "description": "发版用", "save": true } }
```

只有 `name` / `description`（← `purpose`）/ `save:true`；**值、scope、usage、请求状态一律不下发**。
本批只投影 own chat 的密钥卡（群内密钥卡第二批）。

---

## 4. 触发点（落码位置）

| 事件 | 现有代码位置 | 发什么 |
|---|---|---|
| 群内卡入队/出队 | `src/host/room-cards.js`（`addRoomCard` / `dropRoomCard` / `dropRoomCards`） | shown / answered / cleared |
| own chat 提问卡 | `tools.js` ask_user 写 `state.questions[chat]` | shown |
| own chat 展示卡 | `tools.js` show_view 写 `state.views[chat]` | shown |
| own chat 密钥卡 | `secrets.js` `state.secretRequests[botId]` pending 增加 | shown |
| 作答 | `channel.js` `answer-question` / `view-reply` / `secret-set`·`secret-allow` | answered |
| 跳过 / 清理 | `channel.js` `dismiss-*`、`roster.js` 删群/移出成员/删 Bot、`store.js` 迁移丢弃 | cleared |

实现方式：新增 `src/host/card-feed.js`，在以上位置调 `rt.cardFeed?.changed(id)` 之类的打点（未安装即 no-op），由 feed 重算 diff 发帧——与 team-feed 同一套思路，不另建状态。

---

## 5. 快照 / 增量边界

- `snapshot().cards` = 当前全部待答卡（own chat + 群内），按 `at` 升序、再按 id 排序（确定性）。
- 卡片正文只在 snapshot 与 `card.shown` 出现；answered/cleared 不带正文。
- 无卡片时 `cards: []`（网关会正常处理空快照）。
- 不发 roster 里已有的 `pending` 轻标记（那是类型+时间的角标数据，两条流各司其职）。

---

## 6. 答复路径（网关 → ds-bot，需网关侧新增动作）

手机端要把答案送回来，网关内部有一层 allowlist（`lib/mobile-v1/adapter.mjs` 的 `allowed`，**不接受手机端传任意 endpoint**）。建议新增三个内核动作（名字由网关定，只约定下游调用）：

| 动作 | 网关→`/api/bot` | 载荷 |
|---|---|---|
| 回答提问卡 | `answer-question` | `{ sessionId, questionId: card.id, answer: { selected: [label…], custom? } }` |
| 跳过提问卡 | `dismiss-question` | `{ sessionId, cardId: card.id }` |
| 提交密钥 | `secret-set` | `{ requestId: card.id, value, scope: 'bot' }`（值只走这条，绝不回传帧） |

> **`scope` 必填，默认 `'bot'`**：`secrets.js` 对「没有既有密钥」的请求，`body.scope` 缺省会按 `'all'` 落库，即**全团队可读**。手机端答密钥卡必须显式传 `'bot'`（只给提问的 Bot）；只有用户在手机上明确选择「全团队可用」时才传 `'all'`。这是安全默认值，不能由「没传」决定。

`sessionId` 一律用帧里的值：own chat 卡 = Bot 对话 id；群内卡 = 群 id（ds-bot 的群分支按 room id 解析，回答会回到提问者的隐藏群会话）。
view 卡 v1 不可答（§3.2），手机侧只展示。

失败码沿用 ds-bot 现有：`bot/stale`（已作答/已关闭）、`bot/invalid`（答案不合法）。

---

## 7. 断言点（落码时逐条测）

1. `snapshot()` 字段形状与消费者一致：`id/kind/at/botId/sessionId/roomId/questions[]/options[].label`，且 `snapshot` 不增加 seq。
2. 每个 delta `seq` 严格递增、`base = seq - 1`；消费者丢弃 `seq <= head` 的语义下不丢卡。
3. `card.shown` 正文一次给全；同 id 不再出现 update。
4. 作答 → `card.answered`，卡从下一次快照消失；跳过 → `card.cleared`。
5. 群内卡：`roomId` 存在、`sessionId === roomId`、消费者归一化后 `group === true`。
6. `label` 逐字保留（含空格/标点/中文），往返作答能命中。
7. secret 卡不含值字段（序列化后全文搜索不到密钥值）；只有 name/description/save。
8. view 卡压平确定：同一 blueprint 多次投影结果一致；只含 title/text。
9. 删群/移出成员/删 Bot → 对应卡 `cleared`。
10. 无订阅者时不组装帧、不占 seq。

---

## 8. 待网关侧确认

1. **view 卡是否要在手机上可答**：消费者当前只保留 `view.title/text/body`，控件结构全丢。v1 建议只读；要可点需扩消费者协议（例如保留 `blueprint` 原样），请网关侧拍。
2. **答复动作名与入参**（§6）：网关定义动作名，ds-bot 只提供上面三个 `/api/bot` 下游调用。
3. **`sessionId` 语义**按 §3 公共字段（答复目标 id）——与占位卡的 `sessionId` 一致，请确认。
4. 密钥卡的手机输入界面是否本批要（desktop 已有；手机端要新增安全输入页）。若本批不做，secret 卡只投影、手机不提供作答入口，等第二批与群内密钥卡一起。

---

## 9. 落地记录（2026-10-24）

### 消费者零改动

按 QA 的建议定死两条缝隙：**A. view 卡 v1 纯展示投影**（可交互控件回桌面答）；**B. 标题放 `view.title` 内**。
因此 `card-frames.mjs` 的 `normalizeCard` **一行不用改**：我们只发它保留的字段（question 的 `questions[]`、view 的 `title/text`、secret 的 `name/description/save`），控件结构不发。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/host/card-feed.js`（新增） | 收集 own chat 与群内卡 → 扁平数组；`card.shown/answered/cleared` 增量；蓝图层压平 `viewText`；`ctx.provide('dsBotCards', rt.cardFeed)` |
| `index.js` | `provide = ['dsBotTeam', 'dsBotCards']`；注册 card-feed（紧跟 team-feed，不注册监听器，不影响既有安装顺序断言） |
| `src/host/store.js` | `save()` 同时 `rt.cardFeed?.touch()` |
| `src/host/channel.js` | 作答成功（群内 / own chat）后 `rt.cardFeed?.answered(id)` |
| `src/host/secrets.js` | `secret-set`（requestId 分支）与 `secret-allow` 成功后备注 answered |
| `test/card-feed.test.js`（新增） | 10 个用例 |

### 自验（Node v22.20.0）

- `npm test`：865 用例 / 863 通过 / 2 跳过 / 0 失败
- `npm run lint`：0 错误、11 警告（与基线一致）
- `node scripts/build-client.mjs --check`：exit 0（本批未改客户端）
- 断言覆盖 §7 十条：快照形状与 seq、label 逐字、群卡 `sessionId=roomId` 且不泄漏隐藏会话、answered/cleared 区分、密钥值不出现、view 压平确定性、无订阅者不占 seq、删群清卡、去重不重复 shown。

### 已知边界

- view 卡在手机上只读；手机要能答 view 卡需网关 `normalizeCard` 保留控件结构（第二批）。
- 群内密钥卡不在本批（第二批）；own chat 密钥卡已投影，但手机端密钥输入界面未做。
