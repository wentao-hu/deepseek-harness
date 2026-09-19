/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  // 二次开发：配额判定提到状态码之前——公司网关把配额耗尽也渲染成 403，
  // 先判 401/403 会把「配额用完」误报成「key 失效」。
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b401\b/.test(message)) return 'AUTH'
  // 二次开发：403 是「已认证但无权访问」，与 401 的「认证失败」是两类问题，
  // 分开归类才能让网关的权限报错不被读成 key 失效。
  if (/\b403\b/.test(message)) return 'FORBIDDEN'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
 *   to non-retryable `PI_AI_ERROR` failures.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity recorded for durable replay.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
/**
 * 二次开发：模型替「本次用不到」的可选字段填的占位词。网关 strict 化后它无法省略字段，
 * 于是「不适用」以这些词的形式到达理由字段。
 */
const PLACEHOLDER_ARGUMENTS: readonly string[] = ['null', 'none', 'nil', 'undefined']

/**
 * 二次开发：沙箱提权的合法目标，与 `@deepseek-ai/dsh-sandbox` 的 `ESCALATION_TARGETS` 一致。
 * 合法空间封闭，而模型能编的词不封闭——所以提权目标只认白名单，枚举外的一律算「未提供」。
 * 起初用占位词黑名单，09-12 模型改填 `"require"` 就绕过了。
 */
const ESCALATION_TARGETS: readonly string[] = ['workspace-write', 'danger-full-access']

/**
 * 二次开发：沙箱提权字段（`@deepseek-ai/dsh-tool-bash`、`@deepseek-ai/dsh-tool-fs`
 * 与 pwsh 同族）。两者必须成对出现，所以清空目标时理由要一起清。
 */
const ESCALATION_ARGUMENTS: readonly string[] = ['sandbox_permissions', 'justification']

/**
 * Whether one argument is an explicit empty the model sent for an unused optional field.
 *
 * 二次开发：公司网关会强制给函数工具加 `"strict": true`，而 strict 模式要求每个属性都出现在
 * `required` 里。于是模型必须为「本次用不到」的可选字段填值——它只能填 `null`、空串，
 * 或在枚举受限时自己编一个词（`"null"`、`"require"`…）。对可选字段而言，这类值等同于「未提供」。
 * 判定只对提权字段收紧：别的字段上 `"null"` 可能是有意义的内容（例如 `edit` 要替换
 * 的字面量 `null`）。
 * @param key - the argument name, which decides whether a bogus word counts as empty.
 * @param value - one member of the model's parsed tool-call arguments.
 * @returns whether the member carries no usable value.
 */
function isBlankArgument(key: string, value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0) return true
  // 提权目标只认白名单：枚举外的任何词都是模型为「用不到」编的，不该进校验器
  if (key === 'sandbox_permissions') return !ESCALATION_TARGETS.includes(text)
  return ESCALATION_ARGUMENTS.includes(key) && PLACEHOLDER_ARGUMENTS.includes(text.toLowerCase())
}

/**
 * Drop blank members from one tool call's model-supplied arguments before they reach validation.
 *
 * 不剔除的话，harness 的参数校验会按 schema 拒绝这些值，报
 * `"sandbox_permissions" must be a string` / `must be one of [...]`，模型只能反复重试同一调用，
 * 每个 bash 调用白白多花两轮。只处理对象型参数；数组、标量与 `null` 本身原样保留。
 * 实际剔除时会向 stderr 打一行诊断，便于定位是哪个工具的哪些字段被清理。
 * @param name - tool name, for the diagnostic line.
 * @param args - the parsed arguments object pi-ai handed back.
 * @returns the arguments with blank members removed, or the input unchanged when nothing was blank.
 */
function withoutBlankArguments(name: string, args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const record = args as Record<string, unknown>
  // 提权目标被判空时，配对的 justification 必须一起丢：校验器要求两者同时出现
  // （`validateEscalationArgs`），留下孤立的理由只是换一个报错。
  const escalationCleared = 'sandbox_permissions' in record
    && isBlankArgument('sandbox_permissions', record['sandbox_permissions'])
  const isDropped = ([key, value]: [string, unknown]): boolean =>
    isBlankArgument(key, value) || (escalationCleared && key === 'justification')
  const entries = Object.entries(record)
  const dropped = entries.filter(isDropped).map(([key]) => key)
  if (dropped.length === 0) return args
  process.stderr.write(`dsh: dropped blank tool arguments for ${name}: ${dropped.join(', ')}\n`)
  return Object.fromEntries(entries.filter(entry => !isDropped(entry)))
}

export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(withoutBlankArguments(event.toolCall.name, event.toolCall.arguments)),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
