# 群聊卡片：现状侦察报告（立项依据）

> 立项日期：2026-10-23
> 目标：让**群聊**里的 Bot 也能弹交互卡片（提问卡 / 展示卡 / 密钥卡），用户可直接点选，答案回到提问的 Bot。
> 现状结论：**不是一行开关，是真特性**；但比预期乐观——群聊的卡片容器已经存在，缺的是「卡片归属」与「答案回投」链路。

本报告的证据均来自对本机已安装 `ds-bot@0.2.0` 的只读核查（`~/.dsh/profiles/desktop/node_modules/ds-bot`），
与上游 tag `v0.2.0` 的 `ds-bot/` 源码逐字节一致（`client.js` 与 `src/host/` 已 diff 验证）。
本 fork 基于 `v0.2.0`，分支 `feat/group-chat-cards`。

---

## 一、为什么现在不行

### 1. 显式守卫（工具处理器里的一行判断）

| 位置 | 内容 |
|---|---|
| `src/host/tools.js:589` | `if (rt.groupOwners.has(id)) return 'Question cards only work in your own chat. In a group, ask in your message instead.'` |
| `src/host/tools.js:637` | 同款守卫，View cards（`show_view`） |
| `src/host/secrets.js:400` | 同款守卫，Secret cards（`request_secret`） |
| `src/host/parts.js:144-151` | `historyEntry(event, group)`：`if ((named==='ask_user'||named==='show_view') && !group)`，注释「Cards only show in an own chat」 |

### 2. 提示词里的同一条约束

- `src/host/prompt.js:18`：明文写 「…It only works in your own chat, not in a group.」
- `src/host/prompt.js:17`、`prompt.js:21`：ask_user / 相关条款同源

### 3. 旁证：DSH 自己的卡片在群聊里也不显示

- `src/host/approvals.js:1-3`：「A member's group Session is hidden, so DSH's approval card never shows in the group chat.」
- `src/host/tools.js:686-687`：Bot 侧被全面禁止使用 DSH 自带的 `ask_user_question`（`BLOCKING_QUESTION_TOOL`），所以 Bot 只能走 DS Bot 自研卡。

---

## 二、群聊的会话拓扑（理解改动的前提）

1. **群聊 id 就是一条真实的 DSH Session**：`src/host/roster.js:348` `buildRoom` → `createSession(title)`；
   `roster.js:341` 注释「The group's own Session only relays」。群聊界面 = 标准 DSH 对话视图
   （`client.js:15470` `openSession` → `partFor(roomId)` = `room.id`），composer 与 `conversation.input.dock` 都在。
2. **成员发言跑在各自隐藏的群内会话** `room.sessions[botId]` 里（`src/host/groups.js:184-206` 建会话；
   `groups.js:309` `rt.deliver({role:'room', sessionId})`）。
3. 轮次驱动是 **`group_relay` 工具**（`src/host/groups.js:491-520`），跑在群会话（`room.id`）里，
   收齐 `round.replies` 后 `appendRoom` 写 `state.rooms[room.id].log`。
4. 文本回收：`turns.js:503-514`；`turn/end` 时按 `info.role==='room'` 把结果 resolve 给 `roomWaiters`（`turns.js:598-608`）。
5. **渲染**：群聊视图里 `AssistantCell` 对整个 room 会话隐藏（`client.js:5141`），成员发言由
   group_relay 工具格 → `GroupReplies`（`client.js:5781`）→ `GroupMessage` 气泡（`client.js:5208`）渲染，
   实时靠 `room-progress` 轮询（`client.js:1513` / `channel.js:193`）。成员视角看别人的 post 走
   `TriggerCell` 的 `source.role==='post'`（`client.js:5418-5432`）。

### 承载能力判定（关键）

- 主消息路径是「工具结果 → **纯文本气泡**」，没有交互结构；群会话的 tool cell 本身被隐藏。
- **但 composer dock 是全局注册、无群聊排除**：`client.js:15793-15795`（QuestionDock / WidgetDock / SecretDock）；
  `MemberDock` 本身就是为 room 写的（`client.js:12900-12920`）。
- 因此**卡片可以落在群聊输入框上方**；不能复用的是「内联在工具调用里」的展示方式。

---

## 三、核心缺陷：卡片挂在错误的会话上

- 卡片写在**执行工具的那条会话**上：`tools.js:604` `state.questions[exec.agent.id]`；`show_view` 同理（`tools.js:651`）。
- 群成员跑 turn 的会话是**隐藏群会话** `room.sessions[botId]`，**不是** `room.id`。
- 客户端查的是 `questions[当前打开的会话]`：`client.js:3773` QuestionDock → `useRoster(v => v.questions?.[sessionId])`，
  群聊里 `sessionId = room.id`。
- **两者永不相等** ⇒ 只删守卫的后果：卡片不显示、`exec.concludeTurn()` 已结束成员 turn，那个 Bot 白等一场。

---

## 四、要补齐的六个环节

| # | 环节 | 位置 | 要点 |
|---|---|---|---|
| 1 | **卡片归属索引** | `src/host/tools.js:604` / `tools.js:651` / `secrets.js` 对应处 | 写卡时按 room 记一份：`roomId → { 提问的隐藏会话, 卡片 }` |
| 2 | **客户端反查** | `client.js:3773`（QuestionDock）/ `4347`（WidgetDock）/ `4607`（SecretDock） | 支持「用 `room.id` 找到该群成员挂起的卡」；多成员可能同时挂卡，需定序/选择策略 |
| 3 | **答案回投** | `src/host/channel.js:318-340`（answer-question）/ `341-365`（view-reply） | 现在把答案 `followup` 到 room 会话的 agent；应回投到**提问的那条隐藏群会话**（`agent.followup`），否则答案进不了提问 Bot 的上下文 |
| 4 | **群日志 + relay** | `src/host/turns.js:480-497` | 只把 `source.kind === 'user'` 的消息进 `roomInbox`；答复走 `REPLY_KIND`（`src/host/constants.js:45` = `user-question-reply`）→ 不写群日志、不触发 relay，群里看不到用户选了什么，relay 还会以空 opener 开一轮。需补一条 `queueRoomMessage` |
| 5 | **组内已答渲染** | `client.js:4360-4385`（AnsweredReply / AnsweredCell，挂 `question-reply` 节点） | **未验证**：DSH 是否会给 room 会话生成该节点，需 UI 实测 |
| 6 | **语义定义** | `turns.js:598-608` | `ask_user` 已 `concludeTurn()`，该成员那一轮 `roomWaiters` 会以空串 resolve、轮次继续推进；「等卡」与「轮次推进」的关系必须先定清楚 |

---

## 五、风险与工程约束

1. **ds-bot 是 registry 依赖**：`~/.dsh/profiles/desktop/package.json` 中 `"ds-bot": "0.2.0"`。
   DS Bot 自更新走 DSH 插件管理器的 `installBundle(spec)`（`src/host/update.js:211-213`）→ **整包覆盖**
   `node_modules/ds-bot`，手改源码会被**无提示抹掉**。
2. 包内**只有 host 源码随包发布**：`package.json.files` = `index.js, src/host/, src/shared/, client.js, web-search.js, cordis.patch.yml, README.md, LICENSE`。
   `src/client/` **不在 npm 包里**；`client.js` 是 927KB 打包产物（未混淆，含 `// src/client/questions.js` 之类注释，可手改但脆弱）——
   正经改客户端必须像本 fork 一样从上游源码构建。
3. **耐久路线（已有先例）**：`~/.dsh/profiles/desktop/.ds-bot.pre-bridge`（整目录备份）+
   `package.json.pre-bridge`；`.bridge-artifacts/ds-bot-0.1.7-codex.1.tgz` 是 fork 重打包的先例。
   本 profile 里 `dsh-plugin-mobile-gateway` 使用 `file:` 引用，即为推荐模式 ⇒ **fork 重打包 + `file:` 引用**，不要手改 node_modules。
4. **绝不动正在运行的安装**：本线程（Bot 团队）就跑在 ds-bot 里，改坏会同时弄坏开发工具本身。
   安装到 profile 必须由用户显式决定，并保留一键回滚。

---

## 六、与手机端的关系（互不阻塞）

- 手机端 `question-requested` 来自 DSH 官方 Host waterfall `user-questions/request`：
  `dsh-plugin-mobile-gateway/lib/index.mjs:3437` 挂 `ctx.on('user-questions/request', …)`，gated on `hasInteractionClient(sessionId)`，
  广播 `question-requested`（`lib/index.mjs:2442`），由网关自己 resolve。
- 桌面的 `ask_user`/`show_view` 是 **DS Bot 自研工具**，从不进那条 waterfall（全仓库 `grep user-questions` 只命中
  `ask_user_question` 这个常量名）；数据走 `state.questions` → DS Bot 自己的 `channel.js:51` 与客户端组件。
- 唯一交点是复用同一个 source kind：`src/host/constants.js:45` `REPLY_KIND = 'user-question-reply'`。
- 手机 bridge（`ds-bot-mobile-bridge-0.0.6` 的 `src/group-projection.mjs`）对群聊只做**纯文本投影**，
  完全没有 card/question 概念 ⇒ 手机端要在群聊显示卡片是 bridge 侧的新特性，与本 fork 互不阻塞。

---

## 七、上游与构建

- 上游：`Fei2411/DeepSeek-Bot`（Apache-2.0，JavaScript），本 fork 基于 tag `v0.2.0`（与本机已安装版本逐字节一致）。
- 插件包目录：本仓库的 `ds-bot/`（`app/` 是桌面 App，本项目不动）。
- 工具链（在 `ds-bot/` 下）：
  - `npm run build` — 由 `src/client/` 构建 `client.js`（客户端改动后必须执行）
  - `npm test` — `node --test test/*.test.js`
  - `npm run lint` / `npm run check`（`dev/check.sh`）
  - 相关既有用例：`test/card-hold.test.js`、`test/blocking-question.test.js` 等
- 维护姿态：所有改动保持在 `feat/group-chat-cards` 分支上，便于日后 rebase 到更新版本的上游。
