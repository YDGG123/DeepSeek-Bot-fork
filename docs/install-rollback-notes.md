# 安装 / 回滚素材（ds-bot fork → desktop profile）

> 状态：**素材清单，脚本由用户手动执行**。团队不代跑、不动正在运行的安装。
> 日期：2026-10-24 · 依据本机实际 profile（只读核查）
> 红线：`~/.dsh/profiles/desktop` 里正在跑的 ds-bot 是 Bot 团队的宿主，任何写入都要先备份、可一键回滚。

---

## 1. 挂载方式（`file:` 引用）

**要改的一处**：`~/.dsh/profiles/desktop/package.json` 的 `dependencies`

```diff
-    "ds-bot": "0.2.0",
+    "ds-bot": "file:/Users/yidagege/Documents/deepseek-harness/default-workspace/ds-bot/ds-bot",
```

依据与检查：
- profile 的包管理器是 **pnpm**（有 `pnpm-lock.yaml`、`pnpm-workspace.yaml`；`packages: ['.']`、`nodeLinker: hoisted`）。
- 同 profile 里 `dsh-plugin-mobile-gateway` 已经是 `file:` 引用（package.json 第 14 行），这是同一套先例。
- `dsh.profile.bundles` 里已有 `"ds-bot"`，**不用改**（bundle 名不变）。
- `cordis.patch.yml` 里**没有** ds-bot 相关条目（已 grep 确认），不用动。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里有 `ds-bot@0.2.0`，切到 `file:` 后这行无害，可留可删。
- 指向的目录必须是 **`ds-bot/ds-bot/`**（插件包目录，内有 `package.json` + `index.js` + `client.js`），不是仓库根（根目录是 `app/` + `ds-bot/`）。

可选：若想让源码改动**免重装**即时生效，把 `file:` 换成 `link:`（同 profile 的 `dsh-auto-reconnect` 就是这么挂的）。代价是 pnpm 只建软链、不做安装快照；仍是**重启宿主**后才加载。

---

## 2. 安装前备份

```bash
P=~/.dsh/profiles/desktop
cp -R  "$P/node_modules/ds-bot" "$P/.ds-bot.pre-fork"
cp     "$P/package.json"        "$P/package.json.pre-fork"
cp     "$P/pnpm-lock.yaml"      "$P/pnpm-lock.yaml.pre-fork"
```

- 先例：profile 里已有 `.ds-bot.pre-bridge`、`package.json.pre-bridge`、`pnpm-lock.yaml.pre-bridge`，沿用同样命名风格。
- `node_modules` 是 hoisted，`node_modules/ds-bot` 是真实目录（不是软链），整目录备份即可独立回滚。
- 备份后再改 `package.json`。

---

## 3. 安装

```bash
P=~/.dsh/profiles/desktop
cd "$P"
# pnpm 不在 PATH 时（本机没装 pnpm）：用 npx 拉一个，或 corepack
npx --yes pnpm@9 install --no-frozen-lockfile
```

说明：
- 必须 `--no-frozen-lockfile`：`file:` 依赖会改 lockfile。
- 本机没有全局 pnpm；Node 22 那份 tarball 自带 corepack，也可 `corepack pnpm@9 install`。
- 装完检查（只读）：
  ```bash
  ls "$P/node_modules/ds-bot/index.js" "$P/node_modules/ds-bot/client.js"
  grep -c "dsBotCards" "$P/node_modules/ds-bot/index.js"   # >0 表示装的是 fork
  ```

---

## 4. 回滚（一键）

```bash
P=~/.dsh/profiles/desktop
rm -rf "$P/node_modules/ds-bot"
cp -R  "$P/.ds-bot.pre-fork" "$P/node_modules/ds-bot"
cp     "$P/package.json.pre-fork"   "$P/package.json"
cp     "$P/pnpm-lock.yaml.pre-fork" "$P/pnpm-lock.yaml"
cd "$P" && npx --yes pnpm@9 install --no-frozen-lockfile
```

- 先恢复目录 + 包清单再 install，保证 lock 与 node_modules 一致。
- 若网络不可用、pnpm 装不动：直接停在第 2 步（目录与 package.json 已恢复），hoisted 布局下 `node_modules/ds-bot` 自包含，通常可直接启动。
- 回滚后检查：`node_modules/ds-bot/index.js` 里不应再有 `dsBotCards`。

---

## 5. 装完要重启宿主吗？

**要，必须整个重启 DSH Desktop（不是刷新窗口）。**

理由（都已核实）：
- `ctx.provide('dsBotTeam' / 'dsBotCards', …)` 在插件 `apply` 时注册；网关的 `optionalService(ctx, 'dsBotCards')` 只在启动后拿到对象，热更新不会重新 apply。
- 宿主启动时加载插件目录与 `client.js`；只刷新浏览器窗口会继续用旧模块缓存。
- 重启用时提醒：**会打断所有 Bot 对话**，在途未保存的改动会丢——挑空档。

---

## 6. 重启后验收（联调当天对照）

1. 网关日志出现 `subscribed dsBotTeam (instanceId=…)` 与 `subscribed dsBotCards (instanceId=…)`（不再出现 `did not publish` / 占位卡 `degraded`）。
2. 手机团队页：主 Bot 在最上、Bots 与群聊混排、成员状态（在干活/等你回答/等你审批）出现——不再是降级名册。
3. 桌面里发一张 ask_user 卡（own chat），手机 5 秒内出现同一张卡（`card.shown`），手机作答后桌面问题卡关闭、手机显示已答。
4. 群聊里让一个成员问一张卡：手机团队页群行有「等你回答」，作答后群日志出现 `kind:'answer'` 行、提问者继续发言。
5. 若以上都不对：先看网关日志是 `degraded` 还是订阅失败，再按第 4 节回滚。
