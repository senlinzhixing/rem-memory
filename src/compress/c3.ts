/**
 * P1-4 · C3 抽取
 *
 * 把 C2 叙事 + 片段节选抽成可复用的记忆卡，按 salience 过滤，
 * 并与已有卡片按标题合并（来源取并集）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SegmentView } from '../capture/segmenter'
import {
  asNumber,
  asRecord,
  asString,
  clamp01,
  completeJson,
  type LlmRoute,
} from '../llm/complete'
import type { Narrative } from './c2'

export type CardType = 'decision' | 'preference' | 'fact' | 'procedure' | 'failure' | 'entity' | 'hypothesis'

export type CardStatus = 'active' | 'pending' | 'archived'

const CARD_TYPES: readonly CardType[] = ['decision', 'preference', 'fact', 'procedure', 'failure', 'entity', 'hypothesis']

export interface CardSource {
  sessionId: string
  seqStart: number
  seqEnd: number
}

export interface MemoryCard {
  id: string
  type: CardType
  status: CardStatus
  scope: string
  title: string
  conclusion: string
  why: string
  how: string
  confidence: number
  salience: number
  weight: number
  lastReplayed: number | null
  sources: CardSource[]
  createdAt: number
}

const SYSTEM_PROMPT = `你是一个记忆抽取器。从给定的会话叙事与片段节选中，抽取以后还能复用的记忆卡。

只输出 JSON 对象，不要解释，不要 markdown 代码块：
{"cards":[{"type":"decision|preference|fact|procedure|failure|entity","title":"...","conclusion":"...","why":"...","how":"...","confidence":0.0}]}

卡片最多 5 张。规则：
- 一张卡只讲一件事；title 不超过 40 字，是断言而不是主题。
- conclusion 一句话；why 是因果原因；how 是可执行做法；不知道就留空字符串。
- confidence 取 0 到 1，保守估计。
- 如果某个数字、版本或阈值本身就是结论的一部分，保留它。
- 跳过：只属于本次运行的一次性细节、显而易见的事实、复述任务本身。
- 输出语言与输入一致。`

export interface ExtractInput {
  narrative: Narrative
  excerpt: string
  segment: SegmentView
  sessionId: string
}

export async function extractCards(
  ctx: Context,
  route: LlmRoute,
  input: ExtractInput,
  signal?: AbortSignal,
): Promise<MemoryCard[]> {
  const user = [
    '叙事：',
    JSON.stringify(input.narrative, null, 2),
    '',
    '片段节选：',
    input.excerpt,
  ].join('\n')

  const result = await completeJson(ctx, route, {
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 3000,
  }, signal)

  const record = asRecord(result.value)
  const raw = Array.isArray(record.cards) ? record.cards : []
  const cards: MemoryCard[] = []

  for (const item of raw) {
    const card = asRecord(item)
    const type = asString(card.type) as CardType
    const title = asString(card.title)
    if (!title || !CARD_TYPES.includes(type)) continue

    const confidence = clamp01(asNumber(card.confidence, 0.6))
    cards.push({
      id: makeId(),
      type,
      status: 'active',
      scope: `session:${input.sessionId.replace(/^session-/, '').slice(0, 8)}`,
      title: title.slice(0, 80),
      conclusion: asString(card.conclusion),
      why: asString(card.why),
      how: asString(card.how),
      confidence,
      salience: salienceOf(type, input.segment),
      weight: 1,
      lastReplayed: null,
      sources: [{
        sessionId: input.sessionId,
        seqStart: input.segment.seqStart,
        seqEnd: input.segment.seqEnd,
      }],
      createdAt: Date.now(),
    })
  }

  return cards.filter(card => card.salience >= 0.45).slice(0, 5)
}

/** salience 由服务端规则计算，不采信模型自评。 */
export function salienceOf(type: CardType, segment: SegmentView): number {
  let score = 0.45
  if (type === 'failure') score = 0.8
  else if (type === 'decision') score = 0.75
  else if (type === 'preference') score = 0.7
  else if (type === 'procedure') score = 0.6

  if (segment.failures.length > 0) score += 0.05
  if (segment.kind === 'debug') score += 0.05
  return Math.min(1, score)
}

/** 按归一化标题合并：同题卡片合并来源、取更高置信度。 */
export function mergeCards(existing: readonly MemoryCard[], incoming: readonly MemoryCard[]): MemoryCard[] {
  const out = [...existing]
  const index = new Map(out.map(card => [normalizeTitle(card.title), card]))

  for (const card of incoming) {
    const key = normalizeTitle(card.title)
    const found = index.get(key)
    if (!found) {
      out.push(card)
      index.set(key, card)
      continue
    }

    const merged: MemoryCard = {
      ...found,
      confidence: Math.max(found.confidence, card.confidence),
      sources: uniqueSources([...found.sources, ...card.sources]),
      createdAt: Date.now(),
    }
    const position = out.findIndex(item => item.id === found.id)
    if (position >= 0) out[position] = merged
    index.set(key, merged)
  }

  return out
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function uniqueSources(sources: readonly CardSource[]): CardSource[] {
  const seen = new Set<string>()
  const out: CardSource[] = []
  for (const source of sources) {
    const key = `${source.sessionId}:${source.seqStart}:${source.seqEnd}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(source)
  }
  return out
}

function makeId(): string {
  return `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function nextCardId(): string {
  return makeId()
}
