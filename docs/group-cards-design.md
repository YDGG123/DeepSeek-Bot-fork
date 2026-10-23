# 群聊卡片设计（任务 2，六环节落地）

> 需求 9。状态：**设计已通过复核，Chief 已拍板，正在落码**。
> 日期：2026-10-24 · 分支 `feat/group-chat-cards`
> 依据：`docs/group-chat-cards-recon.md`（现状与行号）、`bot-team-rework-plan.md` 决议 5（**关联任务暂停、不关联不停**）

## Chief 拍板（2026-10-24，权威）

| # | 决议 | 落地含义 |
|---|---|---|
| 1 | **普通消息不自动跳卡**（方案 C） | 普通群消息照常进群，挂起卡保留；dock 显式「跳过」按钮；挂满 30 分钟显示提示；**跳过必须给提问者投 followup 提示，不许静默清槽** |
| 2 | **dock 队首 + chip** | v1 只渲染队首卡 + "还有 N 张" chip；chip 可轮换、可任答；不做全部展开 |
| 3 | **密钥卡排第二批** | 本次不做群内密钥卡（secret-card / secrets.js 群分支延后），不阻塞任务 2/3 |
| 4 | **网关接入方式定死** | ds-bot 只 `ctx.provide('dsBotTeam', rt.teamFeed)`，网关 `ctx.get('dsBotTeam')` 读；`inject` 与 `ctx.emit` 都不做。帧形态按 `roster-publish-v1.md` §1/§2 冻结 |
| 5 | **本次开工范围** | host 侧一次做全 + client dock chip/跳过；改了 `src/client` 必须 `npm run build`；密钥卡不进本次 |

---

## 0. 一句话结论

群卡片能落地，且**不需要让工具调用阻塞**：`ask_user` 照旧 `concludeTurn()` 结束提问者这一轮，
但把「这一轮在群里还没说完」记在 round 槽位上（`waiting-answer`），把卡片记进 `roomId → 队列`。
用户作答后，答案以 `REPLY_KIND + role:'room'` 投回**提问者的隐藏群会话**，该会话开新一轮继续说，
其输出走既有 `lateRoomReply → postToRoom` 落回群日志——**不重开整轮，也不叫醒不相关的成员**。

「暂停」精确含义（写进实现注释）：
- **暂停的是「该成员在群里这一轮的那次发言/任务」**，不是 Session、不是整轮 relay；
- 提问者的 turn 已结束（DSH 工具语义不允许跨轮挂起），因此"挂起"= 卡片排队 + 槽位留 `waiting-answer`；
- 其它成员的槽位照常推进（不关联不停）；
- 用户作答（或跳过）后，该成员**新开一个 turn** 继续，产出按"迟到发言"进群日志。

---

## 1. 为什么不能让工具阻塞等答案（备选方案对比）

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 工具内 await 等答案 | `ask_user` 不 conclude，挂 promise 直到用户作答 | **否决**：成员 Session 长时间 running，后续轮次/它自己的其它活全被挡住；DSH 工具超时与 relay 超时（`ROOM_REPLY_TIMEOUT_MS=240s`）都会误伤；违反"不关联不停" |
| B. conclude + 卡片队列 + 答案 followup（**采用**） | 现状基础上加归属索引与回投 | 与 DSH 语义一致；提问者只丢当前 turn，答案到达后新 turn 继续；其它成员完全不受影响 |

---

## 2. 六环节逐项设计

### 环节 1 · 卡片归属索引（host 写卡处）

新增状态（`store.js` 初始化 + 迁移，缺失即 `{}`）：

```js
state.roomCards = {
  [roomId]: [
    { id, kind: 'question'|'view'|'secret', botId, roomId, askedAt,
      payload,            // ask_user 的参数 / show_view 的 view / 密钥卡字段
      sessionId?          // 只是当时快照，作答时以 room.sessions[botId] 为准
    }
  ]
}
```

要点：
- **不**写进 `state.questions` / `state.views`（那两个是 own-chat 语义，键是 Session；混用会让隐藏群会话的卡片跑到桌面 dock 上）。
- 密钥卡复用 `state.secretRequests[botId]`（`findRequest` 全局可查），只加 `roomId` 字段，不另建队列——避免请求生命周期两套。
- 入队处：`tools.js` ask_user（当前 `:589` 守卫处）、show_view（`:637`）、`secrets.js` `request_secret`（`:400`）。
- **不自动取代旧卡（R4）**：提问者挂卡期间被 @ 关联后可能合法地再问一张，两张都该保留、FIFO 分别作答。只对 `payload` 完全相同（同问题同选项）做去重，避免重复点击造成两条一样的问题。

### 环节 2 · 客户端反查（dock 读哪个键）

- `channel.js` 的 `view()` 增加 `roomCards: state.roomCards`（与 `questions`/`views` 并列，客户端只读）。
- `src/client/questions.js` `QuestionDock`：`sessionId` 是 room 时，读 `roster.roomCards?.[sessionId]`，取队首。
- `src/client/widget-cell.js` 的 `WidgetDock`、`secret-card.js` 的 `SecretDock` 同款分支（SecretDock 现在按 `roster.byId[bot.id]` 找，room 里是 undefined，直接不渲染）。
- **定序**：FIFO（`askedAt` 升序，同毫秒按 `botId`）。桌面 dock 只渲染队首 + 一枚 "还有 N 张等待" chip；
  点 chip 轮换查看，可作答任意一张（作答后自动出队）。这样不会把输入框顶太高，也避免多卡同时展开导致的误点。
- 队首卡的 `sessionId` 属性替换成 `roomId`，作答请求体带 `{ sessionId: roomId, cardId, kind }`。

### 环节 3 · 答案回投（channel.js）

`answer-question` / `view-reply` 增加 room 分支：

```
body.sessionId 是 room id
  → 在 state.roomCards[roomId] 里找 cardId（先认领：标记 answered，防二次作答）
  → 目标会话 = room.sessions[card.botId]（作答时刻解析，天然容忍换 part / Session 重置）
  → agent.followup(createUserMessage({
       content: [{ type:'text', text: reply.text }],
       source: { kind: REPLY_KIND, callId, outcome: 'answered', role: 'room', roomId, exchangeId: randomUUID() }
     }))
```

为什么 `source` 要同时带 `REPLY_KIND` 和 `role:'room'`：
- `REPLY_KIND` → `parts.historyEntry` 把它还原成「回答卡片的文本」，成员上下文可读；
- `role:'room'` → `turns/end` 走群成员分支（`turns.js:598-608`），没有 roomWaiter 时由 `lateRoomReply` 把这次产出落群；
- 不触发 `queueRoomMessage`（`rt.roomOf(hiddenSessionId)` 为假），不会把答案当成群里的用户发言再弹一轮。

失败回滚：先认领后投递，投递失败把卡放回队首（沿用现有 `state.questions[sessionId] ??= question` 的写法）。

### 环节 4 · 群日志 + relay 触发

- **用户作答本身要进群日志（R1 修订）**：作答时一律 `appendRoom(room, { who: 'User', kind: 'answer', text: '<kind>：<选项/动作摘要>' })`。
  理由：`postToRoom` 只在有活轮时写 `round.replies`（`groups.js:707-724`），而典型时序是提问轮早已结束、用户之后才作答——只在活轮里加行会丢。
  `kind` 行与既有 `done/stopped/lookup` 同机制（`cells.js:279-283` 有通用渲染），且 `channel.js:47` 的 preview 过滤 `kind === undefined`，不会污染群预览。
- 提问者的后续发言照旧走 `lateRoomReply → postToRoom(..., { late: true })`：写 `room.log`、写 `round.replies`、给群会话 followup（带 `logged: seq`，relay 不重复写）。
- `openingSpeakers`：`late` 帖子只叫醒被 @ 的成员或 `askedBy`；没有就没人说话——**这正是"不关联不停"**。
- `roomPrompt` 的 "Still at work" 行前面加一句：`X is waiting for the user's answer to a question card.`（来自 `roomCards` 非空），让其它成员知道为什么某人没后续。

### 环节 5 · 组内已答渲染

- 群视图里不重放卡片本体（卡片是 dock，不是 transcript）。已答后：
  - **日志里有一条 `kind: 'answer'` 的 User 行**（环节 4，轮次结束后仍在，滚上去能看到"用户选了 X"）；
  - 提问者的后续发言照常以 `GroupMessage` 气泡出现（这是"答案已生效"的可见证据）；
  - 活轮内额外补 `round.replies.push({ kind: 'answer-pending', botId, name })`（进入等答状态时）与 `{ kind: 'answer', botId, name, text }`（轮内作答时），由 `GroupReplies` 渲染轻量行；
  - 组内成员上下文里，`historyEntry` 已把答案文本化，后续轮次能看到用户选了什么。
- 侦察报告标的"未验证：DSH 是否给 room 会话生成 question-reply 节点"——本方案**不依赖**该节点（答案走隐藏会话，AnswerCell 在隐藏视图里），需 UI 实测的只剩 dock 与 GroupReplies 分支，风险降低。

### 环节 6 · 等卡与轮次语义（核心）

状态机（round slot）：

```
waiting ──speaking──▶ speaking ──ask_user──▶ waiting-answer ──用户作答──▶ (新 turn) posted/late
                          │                        │
                          ├──approval──▶ waiting-approval（既有）
                          └──working───▶ working（既有）
```

host 侧改动点：
1. `outputs` 前：ask_user 成功写卡后调用 `rt.waitRoomTurn(sessionId, 'question')`；
   实现仿照既有 `rt.yieldRoomTurn`（`groups.js:349`）：给该 session 的 roomWaiter 一个 `answer()` 回调，
   `roomTurn` 的 `done` 以 `{ answer: true }` resolve。
2. `groups.js runRound`：`reply?.answer` 分支 → `slot.status = 'waiting-answer'`，
   `round.replies.push({ kind: 'answer-pending', botId, name })`，**继续下一个槽位**。
3. relay 返回 JSON 增加 `waitingAnswers: [{ botId, name, kind }]`，群会话自己知道谁在等用户。
4. 用户作答后走环节 3/4，产出以迟到发言落群；`lateRounds` 计数沿用（防刷屏）。
5. 超时：等卡**不计入** `ROOM_REPLY_TIMEOUT_MS`（waiter 已在 conclude 时 resolve），不产生 `missed`。
6. 用户"跳过"：卡片队列支持 `dismiss`（对应现有 `dismissQuestion`），群内跳过=给提问者投一条
   `[用户跳过了这张卡]` 的同款 followup，提问者继续（避免提问者永远挂着）。这是**必须**的，否则"暂停"会变死锁。
7. 群被删 / 成员被移出 / bot 被删：清掉该 room 下相关卡片并给提问者一条 note（它已离开该群，note 走 own chat）。

用户发普通消息时的判定（**需拍板，我建议 C**）：
- A：普通消息不动卡片 —— 卡片可能一直挂着，但不会误吞用户的正常发言。
- B：普通消息直接当"跳过" —— 与 own-chat 一致，但用户可能只是想插一句，误杀提问者任务。
- **C（建议）**：普通消息照常进群，卡片保留；dock 上有显式「跳过」按钮；卡片超过 30 分钟无响应时，
  dock 上提示"已等待 30 分钟"，但仍不自动关闭（用户可能离开）。既不误杀也不无限沉默。

9. 多成员同时挂卡：各自独立，互不阻塞；FIFO 只影响 dock 展示顺序，不影响作答能力与轮次。

10. **v1 边界：群内只支持 interactive 卡（R3）**。`show_view` 的 display-only（`await_reply:false`）在群里没有落点
    （现在直接 return 不落库），v1 明确返回一句提示：`Display-only views are not available in a group; give the card controls (it waits for the user's answer) or write the content in your message.`
    不静默、不半实现；实现时补一条用例。

---

## 3. 改动文件清单（按环节）

| 文件 | 改动 |
|---|---|
| `src/host/store.js` | `state.roomCards` 初始化 + 老状态迁移 |
| `src/host/tools.js` | 删群守卫（`:589`、`:637`），改写入 roomCards + `waitRoomTurn`；**同时改 ask_user / show_view 的 `description` 文案（R2：模型读的是工具描述，光改 prompt.js 不够）**；群内 display-only show_view 的明确提示（R3） |
| `src/host/secrets.js` | 删群守卫（`:400`），请求加 `roomId`；`tell` 支持投到隐藏群会话 |
| `src/host/groups.js` | `waitRoomTurn`（仿 `yieldRoomTurn`）；`runRound` 的 `waiting-answer` 分支；`roomPrompt` 的等答提示；relay JSON 加 `waitingAnswers` |
| `src/host/channel.js` | `view()` 加 `roomCards`；`answer-question`/`view-reply` 的 room 分支；`secret-*` 的 room 分支 |
| `src/host/parts.js` | `historyEntry` 的群分支不再丢卡片文本（`group` 参数语义调整） |
| `src/host/prompt.js` | 删「only in your own chat」，改为群内规则说明 |
| `src/client/questions.js` / `widget-cell.js` / `secret-card.js` | room dock 分支 + 队列 chip |
| `src/client/member-status.js` | 成员状态加"等你回答"（`asks`） |
| `src/client/cells.js` 或 GroupReplies 所在文件 | `answer` / `answer-pending` 行渲染 |
| `client.js` | 上述客户端改动后 `npm run build` 重建 |

---

## 4. 自验计划

- 单测（node --test，新增）：
  1. 群内 ask_user 写进 `roomCards[roomId]`，且不写 `state.questions`；
  2. `runRound` 遇 ask 卡 → 槽位 `waiting-answer`，后续槽位继续执行（用假 agent 驱动）；
  3. 作答 → 投递到 `room.sessions[botId]`，source 同时含 `REPLY_KIND` 与 `role:'room'`；
  4. 二次作答被拒（`bot/stale`）；
  5. 跳过 → 提问者收到 followup，卡片出队；
  6. 群删除/成员移除 → 卡片清理；
  7. FIFO 定序与"作答任意一张"；
  8. 普通群消息不吞卡、不清 `waiting-answer` 槽位；
  9. 答案到达时提问者隐藏会话已换 part（context 重置）→ 以 `room.sessions[botId]` 现值投递成功；
  10. 群内 display-only show_view 返回明确提示、不落库；
  11. `roomCards` 持久化：模拟 DSH 重启（重新 install）后 dock 仍显示挂起卡；
  12. 同 bot 两张合法卡并存，可分别作答（R4）；
  13. 作答后群日志出现一条 `kind:'answer'` 的 User 行，且 preview 不受影响（R1）。
- 手工/联调：桌面群聊里让两个 Bot 各问一张卡，验证"一个在等答案，另一个照常说话"；作答后追问者继续且不重开整轮；**轮次结束后再作答**（R1 的真实时序）也要在日志看到答题行。
- 既有回归：`card-hold`、`blocking-question`、`questions`、`view-reply`、`group-work`、`rounds`、`room-races`、**`secrets`、`follow-through`**。

---

## 5. 待 Chief 拍板（QA 建议已附）

1. 普通消息是否自动跳过卡片：QA 同意 **C（不跳，保留 + 显式跳过按钮 + 30 分钟提示）**。
2. 卡片队列 dock 只显队首 + chip 计数：QA 认为 v1 够用，后续按反馈再决定是否全部展开。
3. 群内密钥卡：QA 建议**排到 ask_user/show_view 验收通过后的第二批**（secrets.js 的 tell/scope/值回投改动面最大，批次切小风险低），不阻塞任务 3。

## 6. 修订记录

| 日期 | 变更 |
|---|---|
| 2026-10-24 v1 | 初稿 |
| 2026-10-24 v2 | 按 QA 复核收敛 R1–R4：① 作答一律 `appendRoom` 一条 `kind:'answer'` 的 User 行走群日志（不再写"答案不进日志"）；② 工具 `description` 文案列入改动清单；③ 群内 display-only show_view 明确不支持；④ 去掉自动 superseded，仅同 payload 去重。补测试用例 8–13、回归加 `secrets`/`follow-through` |
| 2026-10-24 v3 | 按 Chief 拍板落码（本批：`ask_user` / `show_view`；密钥卡不进）。见下「落地记录」 |

## 7. 落地记录（2026-10-24）

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/host/room-cards.js`（新增） | `state.roomCards` 索引：读写、同 payload 去重、认领/回滚、按群/成员清理、答题摘要落日志、把答案投回隐藏群会话、`roomAsksView` |
| `src/host/store.js` | `roomCards` 初始字段 + 老 state 迁移（丢掉已删群/已不在群的卡片） |
| `index.js` | 注册 `roomCards` 模块 |
| `src/host/tools.js` | ask_user / show_view 群内写卡并 `waitRoomTurn`；description 文案（R2）；display-only show_view 群内明确拒绝（R3） |
| `src/host/groups.js` | waiter 增加 `answer()`；`rt.waitRoomTurn`；`runRound` 的 `waiting-answer` 槽位；`roomPrompt` 等答提示；`appendRoomLine`；relay 返回 `waitingAnswers` |
| `src/host/channel.js` | `view()` 加 `roomCards`；answer-question / view-reply / dismiss-question / dismiss-view 的群分支；答题行摘要 |
| `src/host/roster.js` | 删群、移出成员、删 Bot 时清卡片 |
| `src/host/prompt.js` | 群内卡片规则（去掉「only in your own chat」） |
| `src/client/{questions,widget-cell,cells,team-actions,i18n,styles}.js` | 群 dock 队列（队首 + chip + 30 分钟提示 + 跳过）、`answer-pending`/`answer` 行渲染、跳传 cardId、中文文案与样式 |
| `client.js` | `npm run build` 重建 |

### 已实现语义（与拍板一致）

- 卡片按群索引；提问者槽位 `waiting-answer`，同轮其它成员照常发言（「不关联不停」）。
- 作答先认领后投递，失败回滚；投回 `room.sessions[botId]` 现值（换 part 也正确）。
- 作答写 `kind:'answer'` 的 User 行（preview 不受影响）；活轮内同时进 `round.replies`。
- 跳过（dock 关闭按钮）给提问者投 followup，不是静默清槽；普通群消息不吞卡。
- 去重仅同 payload；同成员不同问题两张都留、都可答。
- **队列粒度**：问题卡与 view 卡各有一条 FIFO 队列（两个 dock），不是跨 kind 单队列；每条队列内可任答任意一张。

### 自验（Node v22.20.0）

- `npm test`：845 用例 / 843 通过 / 2 跳过（Windows 场景）/ 0 失败
- `npm run lint`：0 错误、11 警告（与基线一致）
- `node scripts/build-client.mjs --check`：exit 0（client.js 与 src/client 一致）
- 新增 `test/room-cards.test.js` 13 个用例，覆盖 Chief/QA 的 1–15 号验收点（其中 2 个由 `test/view-reply.test.js` 的改写用例承担）

### 未做（已声明）

- 群内密钥卡（第二批）
- 成员状态「等你回答」角标（桌面 member-status）：本批未改，dock 本身已表达等待；评估后如需再补
- `parts.js` 的 `!group` 卡片文本守卫：未改。答案本身带问题与选项，隐藏群会话的历史不缺信息；该守卫只影响隐藏会话的展示
