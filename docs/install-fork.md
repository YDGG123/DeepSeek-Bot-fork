# 安装 DS Bot fork（DSH 插件管理器）

> 这是上游 [Fei2411/DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)（Apache-2.0）v0.3.6
> 的 fork：**上游 v0.3.6 + 四件自研**（群聊卡片 / 团队馈送 / 卡片馈送 / 群密钥卡）
> + 两处合并修复（群卡 text 透传、隐藏轮次卡片状态）。fork 自有版本线
> `0.3.6-fork.1`，避免与上游官方 tag 同名冲突。
>
> 依赖：DSH ≥ 0.2.1-rc.4（我们实测跑通的版本）。

## 方式一：GitHub 直装（推荐，一行粘贴）

在 DSH Desktop 的插件管理器里粘贴：

```
github:YDGG123/DeepSeek-Bot-fork#v0.3.6-fork.1&path:/ds-bot
```

`#v0.3.6-fork.1` 是版本 tag：带上它，DSH 的更新检查才知道当前装的是什么、
什么时候有新版。不要用 `#main`——分支名提不出版本号，更新检查会永远沉默。

## 方式二：.tgz 文件导入

从 [Releases](https://github.com/YDGG123/DeepSeek-Bot-fork/releases) 下载
`ds-bot-0.3.6-fork.1.tgz`，在插件管理器里导入该文件。适合 GitHub 直连不稳的环境。

## ⚠️ 千万不要用裸包名 `ds-bot` 安装

`sourceOf('ds-bot')` 返回 `kind: 'registry'`——DSH 会去 **npm** 装，拿到的是
**上游官方包**（npm 上的 `ds-bot` 是上游发布的，不是我们）。装出来没有四件自研，
而且后续更新检查也会一直走 npm。**只有 `github:…` 或 .tgz 两种方式装的是本 fork。**

## 更新机制说明

- `github:` 安装的更新检查只查本 fork 仓库的 Releases，**永远不会碰 npm**，
  不会被上游官方版覆盖。
- fork 的版本线是 `0.3.6-fork.N`（每次合并上游重标一行）；tag 与
  `ds-bot/package.json` 的 version 一致，更新比较才自洽。
- 想退回上游官方版：用裸包名 `ds-bot` 重装即可（反向操作，同理别混着用）。
