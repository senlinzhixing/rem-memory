/**
 * 通用的一次性模型调用：`ctx.llm` 只有流式接口，这里聚合成完整文本。
 * C2 叙事、C3 抽取、保真度考试都复用这一个入口。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export interface LlmRoute {
  provider: string
  model: string
}

export interface CompleteInput {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

export interface CompleteResult {
  text: string
  usage?: { inputTokens: number; outputTokens: number }
  /** 提供方结束原因，`length` 表示输出被 maxTokens 截断。 */
  finish?: string
}

export async function completeText(
  ctx: Context,
  route: LlmRoute,
  input: CompleteInput,
  signal?: AbortSignal,
): Promise<CompleteResult> {
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    system: input.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
    temperature: input.temperature ?? 0,
    maxTokens: input.maxTokens ?? 800,
    signal,
  }

  let text = ''
  let usage: CompleteResult['usage']
  let finish: string | undefined
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason?.kind
    }
  }

  return { text, usage, finish }
}

/** 剥掉代码块、取第一个 `{` 到最后一个 `}`，容忍模型前后的解释文字。 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (error) {
    throw new Error(`JSON 解析失败：${String(error)}`)
  }
}

export interface JsonResult {
  value: unknown
  raw: string
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * 要 JSON 的调用：首次解析失败时，把原输出交给模型做一次"修复重试"。
 * 仍失败则抛出带原始片段的错误，便于定位是模型跑偏还是提示词问题。
 */
export async function completeJson(
  ctx: Context,
  route: LlmRoute,
  input: CompleteInput,
  signal?: AbortSignal,
): Promise<JsonResult> {
  const first = await completeText(ctx, route, input, signal)
  try {
    return { value: extractJson(first.text), raw: first.text, usage: first.usage }
  } catch {
    const truncated = first.finish === 'length' || first.text.trim().length === 0
    const repairInput: CompleteInput = truncated
      // 输出被截断/为空：用更大的预算重发原请求，而不是让模型“修复”半句话。
      ? { ...input, maxTokens: Math.max(input.maxTokens ?? 800, 1200) * 2 }
      // 有内容但格式不对：只回传这段坏 JSON，让它补全，不再重复整段原文。
      : {
          system: input.system,
          user: `下面是一段不完整或不合法的 JSON 输出：\n${first.text.slice(0, 6000)}\n\n请补全并只输出合法 JSON 对象。`,
          maxTokens: Math.max(input.maxTokens ?? 800, 2000),
          temperature: 0,
        }

    const repair = await completeText(ctx, route, repairInput, signal)
    try {
      return { value: extractJson(repair.text), raw: repair.text, usage: mergeUsage(first.usage, repair.usage) }
    } catch {
      throw new Error(
        `模型未返回合法 JSON（首次 finish=${first.finish ?? 'unknown'}）。`
        + `首次输出：${first.text.slice(0, 200)}；修复输出：${repair.text.slice(0, 200)}`,
      )
    }
  }
}

function mergeUsage(
  a?: { inputTokens: number; outputTokens: number },
  b?: { inputTokens: number; outputTokens: number },
) {
  if (!a) return b
  if (!b) return a
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
