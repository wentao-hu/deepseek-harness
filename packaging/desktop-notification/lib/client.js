/**
 * 桌面通知插件（浏览器半）。
 *
 * 订阅每个会话的事件流，把新到达的 `turn/end` 变成 Electron 原生通知，
 * 只在窗口不在前台时打扰用户。判断只认 `change.kind === 'append'` 的增量：
 * 打开历史走 `replace`、向前翻页走 `prepend`、重连基线走 `replace`，
 * 因此回看旧会话不会重复弹通知。
 *
 * 这个文件是手写的客户端 bundle，`window.__ModuleLoader__.load` 的包装由
 * client-modules 的加载协议约定；factory 内不 require 任何模块，全部逻辑
 * 只用浏览器 API 与会话事件数据。
 */
window.__ModuleLoader__.load({
	id: 'dsh-desktop-notification',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		/** 回合结束原因到提示语的映射；未知原因回退到通用文案。 */
		const REASONS = {
			completed: '已完成',
			aborted: '已中断',
			error: '出错',
			blocked: '被拦下',
			'max-tokens': '达到输出上限',
		}

		/** 首次启用确认的记账键；只在确认通知真的显示过之后才写入。 */
		const ANNOUNCED_KEY = 'dsh-desktop-notification:announced'

		/** 已订阅事件流的会话：sessionId -> 取消订阅函数。 */
		const watched = new Map()

		/** 把一次 turn/end 的数据翻成通知正文。 */
		function bodyOf(data) {
			const turn = typeof data?.turn === 'number' ? `第 ${data.turn} 回合` : '回合'
			return turn + (REASONS[data?.reason?.kind] ?? '已结束')
		}

		/** 弹出通知；窗口在前台时不打扰，同一会话的通知互相替换而不是堆叠。 */
		function raise(ctx, sessionId, data) {
			if (Notification.permission === 'denied') return
			if (typeof document !== 'undefined' && document.hasFocus()) return
			const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
			const notification = new Notification(summary?.displayTitle ?? 'DeepSeek Harness', {
				body: bodyOf(data),
				tag: sessionId,
			})
			notification.onclick = () => { window.focus() }
		}

		/**
		 * 首次加载时弹一条确认通知。
		 *
		 * macOS 只在应用第一次成功发出通知后，才把它登记进「系统设置 → 通知」。
		 * 本插件平时只在窗口失焦时打扰，用户盯着窗口等结果就永远触发不了这个
		 * 第一次，设置里也就一直看不到本应用。这里补上那一次确认。
		 * 只有通知真的显示过才记账（onshow），否则下次启动再试。
		 */
		function announceOnce() {
			if (Notification.permission === 'denied') return
			try {
				if (localStorage.getItem(ANNOUNCED_KEY) !== null) return
			} catch {
				// localStorage 不可用（隐私模式等）时无法记账，跳过确认以免每次启动都弹。
				return
			}
			const notification = new Notification('DeepSeek Harness 通知已启用', {
				body: '任务跑完且窗口不在前台时会在这里提醒你',
			})
			notification.onshow = () => {
				try { localStorage.setItem(ANNOUNCED_KEY, '1') } catch { /* 记账失败只导致下次启动重复提示一次 */ }
			}
		}

		/** 检查一次事件窗口增量，对其中每个 turn/end 发通知。 */
		function inspect(ctx, sessionId, eventWindow) {
			if (eventWindow.change.kind !== 'append') return
			for (const entry of eventWindow.change.entries) {
				if (entry.type !== 'event' || entry.event.type !== 'turn/end') continue
				raise(ctx, sessionId, entry.event.data)
			}
		}

		/** 让订阅集合跟上会话列表：新会话建立订阅，消失的会话拆掉订阅。 */
		function sync(ctx) {
			const state = ctx.sessions.list.getSnapshot()
			const live = new Set(state.ids)
			for (const id of live) {
				if (watched.has(id)) continue
				const binding = ctx.sessions.binding(id)
				if (binding === undefined) continue
				watched.set(id, binding.eventSource.subscribe(() => {
					inspect(ctx, id, binding.eventSource.getSnapshot())
				}))
			}
			for (const [id, dispose] of watched) {
				if (live.has(id)) continue
				dispose()
				watched.delete(id)
			}
		}

		/** 浏览器插件主体。 */
		function apply(ctx) {
			if (typeof Notification === 'undefined') return
			if (Notification.permission === 'default') void Notification.requestPermission()
			announceOnce()
			ctx.effect(() => {
				sync(ctx)
				const stop = ctx.sessions.list.subscribe(() => { sync(ctx) })
				return () => {
					stop()
					for (const dispose of watched.values()) dispose()
					watched.clear()
				}
			}, 'desktop-notification: watch session turn ends')
		}

		exports.inject = ['sessions']
		exports.apply = apply
		return module.exports
	}
})
