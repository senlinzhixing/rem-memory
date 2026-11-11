/**
 * P1-3 · C2 叙事
 *
 * 把一段 C1 文本交给 `ctx.llm`，压成结构化 JSON。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  asRecord,
  asString,
  asStringArray,
  completeJson,
  extractJson,
  type LlmRoute,
} from '../llm/complete'

export type { LlmRoute }

export interface Narrative {
  goal: string
  actions: string[]
  result: string
  decisions: string[]
  failures: string[]
}

export interface NarrateResult {
  narrative: Narrative
  raw: string
  inputChars: number
  truncated: boolean
  usage?: { inputTokens: number; outputTokens: number }
}

const MAX_INPUT_CHARS = 24_000

const SYSTEM_PROMPT = `你是一个记忆压缩器。把一段编码 agent 的会话流水账压成结构化叙事。

只输出 JSON 对象，不要解释，不要 markdown 代码块。字段：
- goal: 一句话说明用户想要什么（不超过 40 字）
- actions: 最多 6 条，每条不超过 20 字，动词开头
- result: 一句话说明最终结果（不超过 50 字）
- decisions: 明确的取舍及其原因，可为空数组
- failures: 真实发生的错误，可为空数组

规则：
- 不要编造文件名、命令、数字；不确定就省略。
- 输出语言与输入一致。
- 只描述这段会话，不要补充背景知识。`

export async function narrate(
  ctx: Context,
  route: LlmRoute,
  input: string,
  signal?: AbortSignal,
): Promise<NarrateResult> {
  const window = selectWindow(input, MAX_INPUT_CHARS)
  const result = await completeJson(ctx, route, {
    system: SYSTEM_PROMPT,
    user: window.text,
    maxTokens: 1600,
  }, signal)

  return {
    narrative: narrativeFrom(result.value),
    raw: result.raw,
    inputChars: input.length,
    truncated: window.truncated,
    usage: result.usage,
  }
}

export function parseNarrative(raw: string): Narrative {
  return narrativeFrom(extractJson(raw))
}

export function narrativeFrom(value: unknown): Narrative {
  const record = asRecord(value)
  return {
    goal: asString(record.goal),
    actions: asStringArray(record.actions).slice(0, 6),
    result: asString(record.result),
    decisions: asStringArray(record.decisions).slice(0, 6),
    failures: asStringArray(record.failures).slice(0, 6),
  }
}

/** 把叙事渲染成纯文本，供保真度考试出题使用。 */
export function narrativeText(narrative: Narrative): string {
  return [
    narrative.goal ? `目标：${narrative.goal}` : '',
    narrative.actions.length > 0 ? `动作：${narrative.actions.join('；')}` : '',
    narrative.result ? `结果：${narrative.result}` : '',
    narrative.decisions.length > 0 ? `决定：${narrative.decisions.join('；')}` : '',
    narrative.failures.length > 0 ? `失败：${narrative.failures.join('；')}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * 只含"持久要点"的文本：决策理由 + 失败教训。
 * 保真度考试用它出题，避免问到本次运行结果、版本号、数量等一次性状态。
 */
export function durableNarrativeText(narrative: Narrative): string {
  return [
    narrative.decisions.length > 0 ? `决策：${narrative.decisions.join('；')}` : '',
    narrative.failures.length > 0 ? `失败：${narrative.failures.join('；')}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * 头尾取样：长会话的结论通常在末尾，只截头部会让模型看不到实际结果。
 * 超出上限时保留前 40% 与后 60%，中间标注省略量。
 */
export function selectWindow(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  const headSize = Math.floor(limit * 0.4)
  const tailSize = limit - headSize
  const omitted = text.length - headSize - tailSize
  return {
    text: `${text.slice(0, headSize)}\n…（中间省略 ${omitted} 字符）…\n${text.slice(-tailSize)}`,
    truncated: true,
  }
}
