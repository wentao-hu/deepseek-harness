/**
 * 浏览器半的行为测试：在 Node 里模拟 client-modules 的加载协议与一个假 ctx，
 * 驱动 lib/client.js 走完「订阅会话 → 收到 turn/end → 弹通知」的路径。
 *
 * 运行：node tests/browser-half.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

let registered
const shown = []
let focused = false

class FakeNotification {
  static permission = 'granted'
  constructor(title, options) {
    this.title = title
    this.options = options
    this.onshow = undefined
    shown.push(this)
    // 真实通知在显示后回调 onshow；用微任务模拟，让记账断言可等待。
    queueMicrotask(() => { this.onshow?.() })
  }
}

/** 假的 localStorage，用来观察「首次启用确认」的记账行为。 */
const storage = new Map()

globalThis.Notification = FakeNotification
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, value) },
}
globalThis.document = { hasFocus: () => focused }
globalThis.window = {
  __ModuleLoader__: { load: entry => { registered = entry } },
  focus: () => { focused = true },
}

vm.runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: BUNDLE })

/** 断言并打印一行结果。 */
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) process.exitCode = 1
}

check('bundle 注册了条目', registered !== undefined)
check('注册 id 为 dsh-desktop-notification', registered?.id === 'dsh-desktop-notification')

const required = []
const plugin = registered.factory((name) => {
  required.push(name)
  throw new Error(`不应 require ${name}`)
})
check('factory 不 require 任何模块', required.length === 0)
check('导出 inject = [sessions]', JSON.stringify(plugin.inject) === '["sessions"]')
check('导出 apply 函数', typeof plugin.apply === 'function')

/** 造一个带事件窗口与订阅集合的假会话。 */
function makeSession(id, displayTitle) {
  const subscribers = new Set()
  const session = {
    displayTitle,
    window: { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } },
    /** 发布一次窗口增量并同步通知订阅者。 */
    emit(change) {
      session.window = { ...session.window, change, revision: session.window.revision + 1 }
      for (const notify of [...subscribers]) notify()
    },
  }
  session.source = {
    getSnapshot: () => session.window,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn) },
  }
  session.subscriberCount = () => subscribers.size
  return session
}

const alpha = makeSession('s-alpha', '部署脚本排查')
const bindings = new Map([['s-alpha', { eventSource: alpha.source }]])
const effects = []
const listSubscribers = new Set()

const ctx = {
  sessions: {
    list: {
      getSnapshot: () => ({
        ids: [...bindings.keys()],
        byId: Object.fromEntries([...bindings.keys()].map(id => [id, { displayTitle: alpha.displayTitle }])),
      }),
      subscribe: (fn) => { listSubscribers.add(fn); return () => listSubscribers.delete(fn) },
    },
    binding: id => bindings.get(id),
  },
  effect: (fn, label) => { effects.push({ label, dispose: fn() }) },
}

/** 造一条 turn/end 追加增量。 */
const turnEnd = (turn, kind) => ({
  kind: 'append',
  entries: [{ type: 'event', event: { type: 'turn/end', seq: turn, time: 0, data: { turn, reason: { kind } } } }],
})

plugin.apply(ctx)
check('apply 注册了 effect', effects.length === 1)
check('订阅了列表中的会话', alpha.subscriberCount() === 1)

await Promise.resolve()
check('首次加载弹出启用确认', shown[0]?.title === 'DeepSeek Harness 通知已启用')
check('确认显示后才记账', storage.get('dsh-desktop-notification:announced') === '1')

// 后续断言只看真实回合通知，把确认那一条从计数里清掉。
shown.length = 0

plugin.apply(ctx)
await Promise.resolve()
check('已记账后不再重复确认', shown.length === 0)

alpha.emit(turnEnd(3, 'completed'))
check('失焦时 turn/end 弹出 1 条通知', shown.length === 1)
check('通知标题取会话标题', shown[0]?.title === '部署脚本排查')
check('通知正文含回合号与结果', shown[0]?.options?.body === '第 3 回合已完成')
check('通知按 sessionId 打 tag 去重', shown[0]?.options?.tag === 's-alpha')

focused = true
alpha.emit(turnEnd(4, 'completed'))
check('窗口聚焦时不弹通知', shown.length === 1)
focused = false

alpha.emit({ kind: 'replace', entries: turnEnd(1, 'completed').entries })
alpha.emit({ kind: 'prepend', entries: turnEnd(1, 'completed').entries })
check('历史回填/向前翻页不弹通知', shown.length === 1)

alpha.emit({
  kind: 'append',
  entries: [
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 11, time: 0, data: {} } },
    { type: 'event', event: { type: 'step/end', seq: 12, time: 0, data: {} } },
  ],
})
check('其它事件类型不弹通知', shown.length === 1)

alpha.emit(turnEnd(5, 'aborted'))
check('中断收尾也通知且文案区分', shown[1]?.options?.body === '第 5 回合已中断')

bindings.delete('s-alpha')
for (const notify of [...listSubscribers]) notify()
check('会话消失后退订', alpha.subscriberCount() === 0)

for (const effect of effects) effect.dispose()
check('effect 清理后无列表订阅', listSubscribers.size === 0)

console.log(process.exitCode === 1 ? '\n存在失败项' : '\n全部通过')
