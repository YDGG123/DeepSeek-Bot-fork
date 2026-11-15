# 上游合并预演：v0.2.4 → v0.3.6（2026-11-15）

> 分支 `rehearsal/upstream-0.3.6`（从 `integration/upstream-0.2.4` 的 `93fc5cb` 开出，场地
> `/Volumes/Mac专用/Projects/ds-bot-merge-rehearsal`）。**预演：只出读数，不落地。**
> 目标：一次合到 **v0.3.6**（`a66cc73`，2026-11-12），`93fc5cb..v0.3.6` 共 **1150 个提交**。
> 策略沿用：**merge 不 rebase**，保住自研提交 hash；冲突一律并集，两边功能都留。

## 坐标

| 项 | 值 |
| --- | --- |
| 上游基线（已合） | v0.2.4 = `93fc5cb`（`integration/upstream-0.2.4` 尖端） |
| 本次上游终点 | v0.3.6 = `a66cc73`（1150 提交，上游 diff 610 文件 +142426/−25391） |
| 合并提交 | `46da562`（父 `93fc5cb` + `a66cc73`），后随 `795bf8d`（A 类测试适配）、`b2b8e80`（D 类 i18n）、`e7d1bd6`（text 回归修复 + 守卫 + B 类断言 + 死参数清理） |
| 冲突 | 15 文件 19 处（2 个 modify/delete + 13 个内容冲突） |

## 架构变化：群聊底层改 ledger 记账（0.3.x 最大的一块）

上游新增 `src/host/ledger.js`，群聊"说了什么"统一走 `say(room, line)` →
`rt.ledger.append(bookOf(room.id), record)`；读取走 `rowsView/groupRows`（每条
`group_relay` 调用在账本里落一个 `anchor` 事件，视图按锚点分段读行）。

- **`appendRoom` 和 `loadGroupLines` 被上游删除**。我们 `room-cards.js` 的
  `rt.appendRoomLine` 原来依赖 `ensureRoomLog + appendRoom`，已移植为直接调 `say()`
  （`groups.js` conflict 1 的解法，`rt.appendRoomLine = (room, line) => { say(room, line) }`）。
- `round.replies`（旧轮次回包数组）不再存在；轮次事件（`failed`/`approval`/`working`/
  `missed`）改经 `say()` 进账本，由 `rowOf` 映射回 reply 形状给客户端。
- 轮次驱动重构成事件循环 `runRound`（每轮对每个可启动 slot 挂 `memberTurn`），
  我们的 `waitRoomTurn`/`roomWaiters` 形状没变，上游 waiter 还自带 `answer` 信号位。
- 旧 relay 上限守卫被上游标成 LEGACY，换成 idle ping-pong 守卫（`holdIdleCalls`）；
  旧的 `room.paused` 条目仍由 `releaseParked` 兼容放行。

## 15 文件 19 处冲突的判法

| 文件 | 处数 | 判法 |
| --- | --- | --- |
| `.github/workflows/release.yml`、`test.yml` | 2 | modify/delete：我们删了、上游改了 → **保持删除**（`git rm`） |
| `ds-bot/client.js` | 7 | 构建产物：占位取我方，随后 `build-client.mjs` 重建为准（不手改） |
| `ds-bot/index.js` | 2 | imports + MODULES 并集：我们的 `roomCards/teamFeed/cardFeed` 留在 roster 之后；上游新增 `ledger/steer/goals/computer/mobile/phone/im/goalSkills/localAgents` 按原相对位置插入 |
| `src/client/cells.js` | 1 | 并集：我们的 reply-kind 链（lookup/missed/admin-passed/paused/resumed/cut/approval/working/answer-pending/answer/stopped/done）全留 + 上游 `goal` 分支追加（落点在上游 `RelayEvent` 函数体内，可达） |
| `src/client/characters.js` | 1 | **取我方**：`layerDefs` 是名册发布的硬依赖（`team-feed.js:36` 读它），上游只把阴影从 .14/.16 软化成单层 .07——视觉取舍留产品裁决，注释已标 |
| `src/client/questions.js` | 1 | 并集：我们的群 dock 分支（`RoomQuestionDock`）+ 上游 `inPart` 条件与 `enterToSend`；群 dock 内补接同一 `sendsOnEnter` 偏好 |
| `src/client/widget-cell.js` | 1 | 同上：群 dock 分支 + 上游 `inPart` 条件（PendingView 无文本作答，不需要 enterToSend） |
| `src/host/channel.js` | 3 | ①view 快照并集：我方 `roomCards` + 上游 `closedCards` 并存；②case 头并集：上游 `goal-draft/goal-control/stop-chat` + `stop-room-work` 的 try/finally + 我方带花括号的 `dismiss-question`；③答题分支并集：我方 room 卡分支前置，其余委托上游新函数 `rt.answerQuestion`（语义与旧内联一致），`cardFeed.answered` 钩子挪进该函数 |
| `src/host/groups.js` | 4 | ①整块取上游 ledger 基建（`say/rowOf/rowsView/noteFailure`），我们的 `appendRoomLine` 移植成 `say()` 直调；②我方 `waitingNames` 行 + 上游 `...placeLines(round, slot)`；③取上游（我们旧 relay 循环整段被 LEGACY 化取代），随后把 `waiting-answer` 槽位移植进上游 `memberTurn`（`slot.status='waiting-answer'` + `say({kind:'answer-pending'})`），`slotLabel` 补 waiting-answer 标注；④取上游 `{from, anchor}` 锚点回包（waitingAnswers 的去向见 B 类，见下） |
| `src/host/parts.js` | 1 | 并集：我方 `MODEL_SWITCH_COMPACTION` + 上游 `NO_SUMMARY` 常量并存；`STUCK_CODES` 取上游（上游 `62034501` 有意收窄为只救 `IMAGE_OFFLOAD_REQUIRED`——该行本来就是上游的，不是自研件） |
| `src/host/store.js` | 2 | ①state 形状并集：`sections:[]` + `closedCards:{}`（上游）+ `roomCards:{}`（我方）；②save 重构取上游（revision/snapshot 挪进写闭包防陈旧快照），我方 `teamFeed/cardFeed touch` 随迁进闭包 |
| `src/host/tools.js` | 1 | 取我方：群卡分支（`groupOwners`→`addRoomCard`/`waitRoomTurn`/`concludeTurn`）+ hidden-turn `callId` 判定，是上游形态的严格超集 |
| `test/install.test.js` | 1 | 注册顺序清单按 MODULES 并集推导 + 单测失败 diff 校正 |
| `test/view-reply.test.js` | 1 | 取我方（上游测试标题断言的是"群内拒绝 show_view"——那是被我们判法否决的行为） |

**上游「群内不支持卡片」的拒答守卫已拔除**：v0.3.6 `tools.js` 的
`if (rt.groupOwners.has(id)) return 'Question cards only work in your own chat…'`
没有进合并树；ask_user/show_view 的守卫是并集形式
`!rt.chatOwners.has(id) && !rt.groupOwners.has(id)`，描述里的群内卡片子句保留。

## 四件自研的存活证据（HEAD = `e7d1bd6`）

| 自研 | 证据 |
| --- | --- |
| 群聊卡片 | `room-cards.js` 123 行零改动；`channel.js:95 roomCards` 投影 + `:237 roomCardFor`；`groups.js:1127` waiting-answer 槽位（移植进上游 `memberTurn`）；`rt.appendRoomLine` 走 `say()`；`slotLabel` waiting-answer 标注；`rowOf` 透传带 text（本次回归修复，见下） |
| 团队馈送 | `team-feed.js` 348 行零改动；`ctx.provide('dsBotTeam')` 在 `:347` |
| 卡片馈送 | `card-feed.js` 263 行零改动；`ctx.provide('dsBotCards')` 在 `:262`；`store.js` save 闭包里的 `cardFeed.touch()` 随上游重构迁移 |
| 群密钥卡 | 上游这轮**大改了 secrets.js**（相对 v0.2.4 −154/+32），我们的增量（相对 v0.3.6 +135/−18）经自动合并与其并存；`secretEndpoint` 在 `:480`；17 例套件全绿 |
| glyph 头像 | `characters.js:84 layerDefs` 派生循环保留（上游的 .07 软化未采纳，视觉取舍待产品裁决）；`team-feed.js:36` 消费 layerDefs 在位 |

## 闸门读数

跑法：`~/.dsh/node-v22/bin/node --import ./test/harness-resolve.mjs --test
--test-timeout=120000 --test-force-exit "test/*.test.js"`（Node 22，系统 node v20 跑不动）。

| 闸门 | 读数 | 退出码 |
| --- | --- | --- |
| `node scripts/build-client.mjs --check` | 一致 | 0 |
| 全量测试 | **2251 例 / 2245 pass / 3 fail / 3 skip** | 1（3 fail 见下，非代码红） |
| `npm run lint` | 0 错误 / 75 警告 | 0 |

**3 个 fail 的定性（防止将来误判为真红）**：`a card asked in a hidden Bot-to-Bot turn
keeps its call id…`、`a hidden-turn card closes into closedCards at its call…`
（group-secret-cards）与 `waiting hands over who a Bot waits for…`（handoffs）——
三个都依赖 `settle()` 轮询（3 秒上限），全量并行负载下偶发超时。**单文件复跑
17/17 全绿**（两连验证）。红在别处才是真问题。

基线对照：合并前 1329 例 / 1327 pass / 0 fail / 2 skip。用例 +922、skip 2→3
（3 个 skip 全是上游新增的 Windows 平台条件跳：`files.test.js:17/28`、
`local-agents-discover.test.js:53`；基线两个条件跳 office:743/privacy:316 这次
条件未触发，身份未变）。QA 报过的 `files.test.js:40` 40ms 硬时限已被上游
`8b674924` 修掉（改为断言"没安排重试等待"），该条环境噪声不再出现。

## DSH 版本缺口结论：不挡路

- 0.3.6 对 `@deepseek-ai/*` 的**硬 import 只有 1 个新增**：`turns.js:6` 的
  `carrierKeyOf`（唯一用处 `:1178`）。本机 dsh-scope（rc.2/rc.4 均验）带该函数
  （`lib/index.js:352`，QA 拆过产线 asar 证实 rc.4 内嵌）。
- 新增 5 个 dsh 包（`dsh-mcp-client`、`dsh-computer-use`、`dsh-experimental-cua-macos`、
  `dsh-experimental-computer-use-cua-driver-native`、`dsh-app-boot`）**全部是懒加载
  动态 import 且带 catch 兜底**（`connectors/index.js:148`、`computer/index.js:170/180`、
  `dsh-update.js:51`、`client/speech.js`）——在 rc.4 宿主上按功能降级（连接器 MCP
  扫描、电脑操作、语音输入缺失），不挡启动。
- `peerDependencies` 全是 `*`，npm 不拦版本。
- **结论：0.3.6 主体能在 0.2.1-rc.4 宿主上跑**；缺的是可选功能的包本身。测试侧
  dev/harness 需整体升到 **0.2.2-rc.1**（上游自己的 dev 钉版，见下）。

## C 类环境配方（依赖缺失的修复步骤，已逐条验证）

1. **运行时依赖**：`ds-bot/` 下 `npm install`（上游新增 `qrcode-generator@2.0.4`、
   `@modelcontextprotocol/client@2.4.0`、`deep-view@0.1.2`、`imapflow`、`mailparser`、
   `nodemailer` 等 8 个）。
2. **link 打包**：esbuild 从 `../link/` 解析依赖，必须 **在 `link/` 目录里 `npm ci`**
   （`@noble/curves|hashes|ciphers`、`@lukeburns/clatterjs`、`ws`），再跑
   `node scripts/build-link.mjs`（`npm run build` 现在含这一步）；`--check` rc=0。
3. **测试 harness**：`@deepseek-ai/dsh-agent-loop-testkit@0.2.2-rc.1` 必须装进
   **`dev/harness/`**（装 ds-bot/node_modules 解析不到）；它拖入 `dsh-agent-loop`
   全链，executor 包 import `dsh-tools/pipeline`（rc.2 无此导出），所以 harness
   实际整体升到 **0.2.2-rc.1**（607 包变更）。
4. **phone 测试**：缺 `ws`（`link/package.json` 声明 ^8.22.0，装进 harness/或 ds-bot
   皆可解析）。

## 本次合并发现的真回归：answer 行过 rowOf 丢 text

**症状**：用户在群里答完卡片，答案文字在群聊视图里渲染成空白行。

**证据链**：
1. `room-cards.js` 写入 `{ who: 'User', kind: 'answer', text }` —— 带文字；
2. 上游 `groups.js` rowOf 的通用透传 `if (record.kind !== 'notice') return
   { kind: record.kind, ...who, time }` —— 只搬 kind/who/time，**text 丢**；
3. 客户端 `cells.js` 的 `kind === 'answer'` 分支渲染 `reply.text` → undefined → 空白；
4. 读路径是 `rowsView` 的 `.map(rowOf)`（客户端群视图消费的那条），不是写路径
   （写路径 `say()` 进账本，行本身完整）。

**为什么合并前没事**：老的 `appendRoom`（`93fc5cb`）整行保留 `{...line, seq}`，
没有白名单转换；上游这套 `rowOf` 是 0.3.x 新的。

**为什么上游自己没暴露**：上游自己发的 kind 行（`approval`/`working`/`answer-pending`）
本来就不带文字；带文字的只有我们的 `answer` 行——自研形态撞上新转换。

**修法**：透传改条件展开 `{ ...who, time, ...(record.text === undefined ? {} : { text: record.text }) }`
——上游的行形状不变（它们本来没 text），我们的行把 text 带出来。

**守卫**（`test/room-cards.test.js`「an answer line keeps its text…」）：钉**读回路径**
而非写路径——①`rt.groupRows('r1', 0)` 读回后 `kind==='answer'` 行的 `text` 还在
（守 rowsView/rowOf）；②`room.log` 里也在（守 `memberLine`/`SHOWN_ONLY` 不被收紧，
否则成员下一轮读不到用户的选择）。两条负对照已验：模拟 rowOf 丢 text → 精确红；
移除 roomPrompt 的 waitingNames 行 → B 类断言红；还原后 31/31 绿。
**下次合并同样的坑还会出现**：我们的 kind 行过上游新转换层时，先查字段白名单。

## 附带记录

- `appendAnswerLine`（room-cards.js）的第三个参数 `{ reply: … }` 在旧实现里往
  `round.replies` 推（让进行中的轮次立刻看到答案）；ledger 化后该参数死掉，已删，
  注释改为「ledger 是记录，读回走 rowsView」。
- `waitingAnswers`（旧 relay 回包字段）在 src/ 里零生产消费者——它只活在工具回包
  文本和测试断言里；手机端读的是 dsBotCards/roomCards 投影，与它无关。B 类取舍
  拍板为：断言改读 `roomPrompt` 的 waitingNames 行（上游的等价载体），
  **不补回字段**。
- `STUCK_CODES` 取上游收窄（`INVALID_REQUEST` 移除）是上游 `62034501` 的有意行为
  变更，不是我们的自研件被砍；我们的 `MODEL_SWITCH_COMPACTION` 回滚机制完整保留。

## 已知边界与风险

1. **双轨并存是常态**：四件自研上游一件没做，上游还一度写过群内拒卡守卫（本轮已按
   判法拔除）。下次上游再动群聊/转换层，本轮的冲突判法表和守卫测试直接复用。
2. **两个单点值得盯**：①群卡行全走 `say()` 进 ledger，上游改一行 `SHOWN_ONLY`/
   `memberLine` 就会静默改变成员读到的行（守卫②已钉）；②`rowOf` 的非 notice 透传
   目前顺带承载我们的 answer/answer-pending 行（守卫①已钉）。
3. **characters.js 的视觉取舍未决**：上游把阴影软化成单层 .07，我们保留二期定稿的
   .14/.16（layerDefs 是名册硬依赖，结构必须留）。要不要跟上游的视觉，待产品拍板，
   只是两个常数值。
4. **`npm test` 必须 Node ≥22**，且 dev/harness 已整体升 0.2.2-rc.1（见 C 类配方）；
   独立复核场要带上这套依赖状态，否则 C 类三套件红（QA 的 sha 快照流程照旧）。
5. lint 警告 38 → 75：全部来自上游新增/改写代码，未清理（清理会与下次合并打架）。
