# 上游合并冻结坐标（2026-10-25）

> 分发走 dsh-suite 文件拷贝（无远端 fork 仓库），本文件是攒批出包时 sync 的依据。
> 分支：`integration/upstream-0.2.1`，工作区干净（`git status --porcelain` 为空）。

## 冻结点

| 项 | 值 |
|---|---|
| **ds-bot 侧冻结点（全 sha）** | `dcc2a44ded5ded567deb638ed3bea2c419713b71` |
| 合并本体 | `03a2764` = Merge upstream 0.2.1 (`1bebe826f74e9a72cabafd3b80602b05af867b38`) |
| 上游基线 | Fei2411/DeepSeek-Bot `1bebe82`（v0.2.1），merge-base `ae63b45`（v0.2.0） |
| 冻结前最后自研提交 | `e19eda8`（glyph.layers 结构化，方案 C 发布端） |
| 版本号 | `0.2.1`（跟上游） |

## 攒批出包时 dsh-suite 侧的取用

- `sync-from-dev.sh --dsbot <本仓库>/ds-bot`（源目录 = 本仓库的 `ds-bot/` 子目录）。
- sync 前置：本树干净、HEAD == 冻结点（`git rev-parse HEAD` 核对）。
- 装入判据沿用 install.sh 的存在性检查：`dsBotCards` / `teamFeed` 必须在 `src/host`。

## 这批相对上一个冻结点（`0119db0` 之后的链）带来的变化

1. **上游 0.2.1 全量合入**（62 个非 merge 提交）：show_view v2（chart/公式输入/沙箱 html/submit、
   `checkShownView` 新返回结构、按发送字节计量）、群 relay 暂停（`relayLimit`）、
   secrets purpose 可编辑 + blocked 状态机、btw、桌面 App 壳一批、Linux 打包。
2. **冲突判法与暗雷**：7 文件 11 块全部按 Chief 批的判法解；三暗雷
   （secret-update 双路径、blocked×群卡回滚、letter-key×card-hold）人工核闭。
3. **合并后增量**（4 个提交，全部已过 QA 复核）：
   `21382b9`（测试跟随 show_view v2 文案）、`72f5717`+`3fafb81`（viewText 压平上游新组件，
   群 view 卡投影不再丢内容）、`dcc2a44`（lint error 修复 + glyph 同源断言改逐层拷贝比较）。
4. **glyph 头像二期**（发布端）在本链内：`276b146`（glyph 字段）+ `e19eda8`（layers 结构化）。
   手机端绘制契约：`glyph = { shape, color, size, path, layers: [{d, fill, opacity}], eyes }`。

## 闸门终读（冻结时点）

- `npm test`（Electron-as-node）：**989 例 / 987 pass / 0 fail / 2 skip，exit 0**
- lint：**0 错误 / 12 警告**（全为既有基线）
- `scripts/build-client.mjs --check`：exit 0（client.js 为 `72f5717` 后重建产物）

## 遗留与待证明

- **glyph path 内容对比**钉在 iOS 侧夹具（RosterLookParityTests）：本机无 iOS 平台，
  等 CI 或真机给最终证明（QA 复核时的裁决，见 team-feed 的逐字段同源断言）。
- 推送：无 fork 远端，**仅本地冻结**；若日后建 `DeepSeek-Bot-fork` 公开仓，
  本分支可直接 `git push <fork> integration/upstream-0.2.1`（直连 github.com 可用，
  gh-proxy 的 fetch 通道实测不通）。本地 `upstream` remote 指官方仓库，注意勿误推。
