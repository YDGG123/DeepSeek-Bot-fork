# 团队名册发布接口 v1（ds-bot → 移动网关）

> 需求 8（甲方案前提）。状态：**设计稿，等网关侧对齐后落地**。
> 日期：2026-10-24 · 分支 `feat/group-chat-cards`
> 依据：`docs/group-chat-cards-recon.md`、`dsh-mobile/Docs/bot-team-rework-plan.md` 第四节（快照+增量+节流+静态缓存）

## 修订记录

| 日期 | 变更 |
|---|---|
| 2026-10-24 v1 | 初稿 |
| 2026-10-24 v2 | 按 QA 设计复核收敛 P1–P4：① `lastActivityAt` 降级为 best-effort、排序权威改用会话 `updatedAt`；② 明确 `snapshot()` 不消耗 seq；③ approvals 补 `reason`（不传 `detail`）；④ 增加 3 s 低频 reconcile 兜底。另补 `work.note`、`waiting.for`、`mainBotId ≡ mainBotIds[0]`、重启重传头像的说明 |

---

## 0. 结论

| 项 | 决定 |
|---|---|
| 载体 | 同进程 cordis 服务 `dsBotTeam`（`ctx.provide(name, value)`，签名已在 dev/harness 的 cordis 核实）；网关用 `ctx.get('dsBotTeam')` 读取（网关已有 `optionalService()` 先例）。备选：同帧走 `ctx.emit('ds-bot/team')` |
| 形态 | `snapshot()` 全量 + `subscribe(fn)` 增量；增量 400 ms 合并节流；另加 3 s 低频 reconcile 兜底 |
| 对齐 | 单调 `seq` + `instanceId`；**`snapshot()` 不消耗 seq**（只读当前 head）；seq 断层或实例变更 → 重新取快照，不做事件回放 |
| 静态/易变 | 静态字段只出现在快照与结构变更帧；增量帧只带易变字段 |
| 未读 | **不由 ds-bot 提供**（读态是 DSH 客户端本地状态，不是 host 真相）→ 手机用会话 `updatedAt` + 本地已读水位推导 |
| 排序 | ds-bot 不排序。权威排序字段是网关已有的 DSH session list `updatedAt`（与桌面 `sidebar.js:255-268` 同源），roster 的 `lastActivityAt` 只是 best-effort 补充 |
| 卡片内容 | roster 只给「有一张卡在等」的轻标记；问题文本/选项走任务 3 的独立卡片帧，不重复传输 |

---

## 1. 服务形态

```js
// ds-bot/index.js
export const provide = ['dsBotTeam']
// apply 内（install 完成后，state 已就绪）
ctx.provide('dsBotTeam', rt.teamFeed)
```

```ts
interface DsBotTeam {
  readonly v: 1
  readonly instanceId: string     // 每次 host 进程启动生成的随机 id（不是持久 id）
  seq(): number
  snapshot(): TeamSnapshot        // 纯读，不触发节流，可随时调用
  subscribe(listener: (frame: TeamFrame) => void): () => void  // 返回退订
  flush(): void                   // 立即冲刷待发增量（网关转发前可选调用）
}
```

- **顺序问题**：网关用 cordis `inject: ['dsBotTeam']`（或子插件 `ctx.inject([...])`），不要假设 apply 顺序。
- **备选**：若网关侧不愿意持有服务，ds-bot 把**同一帧**同时 `ctx.emit('ds-bot/team', frame)`；内容逐字节一致，二选一即可，不要求都实现。
- `snapshot()` / 帧内容出自 `rt` 的既有视图函数（`activityView` / `workView` / `roomWorkView` / `approvalsView` / `waitingView` / `state.questions` / `state.views` / `state.secretRequests`），不另建一份状态。

---

## 2. 帧信封

### 2.1 snapshot

```json
{
  "v": 1,
  "kind": "snapshot",
  "instanceId": "3f9c…",
  "seq": 42,
  "at": 1761264000000,
  "mainBotId": "b1",
  "mainBotIds": ["b1"],
  "bots": [],
  "rooms": [],
  "pending": []
}
```

### 2.2 delta

```json
{
  "v": 1,
  "kind": "delta",
  "instanceId": "3f9c…",
  "seq": 43,
  "base": 42,
  "at": 1761264000400,
  "ops": [
    { "op": "bot.patch", "id": "b1", "set": { "activity": "working", "work": { "roomId": "r1", "tool": "bash", "target": "npm test", "since": 1761264000123 } } }
  ]
}
```

### 2.3 op 类型

| op | 载荷 | 语义 |
|---|---|---|
| `bot.add` / `room.add` | `id` + 完整实体 | 新实体（含静态字段） |
| `bot.update` / `room.update` | `id` + 变化字段（可含静态） | 结构变更：改名、改角色、换成员、置顶等 |
| `bot.patch` / `room.patch` | `id` + 仅易变字段 | 高频变化 |
| `bot.remove` / `room.remove` | `id` | 删除 |
| `main.set` | `mainBotIds[]` | 主 Bot 变化 |

规则：
- `add/update` 是**完整对象或完整字段集**，订阅端直接覆盖；
- `patch` 是**绝对值**（不是 diff），合并安全；
- 一帧内同一 id 只出现一次（服务端已合并）。

### 2.4 snapshot 与 seq 的关系（P2 已钉死）

- `snapshot()` **纯读、无副作用、不消耗 seq**：`snapshot.seq = head`（当前最新帧的 seq）。
- 两台手机先后取快照互不影响：后取的只是拿到同一个 head 的最新全量。
- `delta.base` 必须等于订阅端已应用的最后一条帧的 seq（snapshot 或 delta 都算）；不等于就重取快照。
- 这样「先订阅、再取快照」与「先取快照、再订阅」都能收敛：订阅后收到的第一帧若 base 不匹配会触发一次快照，允许这一次额外同步。

---

## 3. 字段清单

### 3.1 Bot — 静态（只进 snapshot / add / update）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Session id（桌面端 Bot 唯一身份） |
| `kind` | `"bot"` | 混排用 |
| `name` | string | |
| `role` | string | 角色标签 |
| `color` | string? | ds-bot 调色板 key（`COLORS`/`EXTRA_COLORS`），手机端需同名映射 |
| `avatar` | string? | data URL 或本地路径，**可能较大，只在快照里出现一次** |
| `model` | string? | `provider/model` |
| `effort` | string? | 思考等级 |
| `workDir` | string? | 工作目录（详情页） |
| `instructions` | string | 详情页展示；静态 |
| `main` | boolean | 是否主 Bot |
| `pinned` | boolean | 置顶 |
| `hidden` | boolean? | 桌面端隐藏标记 |
| `createdAt` | number | |
| `sessionId` | string | 当前 own-chat part |
| `parts` | string[] | 历史分段（用量/详情用；手机不一定要展示） |

### 3.2 Bot — 易变（snapshot 里也带当前值，之后只进 patch）

| 字段 | 类型 | 来源 |
|---|---|---|
| `activity` | `"idle"\|"thinking"\|"working"\|"waiting"\|"alert"` | `activityView()`（alert = 有审批等待） |
| `work` | `{ roomId?, tool?, target?, said?, note?, since, switching?, speaking? }` | `workView()` + `doingOf()`；**`note` = 工具自述（`description`，截 120 字，turns.js:278），比 `said` 更适合手机一行显示** |
| `approvals` | `[{ sessionId, tool?, reason?, at, answerable }]` | `approvalsView()` 过滤 botId；**`reason` 截 200 字**（`detail` 可能含代码文本，**不传**） |
| `pending` | `[{ kind: "question"\|"view"\|"secret", sessionId, roomId?, at }]` | `state.questions` / `state.views` / `state.secretRequests`（**只给类型与时间，不给内容**） |
| `waiting` | `{ bots: string[], rooms: string[], for: string[] }` | `waitingView()`（`for` = 为谁在等；三个键都传，手机可选择只显示两键） |
| `lastActivityAt` | number? | **best-effort**：team-feed 在 `session/event` / `agent/status` 观察点打 `Date.now()`，进程重启后从头积累，因此可为空。**不作为排序权威**（排序用网关的会话 `updatedAt`） |

### 3.3 Room

静态：`id`、`kind: "room"`、`name`、`pinned`、`members: string[]`（bot id）、`admin: string|null`、`mode: "admin"|"everyone"`、`notice`、`createdAt`、`named?`

易变：
| 字段 | 类型 | 说明 |
|---|---|---|
| `work` | `[{ botId, tool?, target?, note?, since, speaking?, switching? }]` | `roomWorkView()`；`speaking` = 当前轮发言者 |
| `preview` | string? | 群日志最后一条（与桌面 `channel.js:view()` 一致） |
| `lastActivityAt` | number? | best-effort，同 Bot（日志行只有单调 seq，没有时间戳，只能靠观察点打点） |
| `pending` | 同 Bot | 任务 2 上线后群内卡片归到这里 |

### 3.4 顶层 `pending`（跨实体汇总，给手机角标一次拿全）

`[{ kind, botId, sessionId, roomId?, at }]`
- 用于「等你回答 / 等你审批」红点，不用于渲染卡片。
- 卡片正文、选项、表单 → 任务 3 的 `card` 帧。

### 3.5 不在 v1 内

- DSH `agents`（Agent 行）：手机团队页先不展示；字段名预留，后续可加。
- 密钥名/值、exchange 日志、群成员隐藏会话 id（`parts` 里的 `room.sessions`）、群 log 全文。

---

## 4. 快照与增量的边界

| 类别 | 内容 | 何时发 |
|---|---|---|
| 静态 | name/role/color/avatar/model/effort/workDir/instructions/createdAt/pinned/main/sessionId/parts；room 的 members/admin/mode/notice | 只在 `snapshot`、`add`、`update`（改名等结构变更） |
| 结构变更 | Bot 增删、Room 增删、改名、换成员/管理员、置顶、换主 Bot | **立即发**，不节流，并先冲刷待发 patch（保证顺序） |
| 易变 | activity/work/approvals/pending/waiting/lastActivityAt；room 的 work/preview/lastActivityAt | 只进 `patch`，400 ms 合并 |
| 兜底 | 高频派生字段（activity 由 approvalsView/waitingView 派生，漏打点就会陈旧） | **3 s 低频 reconcile**：全量重算易变字段指纹，发现差异补发 patch；**仅有订阅者时跑** |
| 超大帧 | 单帧 `ops > 200` | 改发 `snapshot`（防御） |

体积预估：20 Bot + 10 群快照约 2–6 KB（头像占大头，仅一次）；单条 patch 100–300 B；10 Bot 每秒各变 2 次约 4 KB/s，符合方案第四节。

> **身份字段口径**：`mainBotId ≡ mainBotIds[0] ?? null`，两处必须同源（与 `channel.js:view()` 一致），不单独维护。
> **头像**：`avatar` 是 data URL，只在快照里传；host 重启后 `instanceId` 变化、旧 seq 失效、必然重取快照，等于重新传一次——这个代价可接受，不做增量头像。

---

## 5. 节流与合并（不丢状态的三条保证）

1. **合并窗口**：第一次变脏起 400 ms 定时器，到期冲刷；窗口内同一实体只留一份，字段 last-write-wins。
2. **绝对值语义**：patch 带的是当前完整值，所以中间态被合并掉也不会错；订阅端无需回放。
3. **结构优先**：`add/update/remove` 到来时先立刻冲刷待发 patch，再发结构帧，避免「先 patch 后 add」。

边界：`flush()` 可被网关调用（例如转发前对齐），不影响正确性。

**低频 reconcile（P4 的保险丝）**：`activity` 是派生值（`alert` ← approvalsView、`waiting` ← waitingView），
散布在 turns/approvals/handoffs 多处，静态无法证明 touch 点完备。因此 team-feed 每 3 s（仅有订阅者时）
重算一遍易变字段指纹并比对，任何差异按 patch 补发。代价：一次全量遍历（O(bots+rooms)，毫秒级），
换来「漏打点最多陈旧 3 s，不会永久陈旧」。

---

## 6. seq / 重连 / 多端

- `snapshot` 与 `delta` 共用一条递增 `seq`（进程内计数器，从 1 开始）；`snapshot()` 不消耗它（见 §2.4）。
- 订阅端规则：收到 `delta` 时若 `base !== 本地 seq` 或 `instanceId` 变化 → 丢弃，重新 `snapshot()`。
- 无事件回放缓冲：重连 = 重新快照（方案第四节：重连发快照对齐，不做事件回放）。
- 多个手机同时订阅：各端独立持有 seq，服务端只在有订阅者时才组装帧（无订阅者不发）。

---

## 7. 数据变更的触发点（落地位置）

| 变化 | 触发位置（当前行号） |
|---|---|
| Bot 新建 / 改名 / 角色 / 头像 / 置顶 | `src/host/roster.js:117`（buildBot）、`282`（setFlags）、`232`（updateBot 名字校验后） |
| Bot 删除 | `src/host/roster.js:163`、`539`（deleteBot 级联） |
| 主 Bot 变更 | `src/host/roster.js:504-525` |
| 群新建 / 删除 / 设置 | `src/host/roster.js:344`（buildRoom）、`373`（removeRoom）、`src/host/groups.js` 群设置段 |
| 群日志 / 最近活动 | `src/host/groups.js:281`（room.seen / seq 推进）、`appendRoom` 写 log |
| 干活中（工具、在哪个群、发言者） | `src/host/turns.js:284`（workView）、`308`（roomWorkView）；源事件 `ctx.on('agent/status')`、`ctx.on('session/event')` |
| 审批等待 | `src/host/approvals.js:15`（approval/request 网关）、`50`（approvalsView） |
| 提问卡 / 展示卡挂起与答复 | `src/host/tools.js:604`（ask_user）、`651`（show_view）；`src/host/channel.js` 的 answer-question / view-reply |
| 密钥卡 | `src/host/secrets.js:179`（state.secretRequests） |
| 交付等待 | `src/host/handoffs.js:120`（waitingView） |
| 兜底 | `src/host/store.js` `save()` / `revision++`：结构变更后重算一次实体指纹，发现差异按 patch 发 |

实现上新增一个模块 `src/host/team-feed.js`（`install(rt)`），只做「读既有视图 → 组帧 → 节流 → 分发」，不改上述文件的既有语义；各触发点通过一个 `rt.teamFeed?.touchBot(id, fields)` / `touchRoom(id, fields)` / `structureChanged()` 打点，未安装时是 no-op。

---

## 8. 与任务 2 / 任务 3 的关系

- **任务 2（群卡片）**：卡片归属索引上线后，`pending` 增加 `roomId`，并挂到对应 room 条目；群里多张卡按 `at` 定序。
- **任务 3（卡片投影）**：另立服务 `dsBotCards` + `card` 帧（`card-shown` / `card-answered` / `card-cleared`），不复用 roster 帧，避免大对象混入每秒变化的状态流。

---

## 9. 网关侧对齐点（已按 QA 复核更新）

1. **接入方式**：建议主走 `ctx.get('dsBotTeam')`（网关已有 `optionalService()`，侵入最小、免 inject 顺序问题）；`inject: ['dsBotTeam']` 与 `ctx.emit` 留备选。最终由网关侧拍。
2. **未读**：ds-bot 不提供。手机用会话 `updatedAt` + 本地已读水位推导；roster 的 `lastActivityAt` 只是 best-effort 补充。
3. **排序**：ds-bot 不排序。手机上按 `pinned` 再按**网关已有会话 `updatedAt`**（与桌面同源）；`lastActivityAt` 不可作权威（重启归零）。
4. **颜色**：`color` 是调色板 key（`COLORS`/`EXTRA_COLORS`，见 `src/host/constants.js`），**不是 hex**。手机 `TeamView.swift:364` 现在按 hex 解析，必须由网关/手机侧配 key→色值表，否则颜色直接坏——这是硬依赖，不能省。
5. **agents 行**：本轮不进 v1（手机团队页先不显示），字段名预留。
6. **重启代价**：`instanceId` 变化即要求全量重取（含头像 data URL），属于设计接受的行为，网关侧不要做跨重启的缓存命中假设。
