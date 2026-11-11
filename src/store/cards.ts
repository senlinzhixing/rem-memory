/**
 * P2/P3 · 持久化
 *
 * `rem` 域包含三张表：
 *  - cards：记忆卡
 *  - processed：已尝试处理的 segment（防止睡眠重复烧钱）
 *  - reports：梦境报告
 *
 * 宿主没有 storageDomain 时降级为纯内存。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { MemoryCard } from '../compress/c3'
import { mergeCards, normalizeTitle } from '../compress/c3'

const SourceSchema = z.object({
  sessionId: z.string(),
  seqStart: z.number(),
  seqEnd: z.number(),
})

const CardSchema = z.object({
  id: z.string(),
  type: z.enum(['decision', 'preference', 'fact', 'procedure', 'failure', 'entity', 'hypothesis']),
  status: z.enum(['active', 'pending', 'archived']).default('active'),
  scope: z.string(),
  title: z.string(),
  conclusion: z.string(),
  why: z.string(),
  how: z.string(),
  confidence: z.number(),
  salience: z.number(),
  weight: z.number().default(1),
  lastReplayed: z.number().nullable().default(null),
  sources: z.array(SourceSchema),
  createdAt: z.number(),
})

const ProcessedSchema = z.object({ at: z.number() })

export interface SegmentRecord {
  id: string
  sessionId: string
  seqStart: number
  seqEnd: number
  c1Text: string
  tokens: number
  createdAt: number
}

const SegmentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seqStart: z.number(),
  seqEnd: z.number(),
  c1Text: z.string(),
  tokens: z.number(),
  createdAt: z.number(),
})

export interface DreamReportRecord {
  id: string
  at: number
  mode: 'manual' | 'auto'
  segments: number
  cards: number
  rejected: number
  skipped: number
  fidelity: number | null
  decayed: number
  archived: number
  hypotheses: number
  tieredSegments: number
  tieredCards: number
  notes: string[]
}

const ReportSchema = z.object({
  id: z.string(),
  at: z.number(),
  mode: z.enum(['manual', 'auto']),
  segments: z.number(),
  cards: z.number(),
  rejected: z.number(),
  skipped: z.number(),
  fidelity: z.number().nullable(),
  decayed: z.number().default(0),
  archived: z.number().default(0),
  hypotheses: z.number().default(0),
  tieredSegments: z.number().default(0),
  tieredCards: z.number().default(0),
  notes: z.array(z.string()),
})

export const RemDomain = defineDomain({
  name: 'rem',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    cards: domainTable<'card', MemoryCard>(CardSchema),
    processed: domainTable<'processed', { at: number }>(ProcessedSchema),
    reports: domainTable<'report', DreamReportRecord>(ReportSchema),
    segments: domainTable<'segment', SegmentRecord>(SegmentSchema),
  },
  global: {
    schema: z.object({ version: z.number(), updatedAt: z.number() }),
    initial: { version: 1, updatedAt: 0 },
  },
})

interface TableHandle<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  readonly size: number
}

interface DomainHandle {
  table(name: 'cards'): TableHandle<MemoryCard>
  table(name: 'processed'): TableHandle<{ at: number }>
  table(name: 'reports'): TableHandle<DreamReportRecord>
  table(name: 'segments'): TableHandle<SegmentRecord>
  close(): Promise<void>
}

interface StorageFacility {
  open(spec: typeof RemDomain): Promise<DomainHandle>
}

export type StoreMode = 'storage' | 'memory'

function shortHash(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export class CardStore {
  private readonly cards = new Map<string, MemoryCard>()
  private readonly processed = new Map<string, number>()
  private readonly segments = new Map<string, SegmentRecord>()
  private lastReportValue: DreamReportRecord | null = null
  private domain: DomainHandle | null = null
  private readonly readyPromise: Promise<void>
  private mode: StoreMode = 'memory'
  private failure: string | undefined

  constructor(private readonly ctx: Context) {
    this.readyPromise = this.init()
    ctx.effect(() => () => void this.close())
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  all(): MemoryCard[] {
    return [...this.cards.values()]
  }

  activeCards(): MemoryCard[] {
    return this.all().filter(card => card.status === 'active')
  }

  pendingCards(): MemoryCard[] {
    return this.all().filter(card => card.status === 'pending')
  }

  /** N3：全局权重衰减，低于阈值的 active 卡归档。 */
  async decay(factor = 0.95, threshold = 0.2): Promise<{ decayed: number; archived: number }> {    const changed: MemoryCard[] = []
    for (const card of [...this.cards.values()]) {
      if (card.status !== 'active') continue
      const weight = Number((card.weight * factor).toFixed(4))
      const next: MemoryCard = {
        ...card,
        weight,
        status: weight < threshold ? 'archived' : 'active',
      }
      this.cards.set(next.id, next)
      changed.push(next)
    }
    if (this.domain) {
      for (const card of changed) await this.domain.table('cards').put(card.id, card)
    }
    return { decayed: changed.length, archived: changed.filter(card => card.status === 'archived').length }
  }

  async setStatus(
    id: string,
    status: MemoryCard['status'],
    patch: Partial<MemoryCard> = {},
  ): Promise<MemoryCard | undefined> {
    const card = this.cards.get(id)
    if (!card) return undefined
    const next: MemoryCard = { ...card, ...patch, status }
    this.cards.set(id, next)
    if (this.domain) await this.domain.table('cards').put(id, next)
    return next
  }

  async putCard(card: MemoryCard): Promise<void> {
    this.cards.set(card.id, card)
    if (this.domain) await this.domain.table('cards').put(card.id, card)
  }

  /** 热→温：超过 7 天的片段原文删除，卡片保留。 */
  async ageSegments(maxAgeDays: number): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
    const stale = [...this.segments.values()].filter(record => record.createdAt < cutoff)
    for (const record of stale) {
      this.segments.delete(record.id)
      if (this.domain) await this.domain.table('segments').delete(record.id)
    }
    return stale.length
  }

  /** 温→冷：超过 30 天且权重偏低的活跃卡归档。 */
  async ageCards(maxAgeDays: number, minWeight: number): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
    let count = 0
    for (const card of [...this.cards.values()]) {
      if (card.status !== 'active') continue
      if (card.createdAt >= cutoff) continue
      if (card.weight >= minWeight) continue
      await this.setStatus(card.id, 'archived')
      count += 1
    }
    return count
  }

  /** 冷层索引：每个 scope 生成/更新一张"历史记忆索引"卡。 */
  async rollupIndex(minArchived = 3): Promise<number> {
    const groups = new Map<string, MemoryCard[]>()
    for (const card of this.cards.values()) {
      if (card.status !== 'archived' || card.type === 'hypothesis') continue
      const list = groups.get(card.scope) ?? []
      list.push(card)
      groups.set(card.scope, list)
    }

    let created = 0
    for (const [scope, cards] of groups) {
      if (cards.length < minArchived) continue
      const id = `mem_idx_${shortHash(scope)}`
      const existing = this.cards.get(id)
      const recent = cards
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3)
        .map(card => card.title)
        .join('；')

      await this.putCard({
        id,
        type: 'fact',
        status: 'active',
        scope,
        title: `历史记忆索引：${scope}`,
        conclusion: `已归档 ${cards.length} 条历史经验。最近：${recent}`,
        why: '由年龄分层自动生成',
        how: '需要细节时按来源回溯，或查看归档卡',
        confidence: 0.6,
        salience: 0.35,
        weight: 0.5,
        lastReplayed: null,
        sources: [],
        createdAt: existing?.createdAt ?? Date.now(),
      })
      created += 1
    }
    return created
  }

  isProcessed(segmentId: string): boolean {
    return this.processed.has(segmentId)
  }

  processedCount(): number {
    return this.processed.size
  }

  lastReport(): DreamReportRecord | null {
    return this.lastReportValue
  }

  getSegment(id: string): SegmentRecord | undefined {
    return this.segments.get(id)
  }

  findSegmentByRange(sessionId: string, seqStart: number, seqEnd: number): SegmentRecord | undefined {
    for (const record of this.segments.values()) {
      if (record.sessionId === sessionId && record.seqStart === seqStart && record.seqEnd === seqEnd) {
        return record
      }
    }
    return undefined
  }

  async saveSegment(record: SegmentRecord): Promise<void> {
    const bounded: SegmentRecord = { ...record, c1Text: record.c1Text.slice(0, 12_000) }
    this.segments.set(bounded.id, bounded)
    if (!this.domain) return
    await this.domain.table('segments').put(bounded.id, bounded)
    await this.evictSegments(500)
  }

  private async evictSegments(limit: number): Promise<void> {
    if (!this.domain || this.segments.size <= limit) return
    const oldest = [...this.segments.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, this.segments.size - limit)
    for (const record of oldest) {
      this.segments.delete(record.id)
      await this.domain.table('segments').delete(record.id)
    }
  }

  status(): { mode: StoreMode; count: number; processed: number; failure?: string } {
    return { mode: this.mode, count: this.cards.size, processed: this.processed.size, failure: this.failure }
  }

  async markProcessed(segmentId: string): Promise<void> {
    const at = Date.now()
    this.processed.set(segmentId, at)
    if (this.domain) await this.domain.table('processed').put(segmentId, { at })
  }

  async saveReport(report: DreamReportRecord): Promise<void> {
    this.lastReportValue = report
    if (this.domain) await this.domain.table('reports').put(report.id, report)
  }

  /** 合并新卡并按标题去重；持久化模式下落盘。 */
  async merge(incoming: readonly MemoryCard[]): Promise<MemoryCard[]> {
    await this.readyPromise
    if (incoming.length === 0) return this.all()

    const merged = mergeCards(this.all(), incoming)
    this.cards.clear()
    for (const card of merged) this.cards.set(card.id, card)

    if (this.domain) {
      const byTitle = new Map(merged.map(card => [normalizeTitle(card.title), card]))
      const persisted = new Set<string>()
      for (const card of incoming) {
        const target = byTitle.get(normalizeTitle(card.title))
        if (!target || persisted.has(target.id)) continue
        persisted.add(target.id)
        await this.domain.table('cards').put(target.id, target)
      }
    }

    return merged
  }

  async close(): Promise<void> {
    const domain = this.domain
    this.domain = null
    if (!domain) return
    try {
      await domain.close()
    } catch {
      // 关闭失败不影响退场。
    }
  }

  private async init(): Promise<void> {
    const facility = this.ctx.storageDomain as unknown as StorageFacility
    if (!facility) {
      this.failure = 'storageDomain 不可用'
      return
    }

    try {
      const domain = await facility.open(RemDomain)
      this.domain = domain

      for (const [id, card] of domain.table('cards').entries()) this.cards.set(id, card)
      for (const [id, record] of domain.table('processed').entries()) this.processed.set(id, record.at)
      for (const [id, record] of domain.table('segments').entries()) this.segments.set(id, record)
      for (const [, report] of domain.table('reports').entries()) {
        if (!this.lastReportValue || report.at > this.lastReportValue.at) this.lastReportValue = report
      }

      this.mode = 'storage'
      this.ctx.logger.info(
        '[rem] store ready: %d cards, %d processed, last dream %s',
        this.cards.size,
        this.processed.size,
        this.lastReportValue ? new Date(this.lastReportValue.at).toISOString() : 'none',
      )
    } catch (error) {
      this.failure = String(error)
      this.mode = 'memory'
      this.ctx.logger.warn('[rem] store unavailable, using memory: %s', String(error))
    }
  }
}
