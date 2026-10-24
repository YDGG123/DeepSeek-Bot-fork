# 安装 / 回滚 Runbook（Chief 照着跑）

> 状态：**可复现操作手册**，由用户或 Chief 在终端手动执行。
> 日期：2026-10-24（rev 6bc0f0a 之后按 QA 四条修订）· 事实均来自本机只读核查与隔离实验
> 红线：先备份、不乱删、可回滚；`~/.dsh/profiles/desktop/node_modules/ds-bot` 是正在跑的 Bot 团队宿主。

> **⚠️ 重启那一步不能由 Bot 自己跑**：关闭 App 会杀掉承载 Bot 的宿主进程，Bot 正在执行的命令会随之中断；
> 最坏情况是 `open` 也被吞掉，App 停在关闭状态。退出与重开必须由用户手动执行。

---

## 0. 事实基线（已核实）

| 项 | 事实 |
|---|---|
| profile | `~/.dsh/profiles/desktop`（宿主进程参数里就是它） |
| 包管理器 | pnpm（`pnpm-lock.yaml` + `pnpm-workspace.yaml`：`packages: ['.']`、`nodeLinker: hoisted`），**PATH 里没有 pnpm** |
| **跑 pnpm 的正确姿势** | 应用自带的 `runtime/bin/node` 只是包装脚本（内容：`exec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$@"`），**裸终端里该变量为空 → 127**。必须用 Electron 当 node：`ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" <pnpm.cjs>`（实测 v24.21.0） |
| pnpm 入口 | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs` |
| 现有依赖形态 | `ds-bot: "0.2.0"`（registry，实体目录）；`dsh-plugin-mobile-gateway: "file:…"`（同款先例，实体目录） |
| 插件注册 | `package.json` 的 `dsh.profile.bundles` 已含 `"ds-bot"`；`cordis.patch.yml` 里**没有** ds-bot 条目 |
| fork 包目录 | `/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot`（含 `index.js`、`client.js`、`src/host/`） |
| 网关工作区 | `/Users/yidagege/Documents/deepseek-harness/default-workspace/dsh-plugin-mobile-gateway`（含两文件；核实日 HEAD `422fb45`，含混合帧修复） |
| pnpm store | 本地（`~/.pnpm-store` v10/v11），离线回滚大多可走 |

### 两个已由隔离实验证实的结论（决定下面步骤的顺序）

1. **`pnpm install` 会重新打包 `file:` 目录依赖**：手拷进 `node_modules` 的文件会被冲掉，源目录的新文件会被同步进来。
   ⇒ **install 在前，copy 只作补救**；一旦手工 copy，之后**不要再跑 install**。
2. **`file:` 装的是磁盘现场，不是某个 commit**：工作区有未提交改动就会被一起装进去。
   ⇒ 安装前必须**两棵树干净、HEAD 符合预期**。

---

## 1. 安装前检查（不过就别继续）

```bash
set -e
REPO="/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot"
GW="/Users/yidagege/Documents/deepseek-harness/default-workspace/dsh-plugin-mobile-gateway"

# 1) 两棵树必须干净
test -z "$(git -C "$REPO" status --porcelain)" || { echo "ds-bot 工作区不干净，停止"; exit 1; }
test -z "$(git -C "$GW" status --porcelain)"   || { echo "网关工作区不干净，停止"; exit 1; }

# 2) 记录接下来装进去的 commit（写进安装记录）
git -C "$REPO" rev-parse HEAD
git -C "$GW" rev-parse HEAD

# 3) 两个新网关文件已在工作区（install 会自动带进安装副本）
ls "$GW/lib/mobile-v1/team-feed.mjs" "$GW/lib/mobile-v1/card-frames.mjs"

# 4) 无 Bot 在跑长任务；备份目录名今天没用过（避免嵌套）
P="$HOME/.dsh/profiles/desktop"
STAMP="$(date +%Y%m%d-%H%M%S)"
test ! -e "$P/.ds-bot.pre-fork-$STAMP" || { echo "备份名已存在，换一个 stamp"; exit 1; }
echo "STAMP=$STAMP"
```

把 `git rev-parse` 的两个 commit 填进第 11 节「安装记录」。**若 ds-bot HEAD 不是 `f8787c6` 或其后的提交，先对齐再装。**

---

## 2. 备份

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
STAMP="<上一步输出的 STAMP>"

cp -R  "$P/node_modules/ds-bot" "$P/.ds-bot.pre-fork-$STAMP"
cp     "$P/package.json"        "$P/package.json.pre-fork"
cp     "$P/pnpm-lock.yaml"      "$P/pnpm-lock.yaml.pre-fork"
cp     "$P/cordis.patch.yml"    "$P/cordis.patch.yml.pre-fork-$STAMP"

ls -ld "$P/.ds-bot.pre-fork-$STAMP" "$P/package.json.pre-fork" "$P/pnpm-lock.yaml.pre-fork"
```

- `cordis.patch.yml` 不改，备份只是保险。
- **同一天重跑必须换 STAMP**（上面已用时间戳），否则 `cp -R` 会把新备份嵌进旧目录。
- 注意：`package.json.pre-fork` / `pnpm-lock.yaml.pre-fork` 是固定名，**第二次安装会覆盖第一次的备份**；若之前装过，先改名留档。

---

## 3. 切换 `ds-bot` 到 fork（`file:` 引用）

改一行：`~/.dsh/profiles/desktop/package.json`

```diff
-    "ds-bot": "0.2.0",
+    "ds-bot": "file:/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot",
```

核对是插件包目录（不是仓库根）：

```bash
ls /Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot/index.js
```

**推荐 `file:` + pnpm 正规安装，不用软链**：装的是冻结代码（磁盘现场已由第 1 节钉住干净）；快照式安装与 lock 一致；回滚就是恢复备份。
软链（`link:`）留作以后边改边联调的备选，格式同 profile 里的 `dsh-auto-reconnect`。

---

## 4. `cordis.patch.yml` 要不要动？**不用。**

- `provide` 是插件运行时导出（`export const provide = ['dsBotTeam','dsBotCards']` + `ctx.provide(...)`），不是清单声明项。
- 已核实 `cordis.patch.yml` / `cordis.yml` 无 ds-bot 条目；`dsh.profile.bundles` 已含 `ds-bot`。
- 复核命令：
  ```bash
  grep -n "ds-bot" "$HOME/.dsh/profiles/desktop/cordis.patch.yml" || echo "no ds-bot entries (expected)"
  grep -n '"ds-bot"' "$HOME/.dsh/profiles/desktop/package.json"
  ```

---

## 5. 安装（install 在前，copy 只做补救）

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
APP="/Applications/DeepSeek Harness.app"
PNPM="$APP/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"

cd "$P"
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" "$PNPM" install --no-frozen-lockfile
```

- 必须 `--no-frozen-lockfile`：`file:` 依赖会改 lockfile。
- **这条命令已修正**：不要用 `runtime/bin/node`（包装脚本，裸终端 127）。
- 安装会更新 `node_modules`；运行中的宿主已加载旧模块，**重启后才生效**。
- **安装期间不要刷新桌面窗口**（`client.js` 可能正在被替换）。
- **盯 pnpm 输出**：只应涉及 `ds-bot` 与 file: 的网关；若它要新增/删除/升级其它包，停止并以第 9 节回滚，再重试。

---

## 6. 安装后复核（先看 install 有没有把两文件带进来）

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
REPO="/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot"
GW="/Users/yidagege/Documents/deepseek-harness/default-workspace/dsh-plugin-mobile-gateway"

# ds-bot：确认装的是 fork，且 client.js 与源一致
grep -c "dsBotCards" "$P/node_modules/ds-bot/index.js"                    # 期望 >0
shasum -a 256 "$P/node_modules/ds-bot/client.js" "$REPO/ds-bot/client.js" # 期望哈希相同

# 网关：两文件是否随 install 同步进来
ls "$P/node_modules/dsh-plugin-mobile-gateway/lib/mobile-v1/" | grep -E "team-feed|card-frames"
```

两文件缺失时（**只有这时才 copy；copy 之后不要再跑 install**）：

```bash
P="$HOME/.dsh/profiles/desktop"
GW="/Users/yidagege/Documents/deepseek-harness/default-workspace/dsh-plugin-mobile-gateway"
cp "$GW/lib/mobile-v1/team-feed.mjs"   "$P/node_modules/dsh-plugin-mobile-gateway/lib/mobile-v1/"
cp "$GW/lib/mobile-v1/card-frames.mjs" "$P/node_modules/dsh-plugin-mobile-gateway/lib/mobile-v1/"
```

复核（复制与 install 都应满足）：

```bash
diff -rq "$P/node_modules/dsh-plugin-mobile-gateway" "$GW" 2>/dev/null \
  | grep -vE "Only in $GW(: \.git|: \.gitignore|: package-lock\.json|: pnpm-lock\.yaml|: test$)" || true
```

> 为什么两文件这么要紧：安装副本的 `lib/mobile-v1/index.mjs` 已静态 `import './team-feed.mjs'` 与 `'./card-frames.mjs'`，缺任一文件整个网关插件模块图加载失败（手机走不了 mobile-v1）。

---

## 7. 重启宿主（**用户手动**）

```bash
# 1) 退出（也可 Dock 右键退出）
osascript -e 'quit app "DeepSeek Harness"'

# 2) 确认主进程真的没了（列表为空才继续）
pgrep -fl "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" || echo "quit ok"

# 3) 重新打开
open -a "DeepSeek Harness"
```

重启影响：所有 Bot 对话中断；在途未保存的改动丢失。挑空档做。

---

## 8. 重启后确认服务真的起来了

**权威检查：`/info` 的能力位**（免鉴权：路由按 path 分发，`/info` 在 `access()` 鉴权之前返回；LAN 监听器的 HTTP 请求直接交给 mobile-v1 路由）。

```bash
curl -s http://127.0.0.1:3081/mobile/v1/info
```

**判读要点（别被字面骗）：**

| 字段 | 真实含义 |
|---|---|
| `team` / `cards` | **恒为 true**（网关装配 mobile-v1 时就创建了这两个对象），**不代表 ds-bot 服务在** |
| `teamDegraded` / `cardsDegraded` | 真正信号：`true` = 读不到 `dsBotTeam` / `dsBotCards`，网关在降级 |

**`*Degraded` 要等手机连过一次才可信**：服务绑定发生在首个订阅者 / 首次快照（客户端连上后网关才订阅）。所以三步走：

```bash
# 1) 刚重启、手机还没连：这里 teamDegraded:true 属正常，不作数
curl -s http://127.0.0.1:3081/mobile/v1/info

# 2) 让手机连一次（打开 App / 团队页），触发绑定

# 3) 再看，这时才是终态
curl -s http://127.0.0.1:3081/mobile/v1/info
```

期望终态：

```json
{ "protocolVersion": 1,
  "capabilities": { "team": true, "teamDegraded": false, "cards": true, "cardsDegraded": false } }
```

仍为 true 的排查顺序：① `grep -c dsBotCards node_modules/ds-bot/index.js` 是否 >0；② 宿主是否真重启；③ `/info` 是否 404/拒连（网关模块图断了，回第 6 节看两文件）；④ 都对仍降级 → 第 9 节回滚。

备选端口（3081 不通时）：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i "DeepSeek Harness\|node" | head
# curl -s http://127.0.0.1:<端口>/mobile/v1/info
```

---

## 9. 回滚（离线优先）

**离线也能回滚**：`nodeLinker: hoisted` 下 `node_modules/ds-bot` 是自包含真实目录，恢复它 + 两份清单即可启动；pnpm install 只是让元数据一致，联网再做。

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
STAMP="<安装时的 STAMP>"

# 主路径（离线可完成；之后用户手动重启一次）
rm -rf "$P/node_modules/ds-bot"
cp -R  "$P/.ds-bot.pre-fork-$STAMP" "$P/node_modules/ds-bot"
cp     "$P/package.json.pre-fork"     "$P/package.json"
cp     "$P/pnpm-lock.yaml.pre-fork"   "$P/pnpm-lock.yaml"

# 可选：联网时把 pnpm 元数据也拉回一致
APP="/Applications/DeepSeek Harness.app"
PNPM="$APP/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
cd "$P" && ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" "$PNPM" install --no-frozen-lockfile
```

- 回滚后同样需要**用户手动重启**一次。
- 网关那两文件**不用回滚**：registry 版 ds-bot 不发布服务，`/info` 手机连过后会显示 `*Degraded:true`；文件留着无副作用。
- 回滚生效判据：`grep -c "dsBotCards" node_modules/ds-bot/index.js` 为 `0`。

---

## 10. 故障排查

| 现象 | 先看什么 | 处理 |
|---|---|---|
| pnpm 命令 127 / `exec: : not found` | 用了 `runtime/bin/node` | 改用第 5 节 Electron-as-node 形式 |
| 宿主起不来 / 插件加载报错 | `ERR_MODULE_NOT_FOUND … team-feed.mjs` | 两文件没同步；第 6 节 copy（copy 后不要再 install） |
| `/info` 404 | 端口不对或 mobile-v1 未启用 | 第 8 节 `lsof` 找端口；确认 `mobileV1Enabled: true` |
| `/info` 200，`team/cards` true 但没数据 | 正常：这两个位恒 true | 手机连一次后再看 `*Degraded` |
| 手机连过后 `teamDegraded:true` | 服务没读到：没装 fork / 没重启 / 网关模块图断 | 第 8 节四步；必要时第 9 节回滚 |
| `cardsDegraded:true` 而 team 正常 | `dsBotCards` 没发布（任务 3 未装/未重启） | 核对 `grep dsBotCards node_modules/ds-bot/index.js` |
| 卡片不出现但 `cardsDegraded:false` | 没有待答卡，或手机端未订阅卡片流 | 桌面先发一张 ask_user，再刷新手机 |
| 想立刻回到装之前 | — | 第 9 节回滚 + 手动重启 |

---

## 11. 安装记录（执行时填）

| 项 | 值 |
|---|---|
| 时间 / STAMP | |
| ds-bot HEAD（装进去的 commit） | |
| 网关 HEAD（安装副本来源） | |
| install 是否改了其它包 | 否 / 是（哪些） |
| `/info` 终态（手机连过后） | teamDegraded=? cardsDegraded=? |
| 是否用过手工 copy 补救 | 否 / 是（哪两个文件） |
| 回滚（如发生）：时间与原因 | |
