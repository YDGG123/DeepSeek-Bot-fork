# 上游合并：v0.2.2 → v0.2.4（2026-10-31）

> 分支 `integration/upstream-0.2.4`（从 `integration/upstream-0.2.1` 的 `761bebb` 开出）。
> 目标：一次合到 **v0.2.4**（`f823773`，2026-10-29），`v0.2.1..v0.2.4` 共 **341 个提交**。
> 策略沿用上次：**merge 不 rebase**，保住 62+ 自研提交的 hash。

## 坐标

| 项 | 值 |
| --- | --- |
| 上游基线（已合） | v0.2.1 = `1bebe82` |
| 本次上游终点 | v0.2.4 = `f823773` |
| 合入点（本分支） | 见 `git log` 的 merge 提交 |
| 自研提交数（保住） | 25（`merge-base(v0.2.1, HEAD)..HEAD` 之前的部分不动） |

## 架构变化：`src/shared/views.js` → npm 包 `deep-view@0.1.0`

上游删除了 685 行的 `ds-bot/src/shared/views.js`（以及 `src/shared/formula.js`、`src/client/widget-chart.js`、
`src/client/widget-html.js`），换成 `deep-view@0.1.0`：

- 所有 `from '../shared/views.js'` → `from 'deep-view/core'`（上游已自动改好 5 处，已逐个核对，无漏网）；
  `widget-cell.js` 改用 `deep-view/react`（`WidgetCard` / `ViewUi` / `DEEP_VIEW_CSS` …）。
- `package.json` 增加 `"deep-view": "0.1.0"`。
- **必须真的安装**：`cd ds-bot && npm install`（本机 profile 用 `file:` 软链指向本仓库，
  `ds-bot/node_modules/deep-view` 缺失 = 插件起不来）。
- 导出符号核对：`checkShownView` / `validateViewAnswer` / `normalizeView` / `viewReply` / `viewReplyText` /
  `viewCardText` / `readViewReply` / `showViewDescription` / `showViewParameters` … 全部在位。

## 9 文件 12 冲突的判法

| 文件 | 处数 | 判法 |
| --- | --- | --- |
| `ds-bot/client.js` | 3 | 构建产物：占位取我方，随后 `build-client.mjs` 重建为准（不手改） |
| `ds-bot/index.js` | 2 | MODULES/imports 并集：我们的 `roomCards/teamFeed/cardFeed` 留在 roster 之后；上游新增 `requests/privacy/avatarLibrary/learning/browserPlugins/officeSkills` 按原相对位置插入。41 个模块逐个核对 import 齐全 |
| `src/client/team-actions.js` | 1 | 并集：我们的 `dismissView(sessionId, cardId)`（widget-cell 传双参）+ 上游 `deleteBtw` |
| `src/host/channel.js` | 1 | 并集：上游 `stop-room-work` + 我们的 `dismiss-question`（保留花括号块体，群卡逻辑在内） |
| `src/host/store.js` | 1 | state 初值并集：我方 `roomCards:{}` + 上游 `privateArchives:[]`、`requests:{}`，JSDoc 同步 |
| `src/host/tools.js` | 1 | 采纳上游 `showViewDescription/showViewParameters`（单一事实源），把我们的群聊子句拼回 description 末尾；**不采纳**上游「群内拒绝 show_view」那一行（群卡是自研功能） |
| `test/install.test.js` | 1 | 双方断言并留；顺序按合并后的实际注册顺序校正（privacy 的 `tools/execute` 因我们的三件套在 MODULES 里更靠前而晚一位） |
| `test/memory.test.js` | 1 | 上游删的注释按上游删 |
| `test/view-reply.test.js` | 1 | 上游 `await start()` 形态 + 标题保留群卡措辞；群卡断言全留 |

## 五块自研的存活证据

| 自研 | 证据（HEAD 工作区） |
| --- | --- |
| 群聊卡片 | `src/host/room-cards.js` 123 行；`channel.js:149 roomCardFor` + `:416/:426/:468` 三处接线；`widget-cell.js:73 RoomViewDock`、`:38 dismissView(sessionId, view.id)` |
| 团队馈送 | `src/host/team-feed.js` 348 行，`ctx.provide('dsBotTeam')`，`glyphOf` 在位 |
| 卡片馈送 | `src/host/card-feed.js` 263 行，`ctx.provide('dsBotCards')` |
| 群聊密钥卡 | `src/host/secrets.js` 与合并前**逐字节相同**（上游 v0.2.2–0.2.4 根本没动这个文件，`git diff --stat v0.2.1 v0.2.4 -- secrets.js` 为空）；我们的 135 增 / 18 删完整 |
| glyph 头像 | `src/client/characters.js:79 SHAPES` + `:83 layerDefs` 派生循环；`team-feed.js:27 glyphOf` + `:131` 「有自定义位图时不发 glyph」守卫；重建后的 `client.js` 内命中 20 处 |

## 闸门读数

跑法（本机系统 node 是 v20，加载不了 `registerHooks`，必须用 Node ≥22）：
`PATH="$HOME/.dsh/node-v22/bin:$PATH"`（该目录已装 v22.23.4，仓库外，不随包分发）。

| 闸门 | 读数 | 退出码 |
| --- | --- | --- |
| `node scripts/build-client.mjs --check` | 一致 | 0 |
| `npm test` | **1335 例 / 1333 pass / 0 fail / 2 skip** | 0 |
| `npm run lint` | **0 错误 / 38 警告** | 0 |

基线对照：合并前 989 例 / 987 pass / 0 fail / 2 skip、lint 0 错 12 警。
用例 +346、警告 +26 全部来自上游（未新增我们的错误；警告数是上游代码风格，lint 仍 exit 0）。

## 已知边界与风险

1. **`npm test` 必须 Node ≥22**（`test/harness-resolve.mjs` 用 `node:module` 的 `registerHooks`）。
   系统 node v20 直接报 `SyntaxError: does not provide an export named 'registerHooks'`。
   用 Electron-as-node（`ELECTRON_RUN_AS_NODE=1`）能跑，但会引出下面第 2 条的 3 个假失败。
2. **Electron-as-node 下有 3 个 office 用例必红**（环境伪影，非合并错误）：
   `officeNode()` 判 `process.versions.electron === undefined` 才当 plain Node；ELECTRON_RUN_AS_NODE
   下该属性是 `44.7.0`，于是返回 `{node: undefined}`，「falls back to the host interpreter」等 3 条断言失败。
   **反证**：用 preload 删掉 `process.versions.electron` 后三条断言立刻转绿；真 Node 22 下全量 0 fail。
   建议（待裁决）：`officeNode` 里把 `ELECTRON_RUN_AS_NODE` 视作 plain Node（`process.versions.electron
   === undefined \|\| process.env.ELECTRON_RUN_AS_NODE`），生产 Electron 宿主不受影响。
3. **分发必须带 `deep-view`**：dsh-suite 拷贝若只拷 `ds-bot/` 源码而不装依赖，装进去的插件会在
   `import 'deep-view/core'` 处直接崩。安装脚本需 `npm install --omit=dev` 或把 `node_modules/deep-view`
   一起拷。
4. **`app/` 的 65 个文件变化全部来自上游**（本 fork 从未改 `app/`，`git diff v0.2.1 761bebb -- app/` 为空）。
   我们没有在 `app/` 里引入任何自己的改动。
5. lint 警告 12 → 38：全部落在上游新增/改写的代码上，未清理（清理会与下次 rebase 打架）。
