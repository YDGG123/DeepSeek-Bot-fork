# 安装 / 回滚 Runbook（Chief 照着跑）

> 状态：**可复现操作手册**，由用户或 Chief 在终端手动执行。
> 日期：2026-10-24 · 事实均来自本机只读核查（profile 未改动）
> 红线：先备份、不乱删、可回滚；`~/.dsh/profiles/desktop/node_modules/ds-bot` 是正在跑的 Bot 团队宿主。

> **⚠️ 重启那一步不能由 Bot 自己跑**：关闭 App 会杀掉承载 Bot 的宿主进程，Bot 正在执行的命令会随之中断。
> `pnpm install` / copy / 备份这些可以代跑；**退出与重开 App 必须由用户手点/手动执行**。

---

## 0. 事实基线（已核实）

| 项 | 事实 |
|---|---|
| profile | `~/.dsh/profiles/desktop`（宿主进程参数里就是它） |
| 包管理器 | pnpm（`pnpm-lock.yaml` + `pnpm-workspace.yaml`：`packages: ['.']`、`nodeLinker: hoisted`），**PATH 里没有 pnpm** |
| 可直接用的 pnpm | 应用自带运行时：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node` + `.../runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs` |
| 现有依赖形态 | `ds-bot: "0.2.0"`（registry，实体目录）；`dsh-plugin-mobile-gateway: "file:…"`（同款先例，实体目录） |
| 插件注册 | `package.json` 的 `dsh.profile.bundles` 已含 `"ds-bot"`；`cordis.patch.yml` 里**没有** ds-bot 条目 |
| 网关安装副本差异 | 与工作区相比**只缺两个文件**：`lib/mobile-v1/team-feed.mjs`、`lib/mobile-v1/card-frames.mjs`（其余逐字节相同；已用 `diff -rq` 核实）。注意：副本的 `index.mjs` 已 `import` 这两个文件，**不补就加载失败** |
| fork 包目录 | `/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot`（含 `index.js`、`client.js`、`src/host/`） |

---

## 1. 备份（先做，失败即止）

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
STAMP=20261024

cp -R  "$P/node_modules/ds-bot" "$P/.ds-bot.pre-fork-$STAMP"
cp     "$P/package.json"        "$P/package.json.pre-fork"
cp     "$P/pnpm-lock.yaml"      "$P/pnpm-lock.yaml.pre-fork"
cp     "$P/cordis.patch.yml"    "$P/cordis.patch.yml.pre-fork-$STAMP"
ls -ld "$P/.ds-bot.pre-fork-$STAMP" "$P/package.json.pre-fork" "$P/pnpm-lock.yaml.pre-fork"
```

`cordis.patch.yml` 我们不改，备份只是保险（沿用已有 `.pre-*` 命名习惯）。

---

## 2. 切换 `ds-bot` 到 fork（`file:` 引用）

改一行：`~/.dsh/profiles/desktop/package.json`

```diff
-    "ds-bot": "0.2.0",
+    "ds-bot": "file:/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot",
```

核对是否为插件包目录（不是仓库根）：

```bash
ls /Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot/index.js
```

**推荐 `file:` + pnpm 正规安装，不用软链。** 理由：
1. 快照式安装：`node_modules` 里是一份自包含副本，与 `package.json`/lock 一致，回滚就是恢复三件备份；
2. 软链（`link:`）虽然改源码免重装，但 `node_modules` 与 lock 脱钩，出问题难界定"装的是哪份代码"；
3. 这次装的是**已冻结的提交**（`f8787c6`），装完不再改，不需要软链的迭代便利。
   （若之后要边改边联调，再单独评估把这一行换成 `link:`，格式与 `dsh-auto-reconnect` 相同。）

---

## 3. `cordis.patch.yml` 要不要动？**不用。**

- `provide` 是插件运行时导出（`index.js` 的 `export const provide = ['dsBotTeam','dsBotCards']` + `ctx.provide(...)`），不是 cordis 清单里的声明项；patch 文件只做 loader 的 id/config 覆盖。
- 已核实 `cordis.patch.yml` / `cordis.yml` 里没有任何 `ds-bot` 条目；`dsh.profile.bundles` 已列出 `ds-bot`，bundle 名不变。
- 验证命令（可选）：
  ```bash
  grep -n "ds-bot" "$HOME/.dsh/profiles/desktop/cordis.patch.yml" || echo "no ds-bot entries (expected)"
  grep -n '"ds-bot"' "$HOME/.dsh/profiles/desktop/package.json"
  ```

---

## 4. 网关侧同步两个新文件

安装副本里 `index.mjs` 已经 `import './team-feed.mjs'` 与 `'./card-frames.mjs'`，缺文件会在加载时报 `ERR_MODULE_NOT_FOUND`。

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
W="/Users/yidagege/Documents/deepseek-harness/default-workspace/dsh-plugin-mobile-gateway"

cp "$W/lib/mobile-v1/team-feed.mjs"   "$P/node_modules/dsh-plugin-mobile-gateway/lib/mobile-v1/"
cp "$W/lib/mobile-v1/card-frames.mjs" "$P/node_modules/dsh-plugin-mobile-gateway/lib/mobile-v1/"

# 复核：除仓库专属文件外不应再有差异
diff -rq "$P/node_modules/dsh-plugin-mobile-gateway" "$W" 2>/dev/null \
  | grep -vE "Only in $W(: \.git|: \.gitignore|: package-lock\.json|: pnpm-lock\.yaml|: test$)" || true
```

说明：`pnpm install` 有时会重新打包 `file:` 目录依赖、有时不会（取决于锁定快照）。所以**先 copy 再 install**，install 完再跑一次上面的 `diff`；若又出现缺文件，再 copy 一次即可。

---

## 5. 安装（用应用自带 node + pnpm，不依赖 PATH）

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"

cd "$P"
"$NODE" "$PNPM" install --no-frozen-lockfile
```

- 必须 `--no-frozen-lockfile`：`file:` 依赖会改 lockfile。
- 安装会更新 `node_modules`；正在运行的宿主已加载旧模块，**运行中不受影响，重启后才生效**。
- 安装后立即核对：
  ```bash
  P="$HOME/.dsh/profiles/desktop"
  W="/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot"
  grep -c "dsBotCards" "$P/node_modules/ds-bot/index.js"          # 期望 >0
  shasum -a 256 "$P/node_modules/ds-bot/client.js" "$W/client.js" # 期望两个哈希相同
  ls "$P/node_modules/dsh-plugin-mobile-gateway/lib/mobile-v1/" | grep -E "team-feed|card-frames"  # 期望两个都在
  ```

---

## 6. 重启宿主（**用户手动**）

```bash
# 1) 退出（也可以在 Dock 右键退出）
osascript -e 'quit app "DeepSeek Harness"'

# 2) 确认主进程真的没了（列表为空才继续）
pgrep -fl "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" || echo "quit ok"

# 3) 重新打开
open -a "DeepSeek Harness"
```

重启影响：所有 Bot 对话中断；在途未保存的改动丢失。挑空档做。

---

## 7. 重启后确认服务真的起来了

**权威检查：`/info` 的能力位**（免鉴权，已在代码里核实：`/info` 在 `access()` 之前返回）。

```bash
# LAN 监听（配置 lanPort: 3081，绑 0.0.0.0，loopback 可访问）
curl -s http://127.0.0.1:3081/mobile/v1/info
```

期望（修剪后）：

```json
{
  "protocolVersion": 1,
  "capabilities": {
    "team": true,
    "teamDegraded": false,
    "cards": true,
    "cardsDegraded": false
  }
}
```

判读：
- `team:false` / `cards:false` → ds-bot 的 `ctx.provide` 没起来（装错目录、宿主没重启、插件加载失败）。
- `teamDegraded:true` / `cardsDegraded:true` → 网关在降级（名册走旧投影、卡片走占位卡），说明服务没读到或读失败。

备选端口：若 3081 不通，用宿主自己的 WebUI 端口（可能每次不同）：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i "DeepSeek Harness\|node" | head
# 然后 curl -s http://127.0.0.1:<端口>/mobile/v1/info
```

其它交叉验证：
- 桌面群聊里让一个 Bot 调 `ask_user`：能弹卡 = 新 host 代码在跑。
- 手机团队页不再显示降级名册（activity 有值，不是全空）。
- 需要看 `/team`、`/cards` 的正文时要已配对设备的 Bearer token（`/info` 不需要）。

---

## 8. 回滚（一条命令块）

```bash
set -e
P="$HOME/.dsh/profiles/desktop"
STAMP=20261024

rm -rf "$P/node_modules/ds-bot"
cp -R  "$P/.ds-bot.pre-fork-$STAMP" "$P/node_modules/ds-bot"
cp     "$P/package.json.pre-fork"     "$P/package.json"
cp     "$P/pnpm-lock.yaml.pre-fork"   "$P/pnpm-lock.yaml"

NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
cd "$P" && "$NODE" "$PNPM" install --no-frozen-lockfile
```

- 回滚后同样需要**用户手动重启**一次。
- 网络不可用、pnpm 装不动时：停在第 2 步（目录+两份文件已恢复）。hoisted 布局下 `node_modules/ds-bot` 自包含，通常可直接启动。
- 回滚生效判据：`grep -c "dsBotCards" node_modules/ds-bot/index.js` 为 `0`，且 `/info` 里 `team:false, cards:false`。

---

## 9. 故障排查

| 现象 | 先看什么 | 处理 |
|---|---|---|
| 宿主起不来 / 插件加载报错 | `ERR_MODULE_NOT_FOUND … team-feed.mjs` | 第 4 节没做或 install 把它冲掉了，重新 copy |
| `/info` 404 | 端口不对或 mobile-v1 未启用 | 用第 7 节 `lsof` 找端口；确认 `cordis.patch.yml` 里 `mobileV1Enabled: true` |
| `/info` 200 但 `team:false` | ds-bot 是 registry 版或没重启 | 核对 `grep dsBotCards node_modules/ds-bot/index.js`；确认最后一步重启了 |
| `teamDegraded:true` | 网关读到了服务但快照失败 | 先回滚（第 8 节），重启后再查 ds-bot 诊断日志 |
| 卡片不出现但 `cards:true` | 手机端未订阅卡片流 / 没有待答卡 | 桌面先发一张 ask_user，再刷新手机 |
| 想立刻回到装之前 | — | 第 8 节回滚 + 手动重启 |
