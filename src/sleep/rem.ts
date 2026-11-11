/**
 * P3 · REM 联想
 *
 * 从现有卡片里找“远距离但可能相关”的组合，生成可验证假设。
 * 产物一律 status='pending' + 低权重，不进简报、不进检索，必须人工 review。
 */
import type { Context } from '@deepseek-ai/cordis'
import { asNumber, asRecord, asString, clamp01, completeJson, type LlmRoute } from '../llm/complete'
import { nextCardId, type MemoryCard } from '../compress/c3'

const SYSTEM_PROMPT = `你是一个联想器。给定编号的记忆卡列表，找出 1–3 对在真实工作中可能同源、互为因果或互相解释的卡片，提出可验证的假设。

只输出 JSON 对象，不要解释：
{"hypotheses":[{"a":1,"b":4,"title":"不超过 30 字的短标题","text":"一句可验证的假设","confidence":0.0}]}

规则：
- a、b 只能填列表中出现的编号（整数）。
- title 与 text 不要重复：title 是标签，text 是具体假设。
- 假设要具体到“下次遇到 X 时，可以验证 Y”。
- 不要在输出里引用卡片 id、编号或文件路径。
- 没有可靠连接就返回空数组，不要凑数。
- confidence 取 0–1，保守。`

export async function runRem(
  ctx: Context,
  route: LlmRoute,
  cards: readonly MemoryCard[],
  signal?: AbortSignal,
): Promise<MemoryCard[]> {
  const pool = [...cards]
    .filter(card => card.status === 'active')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
  if (pool.length < 4) return []

  const listing = pool
    .map((card, index) => `${index + 1}. [${card.type}] ${card.title}｜${card.conclusion.slice(0, 60)}`)
    .join('\n')

  const resolve = (value: unknown): MemoryCard | undefined => {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(n) || n < 1 || n > pool.length) return undefined
    return pool[n - 1]
  }

  const result = await completeJson(ctx, route, {
    system: SYSTEM_PROMPT,
    user: `记忆卡：\n${listing}`,
    maxTokens: 3000,
  }, signal)

  const record = asRecord(result.value)
  const items = Array.isArray(record.hypotheses) ? record.hypotheses : []
  const created: MemoryCard[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const entry = asRecord(item)
    const a = resolve(entry.a)
    const b = resolve(entry.b)
    const text = asString(entry.text)
    const title = asString(entry.title) || text.slice(0, 40)
    if (!a || !b || !text || a.id === b.id) continue
    const key = [a.id, b.id].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)

    created.push({
      id: nextCardId(),
      type: 'hypothesis',
      status: 'pending',
      scope: 'global',
      title: title.slice(0, 80),
      conclusion: text,
      why: `来自「${a.title}」与「${b.title}」`,
      how: '',
      confidence: clamp01(asNumber(entry.confidence, 0.4)),
      salience: 0.3,
      weight: 0.3,
      lastReplayed: null,
      sources: [...a.sources, ...b.sources],
      createdAt: Date.now(),
    })
  }

  return created.slice(0, 3)
}
