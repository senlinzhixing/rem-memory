/**
 * P2 · 检索与简报
 *
 * 关键词检索（Intl.Segmenter 处理中文）+ salience/recency 打分；
 * 简报用于注入系统提示，只放最热的一小撮卡片。
 */
import type { MemoryCard } from '../compress/c3'

export interface RecallHit {
  card: MemoryCard
  score: number
  keyword: number
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null

export function tokenize(query: string): string[] {
  const text = query.toLowerCase().trim()
  if (!text) return []
  if (!segmenter) return [...new Set(text.split(/\s+/).filter(Boolean))]

  const tokens = new Set<string>()
  for (const part of segmenter.segment(text)) {
    const token = part.segment.trim()
    if (token) tokens.add(token)
  }
  return [...tokens]
}

export function searchCards(cards: readonly MemoryCard[], query: string, k = 5): RecallHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  const now = Date.now()
  const hits: RecallHit[] = []
  for (const card of cards) {
    const text = `${card.title} ${card.conclusion} ${card.why} ${card.how} ${card.type} ${card.scope}`.toLowerCase()
    let matched = 0
    for (const token of tokens) {
      if (text.includes(token)) matched += 1
    }
    if (matched === 0) continue

    const keyword = matched / tokens.length
    const recency = 1 / (1 + (now - card.createdAt) / (7 * 24 * 3600 * 1000))
    const score = keyword * 0.6 + card.salience * 0.3 + recency * 0.1
    hits.push({ card, score, keyword })
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, k)
}

/** 注入用的记忆简报：按生成时间倒序（最新在前），控制在 1200 字符内。 */
export function renderBrief(cards: readonly MemoryCard[], limit = 12): string {
  if (cards.length === 0) return ''

  const top = [...cards].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  const lines = ['## 记忆简报（来自梦忆）', '']
  let size = 0
  for (const card of top) {
    const line = `- [${card.type}] ${card.title} → ${card.id}`
    if (size + line.length > 1200) break
    size += line.length
    lines.push(line)
  }
  lines.push('', '需要细节时调用 memory_recall 或 memory_read。')
  return lines.join('\n')
}
