// 导出「头像/颜色一致性」对拍夹具（给 dsh-mobile 的 RosterLookParityTests 用）。
//
// 字段口径（两端必须一致，QA 独立复算时按同一输入）：
//   hostColor   —— roster 实际下发的 color（ink key 或自定义 hex）
//   hostHex     —— 电脑端**浅色**渲染值：ink key → INKS[k][0]；hex 原样
//   darkHostHex —— 电脑端**深色**渲染值：ink key → INKS[k][1]；hex 原样（styles.js:23-24）
//   hostShape   —— lookOf(bot).shape：存值优先，缺省按 bot id 推导
//   INKS 段：
//     lightHex/darkHex = INKS[k][0] / INKS[k][1]
//     lightInk/darkInk = accentInk(该 hex) 的结果（themes.js:36，白 or #141414）
// 产物是 Swift 字面量，直接粘进 RosterLookParityTests 的夹具数组。
//
// 两边同源：这里直接调用电脑端渲染与 roster 共用的 `lookOf()`，
// 输出的 hostShape / hostColor 就是手机端从 roster 收到、且**不得自行推导**的值。
//
// 用法（本机 node 版本过旧，用 Electron 当 node）：
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
//     scripts/export-roster-look-fixture.mjs
import { lookOf } from '../src/client/characters.js'
import { INKS } from '../src/client/inks.js'
import { accentInk } from '../src/client/themes.js'

const ids = ['a', 'b', 'c', 'chief', 'coder', 'tester', 'bot-1', 'bot-42']
const rows = []

// 1) 19 个 ink key 全覆盖：显式选色、没有存 shape → shape 仍按 id 推导
for (const key of Object.keys(INKS)) {
  const id = `ink-${key}`
  const look = lookOf({ id, name: `Ink ${key}`, color: key })
  rows.push({ id, name: `Ink ${key}`, storedShape: null, storedColor: key, hostShape: look.shape, hostColor: look.color })
}

// 2) 什么也没存：shape 与 color 都按 bot id 稳定推导
for (const id of ids) {
  const look = lookOf({ id, name: `Bot ${id}` })
  rows.push({ id, name: `Bot ${id}`, storedShape: null, storedColor: null, hostShape: look.shape, hostColor: look.color })
}

// 3) 存了 shape / hex 颜色：存值优先
for (const [id, shape, color] of [['s1', 'star', '#123456'], ['s2', 'acorn', 'magenta']]) {
  const look = lookOf({ id, name: `Stored ${id}`, avatar: { shape }, color })
  rows.push({ id, name: `Stored ${id}`, storedShape: shape, storedColor: color, hostShape: look.shape, hostColor: look.color })
}

// 电脑端渲染用的实际 hex（ink key 取 INKS[key][0]；hex 原样）。
// Swift 侧断言的是「App 的色板与这块 hex 逐值相同」，不是和自己的表互比。
const lightHexOf = color => (color.startsWith('#') ? color : INKS[color][0])
// 深色档：电脑端 styles.js:23-24 走 INKS[k][1]（自定义 hex 不变）。
const darkHexOf = color => (color.startsWith('#') ? color : INKS[color][1])

const q = value => (value === null ? 'nil' : `"${value}"`)
const body = rows
  .map(r => `            .init(id: "${r.id}", name: "${r.name}", storedShape: ${q(r.storedShape)}, storedColor: ${q(r.storedColor)}, hostShape: "${r.hostShape}", hostColor: "${r.hostColor}", hostHex: "${lightHexOf(r.hostColor)}", darkHostHex: "${darkHexOf(r.hostColor)}"),`)
  .join('\n')
const inkRows = Object.keys(INKS)
  .map(key => `            .init(key: "${key}", lightHex: "${INKS[key][0]}", darkHex: "${INKS[key][1]}", lightInk: "${accentInk(INKS[key][0])}", darkInk: "${accentInk(INKS[key][1])}"),`)
  .join('\n')
process.stdout.write(`---ROWS---\n${body}\n---INKS---\n${inkRows}\n`)
process.stderr.write(`rows=${rows.length}\n`)
