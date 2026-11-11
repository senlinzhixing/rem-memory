/**
 * P1-1 · 采集与切段
 *
 * 把 `session/event` 流按 turn 边界切成 Segment，并把同一会话的 Segment
 * 归入一个 Episode。当前只做规则切段：不调模型、不落盘。
 *
 * 切段策略（对齐设计稿 §5.3）：
 *  - `turn/end` 是硬边界；
 *  - 连续小 turn 合并，直到累计 token ≥ 500 或已有 3 个 turn；
 *  - 单个超长 turn 自成一段（后续 C1 再压）。
 */

export type SegmentKind = 'fix' | 'debug' | 'feature' | 'explore' | 'refactor' | 'question'

/** C1 清洗的输入单元：一段会话里按发生顺序排列的原始块。 */
export type RawBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool-call'; name: string; args: string }
  | { kind: 'tool-result'; name: string; text: string; isError: boolean }

export interface ObservedEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface SegmentView {
  readonly id: string
  readonly episodeId: string
  readonly seqStart: number
  readonly seqEnd: number
  readonly turnStart: number
  readonly turnEnd: number
  readonly kind: SegmentKind
  readonly goal: string
  readonly actions: readonly string[]
  readonly result: string
  readonly decisions: readonly string[]
  readonly failures: readonly string[]
  readonly tokens: number
  /** 原始块，供 C1 清洗使用；限制在 400 块 / 80K 字符以内。 */
  readonly raw: readonly RawBlock[]
}

export interface EpisodeView {
  readonly id: string
  readonly sessionId: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly turns: number
  readonly tokens: number
  readonly pendingTurns: number
  readonly segments: readonly SegmentView[]
}

/** 一个 turn 的原始累积，flush 时再投影成 SegmentView。 */
interface TurnBuffer {
  turn: number
  seqStart: number
  seqEnd: number
  userText: string
  assistantText: string
  toolNames: string[]
  failures: string[]
  tokens: number
  cost: number
  blocks: RawBlock[]
}

interface EpisodeBuilder {
  id: string
  sessionId: string
  startedAt: number
  updatedAt: number
  turns: number
  tokens: number
  segments: SegmentView[]
  pending: TurnBuffer[]
  pendingTokens: number
  current: TurnBuffer | null
  callNames: Map<string, string>
  seqCounter: number
  lastSeq: number
}

const SEGMENT_MIN_TOKENS = 500
const SEGMENT_MAX_TURNS = 3
const MAX_SEGMENTS_PER_EPISODE = 200
const MAX_EPISODES = 50

export class Segmenter {
  private readonly episodes = new Map<string, EpisodeBuilder>()

  observe(sessionId: string, event: ObservedEvent): void {
    const builder = this.ensure(sessionId, event)
    // 回放与实时事件可能重叠：按 seq 去重，保证幂等。
    if (event.seq <= builder.lastSeq) return
    builder.lastSeq = event.seq
    builder.updatedAt = event.time
    builder.seqCounter = Math.max(builder.seqCounter, event.seq)

    // 插件可能在 turn 中途才加载；用事件自带的 turn 号补一个当前 turn。
    if (!builder.current && isMidTurnEvent(event.type)) {
      const turn = currentTurnNumber(event)
      if (turn !== null) builder.current = emptyTurn(turn, event.seq)
    }

    switch (event.type) {
      case 'turn/start':
        this.beginTurn(builder, event)
        break
      case 'user/message': {
        // `user/message` 的 data 本身就是消息（不是 { message }）。
        const data = record(event.data)
        const text = textOf(data?.message ?? data)
        if (!text) break
        builder.current = builder.current ?? emptyTurn(currentTurnNumber(event) ?? 0, event.seq)
        builder.current.userText += text
        pushBlock(builder.current, { kind: 'user', text: cap(text, 8000) })
        break
      }
      case 'assistant/message': {
        const data = record(event.data)
        const text = textOf(data?.message)
        if (!builder.current) break
        if (text) {
          builder.current.assistantText += text
          pushBlock(builder.current, { kind: 'assistant', text: cap(text, 8000) })
        }
        builder.current.cost += usageTokens(data?.usage)
        break
      }
      case 'tool/call': {
        const data = record(event.data)
        const name = stringOf(data?.name) ?? 'tool'
        const callId = stringOf(data?.callId)
        if (callId) builder.callNames.set(callId, name)
        if (builder.current) {
          if (!builder.current.toolNames.includes(name)) builder.current.toolNames.push(name)
          pushBlock(builder.current, {
            kind: 'tool-call',
            name,
            args: cap(stringOf(data?.arguments) ?? '', 1000),
          })
        }
        break
      }
      case 'tool/result': {
        const data = record(event.data)
        const message = record(data?.message)
        const callId = stringOf(data?.callId) ?? stringOf(record(message?.source)?.callId) ?? stringOf(message?.callId)
        const name = (callId && builder.callNames.get(callId)) || 'tool'
        const isError = message?.isError === true || Boolean(data?.error)
        const text = textOf(message)
        if (isError) {
          const detail = firstLine(text) || stringOf(record(data?.error)?.reason) || 'failed'
          if (builder.current) builder.current.failures.push(`${name}: ${detail}`)
        }
        if (builder.current) {
          pushBlock(builder.current, { kind: 'tool-result', name, text: cap(text, 20000), isError })
        }
        break
      }
      case 'turn/end':
        this.endTurn(builder, event)
        break
      default:
        break
    }
  }

  /** 会话结束或插件卸载时，把未满阈值的尾巴也切出来。 */
  flush(sessionId: string): void {
    const builder = this.episodes.get(sessionId)
    if (!builder) return
    if (builder.current) this.endTurn(builder, null)
    this.flushPending(builder)
  }

  list(): EpisodeView[] {
    return [...this.episodes.values()]
      .map(toView)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  stats(): { episodes: number; segments: number; turns: number; tokens: number } {
    let segments = 0
    let turns = 0
    let tokens = 0
    for (const builder of this.episodes.values()) {
      segments += builder.segments.length
      turns += builder.turns
      tokens += builder.tokens
    }
    return { episodes: this.episodes.size, segments, turns, tokens }
  }

  private ensure(sessionId: string, event: ObservedEvent): EpisodeBuilder {
    let builder = this.episodes.get(sessionId)
    if (!builder) {
      const short = sessionId.replace(/^session-/, '').slice(0, 8)
      builder = {
        id: `ep_${short}_${event.seq}`,
        sessionId,
        startedAt: event.time,
        updatedAt: event.time,
        turns: 0,
        tokens: 0,
        segments: [],
        pending: [],
        pendingTokens: 0,
        current: null,
        callNames: new Map(),
        seqCounter: event.seq,
        lastSeq: -1,
      }
      this.episodes.set(sessionId, builder)
      this.trimEpisodes()
    }
    return builder
  }

  private beginTurn(builder: EpisodeBuilder, event: ObservedEvent): void {
    if (builder.current) this.endTurn(builder, null)
    builder.current = emptyTurn(currentTurnNumber(event) ?? 0, event.seq)
  }

  private endTurn(builder: EpisodeBuilder, event: ObservedEvent | null): void {
    const turn = builder.current
    builder.current = null
    if (!turn) return
    if (event) turn.seqEnd = event.seq
    if (turn.seqEnd < turn.seqStart) turn.seqEnd = turn.seqStart
    if (!turn.userText && !turn.assistantText && turn.toolNames.length === 0) return

    builder.turns += 1
    const size = estimateTokens(turn)
    turn.tokens = size
    builder.tokens += size
    builder.pending.push(turn)
    builder.pendingTokens += size

    if (builder.pendingTokens >= SEGMENT_MIN_TOKENS || builder.pending.length >= SEGMENT_MAX_TURNS) {
      this.flushPending(builder)
    }
  }

  private flushPending(builder: EpisodeBuilder): void {
    if (builder.pending.length === 0) return
    const turns = builder.pending
    builder.pending = []
    builder.pendingTokens = 0

    const first = turns[0]
    const last = turns[turns.length - 1]
    const goal = compact(extractPrompt(first.userText), 80) || '（无用户输入）'
    const actions = unique(turns.flatMap(turn => turn.toolNames)).slice(0, 6)
    const failures = unique(turns.flatMap(turn => turn.failures)).slice(0, 4)
    const result = compact([...turns].reverse().find(turn => turn.assistantText)?.assistantText ?? '', 120)
    const tokens = turns.reduce((sum, turn) => sum + (turn.tokens || estimateTokens(turn)), 0)

    const segment: SegmentView = {
      id: `seg_${builder.id.slice(3)}_${first.turn}_${last.turn}`,
      episodeId: builder.id,
      seqStart: first.seqStart,
      seqEnd: last.seqEnd,
      turnStart: first.turn,
      turnEnd: last.turn,
      kind: classify(goal, actions, failures),
      goal,
      actions,
      result,
      decisions: [],
      failures,
      tokens,
      raw: capBlocks(turns.flatMap(turn => turn.blocks)),
    }

    builder.segments.push(segment)
    if (builder.segments.length > MAX_SEGMENTS_PER_EPISODE) builder.segments.shift()
  }

  private trimEpisodes(): void {
    if (this.episodes.size <= MAX_EPISODES) return
    const oldest = [...this.episodes.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
    if (oldest) this.episodes.delete(oldest.sessionId)
  }
}

function toView(builder: EpisodeBuilder): EpisodeView {
  return {
    id: builder.id,
    sessionId: builder.sessionId,
    startedAt: builder.startedAt,
    updatedAt: builder.updatedAt,
    turns: builder.turns,
    tokens: builder.tokens,
    pendingTurns: builder.pending.length + (builder.current ? 1 : 0),
    segments: builder.segments,
  }
}

function emptyTurn(turn: number, seq: number): TurnBuffer {
  return {
    turn,
    seqStart: seq,
    seqEnd: seq,
    userText: '',
    assistantText: '',
    toolNames: [],
    failures: [],
    tokens: 0,
    cost: 0,
    blocks: [],
  }
}

const MAX_BLOCKS_PER_TURN = 400

function pushBlock(turn: TurnBuffer, block: RawBlock): void {
  if (turn.blocks.length >= MAX_BLOCKS_PER_TURN) return
  turn.blocks.push(block)
}

function cap(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[+${value.length - limit}]`
}

function capBlocks(blocks: RawBlock[]): RawBlock[] {
  const out: RawBlock[] = []
  let chars = 0
  for (const block of blocks) {
    const size = block.kind === 'tool-call' ? block.args.length : block.text.length
    if (out.length >= MAX_BLOCKS_PER_TURN || chars + size > 80000) break
    chars += size
    out.push(block)
  }
  return out
}

function currentTurnNumber(event: ObservedEvent): number | null {
  const data = record(event.data)
  return numberOf(data?.turn) ?? null
}

function isMidTurnEvent(type: string): boolean {
  return type === 'assistant/message' || type === 'tool/call' || type === 'tool/result'
}

function classify(goal: string, actions: readonly string[], failures: readonly string[]): SegmentKind {
  const text = `${goal} ${actions.join(' ')}`
  if (/重构|refactor/i.test(text)) return 'refactor'
  if (failures.length > 0 || /报错|错误|失败|崩溃|bug|fix|修复/i.test(text)) return 'debug'
  if (/新增|实现|添加|支持|feature|add\b/i.test(text)) return 'feature'
  if (/[?？]|为什么|怎么|如何/.test(text)) return 'question'
  return 'explore'
}

function usageTokens(value: unknown): number {
  const usage = record(value)
  if (!usage) return 0
  const input = numberOf(usage.inputTokens) ?? 0
  const output = numberOf(usage.outputTokens) ?? 0
  return input + output
}

function estimateTokens(turn: TurnBuffer): number {
  // 按实际文本体积估算，而不是 API 用量（input 每次都会带上完整上下文）。
  if (turn.blocks.length > 0) {
    let chars = 0
    for (const block of turn.blocks) {
      chars += block.kind === 'tool-call' ? block.name.length + block.args.length : block.text.length
    }
    return Math.max(1, Math.ceil(chars / 4))
  }
  return Math.ceil((turn.userText.length + turn.assistantText.length) / 4)
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  const message = record(value)
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const item = record(block)
      if (!item) return ''
      if (typeof item.text === 'string') return item.text
      if (typeof item.content === 'string') return item.content
      return ''
    })
    .join('')
}

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
}

/** 平台会把 runtime context 追加进用户消息；取目标时在标记处截断。 */
const PROMPT_MARKERS = [
  /Current runtime context\./i,
  /Time sampled while preparing/i,
  /\[model changed:/i,
  /Approval prompts are enabled/i,
  /Browser time zone for this request:/i,
  /Elapsed since the preceding model-visible message:/i,
]

function extractPrompt(text: string): string {
  let cut = text.length
  for (const marker of PROMPT_MARKERS) {
    const match = marker.exec(text)
    if (match && match.index < cut) cut = match.index
  }
  return text.slice(0, cut).trim()
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 80) ?? ''
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
