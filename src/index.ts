/**
 * 梦忆（rem）· DSH 宿主插件
 *
 * 这一半运行在 Host 进程里：观察会话事件、切成 Episode/Segment、
 * 维护睡眠压力、对外提供工具。UI 在 `./client`，通过右侧栏的 `rem` 页签呈现。
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-commands'
import { Segmenter, type EpisodeView, type ObservedEvent, type SegmentView } from './capture/segmenter'
import { cleanBlocks } from './compress/c1'
import { durableNarrativeText, narrate, narrativeText, parseNarrative, selectWindow, type LlmRoute, type Narrative } from './compress/c2'
import { extractCards, mergeCards, type MemoryCard } from './compress/c3'
import { runFidelity } from './compress/fidelity'
import { CardStore, type DreamReportRecord } from './store/cards'
import { renderBrief, searchCards } from './recall/search'
import { runRem } from './sleep/rem'

export const name = 'dsh-rem'

/** 工具注册表 + 模型服务 + 系统提示注入 + 持久化 + 会话事件订阅。 */
export const inject = ['tools', 'llm', 'systemPrompt', 'storageDomain', 'workspaceFiles', 'commands']

interface RemRuntime {
  readonly startedAt: number
  sessions: Set<string>
  events: number
  turns: number
  toolCalls: number
  corrections: number
  pressure: number
}

const runtime: RemRuntime = {
  startedAt: Date.now(),
  sessions: new Set(),
  events: 0,
  turns: 0,
  toolCalls: 0,
  corrections: 0,
  pressure: 0,
}

/** 每处理一个 turn 增加的睡眠压力；容量见设计稿 §6。 */
const PRESSURE_CAP = 1.6
const PRESSURE_CAPACITY = 80_000
const PRESSURE_THRESHOLD = 0.8
const IDLE_BEFORE_SLEEP_MS = 10 * 60_000
const SLEEP_INTERVAL_MS = 10 * 60_000

export function apply(ctx: Context): void {
  try {
    applyInner(ctx)
  } catch (error) {
    // 插件初始化失败不应该拖垮整个宿主：记录堆栈并让 Host 继续启动。
    ctx.logger.error(
      '[rem] plugin setup failed: %s',
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  }
}

function applyInner(ctx: Context): void {
  const segmenter = new Segmenter()
  const backfilled = new Set<string>()
  const routes = new Map<string, LlmRoute>()
  const narratives = new Map<string, Narrative>()
  const repo = new CardStore(ctx)
  let lastRoute: LlmRoute | undefined
  let lastActivityAt = Date.now()
  let sleeping = false
  const sessionCwd = new Map<string, string>()
  const snapshotted = new Set<string>()

  // 把记忆简报挂进系统提示：每次装配时读取当前卡片，空库时返回空串。
  ctx.systemPrompt.context({
    name: 'rem/brief',
    order: 900,
    text: () => renderBrief(repo.activeCards()),
  })

  const noteRoute = (sessionId: string, event: ObservedEvent): void => {
    const route = routeOf(event)
    if (!route) return
    routes.set(sessionId, route)
    lastRoute = route
  }

  const pickSegment = (wanted?: string): { episode: EpisodeView; segment: SegmentView } | undefined => {
    const episodes = segmenter.list()
    const all = episodes.flatMap(episode => episode.segments.map(segment => ({ episode, segment })))
    if (all.length === 0) return undefined
    if (wanted) {
      const found = all.find(item => item.segment.id === wanted)
      if (found) return found
    }
    const newest = episodes[0]?.segments[episodes[0].segments.length - 1]
    return newest ? { episode: episodes[0], segment: newest } : all[all.length - 1]
  }

  const pendingSegments = () => segmenter.list()
    .flatMap(episode => episode.segments.map(segment => ({ episode, segment })))
    .filter(item => !repo.isProcessed(item.segment.id))

  const computePressure = (): number => {
    const tokens = pendingSegments().reduce((sum, item) => sum + item.segment.tokens, 0)
    return Math.min(PRESSURE_CAP, tokens / PRESSURE_CAPACITY)
  }

  /** 把面板要显示的快照写进会话工作区，客户端通过 file 资源读取。 */
  const writeSnapshot = async (sessionId: string): Promise<void> => {
    const cwd = sessionCwd.get(sessionId)
    if (!cwd) return
    try {
      await repo.ready()
      const cards = repo.activeCards()
      const payload = {
        version: 1,
        updatedAt: Date.now(),
        cards: cards.length,
        pending: repo.pendingCards().length,
        processed: repo.status().processed,
        pressure: Number(computePressure().toFixed(3)),
        lastDream: repo.lastReport(),
        top: [...cards]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 50)
          .map(card => ({
            id: card.id,
            type: card.type,
            title: card.title,
            scope: card.scope,
            salience: card.salience,
          })),
      }
      const dir = join(cwd, '.rem')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'status.json'), JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      ctx.logger.warn('[rem] write snapshot failed: %s', String(error))
    }
  }

  interface ExtractOutcome {
    passed: boolean
    cards: number
    c1Text: string
    fidelity?: Awaited<ReturnType<typeof runFidelity>>
    error?: string
    report: string
  }

  const runExtraction = async (
    picked: { episode: EpisodeView; segment: SegmentView },
    route: LlmRoute,
    options: { fidelity?: boolean; questions?: number } = {},
  ): Promise<ExtractOutcome> => {
    const c1 = cleanBlocks(picked.segment.raw)
    if (!c1.text.trim()) return { passed: false, cards: 0, c1Text: '', report: '这一段没有可抽取的文本。' }

    const signal = AbortSignal.timeout(240_000)
    const startedAt = Date.now()
    try {
      const narration = await narrate(ctx, route, c1.text, signal)
      const extracted = await extractCards(ctx, route, {
        narrative: narration.narrative,
        excerpt: c1.text.slice(0, 1200),
        segment: picked.segment,
        sessionId: picked.episode.sessionId,
      }, signal)

      if (extracted.length === 0) {
        return { passed: false, cards: 0, c1Text: c1.text, report: '没有抽出高 salience 的记忆卡。' }
      }

      let fidelity: ExtractOutcome['fidelity']
      if (options.fidelity !== false) {
        const durable = durableNarrativeText(narration.narrative)
        fidelity = await runFidelity(ctx, route, {
          source: durable || narrativeText(narration.narrative),
          compressed: cardsToText(extracted),
          count: typeof options.questions === 'number' ? options.questions : 6,
        }, signal)
      }

      const threshold = 0.95
      const passed = !fidelity || fidelity.score >= threshold
      if (passed) {
        await repo.merge(extracted)
        void writeSnapshot(picked.episode.sessionId)
      }

      const lines = [
        '## C3 抽取报告',
        '',
        `段：${picked.segment.id} · [${picked.segment.kind}] ${picked.segment.goal}`,
        `模型：${route.provider}/${route.model} · ${Date.now() - startedAt}ms`,
        `候选卡：${extracted.length} 张 · 已存：${repo.all().length} 张`,
        fidelity
          ? `保真度：${fidelity.passed}/${fidelity.total}（${fidelity.score.toFixed(2)}）· 阈值 ${threshold}`
          : '保真度：已跳过',
        '',
        '### 卡片',
      ]

      extracted.forEach((card, index) => {
        lines.push(`${index + 1}. [${card.type}] ${card.title}`)
        if (card.conclusion) lines.push(`   结论：${card.conclusion}`)
        if (card.why) lines.push(`   为什么：${card.why}`)
        if (card.how) lines.push(`   怎么做：${card.how}`)
        lines.push(`   salience ${card.salience.toFixed(2)} · confidence ${card.confidence.toFixed(2)}`)
      })

      if (fidelity) {
        const failed = fidelity.details.filter(detail => !detail.same)
        if (failed.length > 0) {
          lines.push('', '### 未通过的题')
          for (const detail of failed) {
            lines.push(`- [${detail.kind}] ${detail.q}`)
            lines.push(`  参考：${detail.expected}`)
            lines.push(`  实际：${detail.actual}`)
          }
        }
      }

      lines.push('', '### 结果')
      lines.push(passed
        ? `已落卡 ${extracted.length} 张。`
        : `未落卡：保真度低于 ${threshold}，请检查 C1/C2 是否压掉了关键信息。`)

      return { passed, cards: extracted.length, c1Text: c1.text, fidelity, report: lines.join('\n') }
    } catch (error) {
      return {
        passed: false,
        cards: 0,
        c1Text: c1.text,
        error: String(error),
        report: `## C3 抽取失败\n\n${String(error)}`,
      }
    }
  }

  const renderDream = (report: DreamReportRecord, elapsedMs: number): string => {
    const lines = [
      '## 梦境报告',
      '',
      `模式：${report.mode === 'manual' ? '手动' : '自动'} · 耗时 ${Math.round(elapsedMs / 1000)}s`,
      `处理：${report.segments} 段 · 落卡 ${report.cards} 张 · 拒绝 ${report.rejected} 段 · 跳过 ${report.skipped} 段`,
      `N3：衰减 ${report.decayed} 张 · 归档 ${report.archived} 张 · REM 假设 ${report.hypotheses} 条`,
      `分层：清理原文 ${report.tieredSegments} 段 · 超龄归档 ${report.tieredCards} 张`,
      report.fidelity === null ? '平均保真度：—' : `平均保真度：${report.fidelity.toFixed(2)}`,
      '',
    ]
    if (report.notes.length > 0) {
      lines.push('### 明细')
      for (const note of report.notes) lines.push(`- ${note}`)
      lines.push('')
    }
    lines.push(`当前压力：${computePressure().toFixed(2)} · 记忆卡：${repo.all().length} 张`)
    return lines.join('\n')
  }

  const runSleep = async (mode: 'manual' | 'auto'): Promise<string> => {
    if (sleeping) return '## 梦境报告\n\n上一次整理还在进行中。'
    sleeping = true
    const startedAt = Date.now()
    const notes: string[] = []
    let segments = 0
    let cards = 0
    let rejected = 0
    let skipped = 0
    let fidelitySum = 0
    let fidelityCount = 0

    try {
      await repo.ready()
      const budget = mode === 'manual' ? 3 : 2
      const candidates = pendingSegments()
        .sort((a, b) => b.segment.seqStart - a.segment.seqStart)
        .slice(0, budget)

      if (candidates.length === 0) return '## 梦境报告\n\n没有待整理的片段。'

      for (const item of candidates) {
        const route = routes.get(item.episode.sessionId) ?? lastRoute
        if (!route) {
          skipped += 1
          notes.push(`${item.segment.id}：没有模型路由`)
          continue
        }

        segments += 1
        const outcome = await runExtraction(item, route, { fidelity: true, questions: 5 })
        await repo.saveSegment({
          id: item.segment.id,
          sessionId: item.episode.sessionId,
          seqStart: item.segment.seqStart,
          seqEnd: item.segment.seqEnd,
          c1Text: outcome.c1Text,
          tokens: item.segment.tokens,
          createdAt: Date.now(),
        })
        await repo.markProcessed(item.segment.id)

        if (outcome.error) {
          skipped += 1
          notes.push(`${item.segment.id}：${outcome.error}`)
        } else if (outcome.passed) {
          cards += outcome.cards
          if (outcome.fidelity) {
            fidelitySum += outcome.fidelity.score
            fidelityCount += 1
          }
          notes.push(`${item.segment.id}：落卡 ${outcome.cards} 张`)
        } else {
          rejected += 1
          if (outcome.fidelity) {
            fidelitySum += outcome.fidelity.score
            fidelityCount += 1
          }
          notes.push(`${item.segment.id}：保真度不足，未落卡`)
        }
      }

      // 年龄分层先于权重衰减：否则 30 天规则会被衰减先一步归档，统计归属错位。
      const tieredSegments = await repo.ageSegments(7)
      const tieredCards = await repo.ageCards(30, 0.3)

      const decay = await repo.decay()
      if (decay.archived > 0) {
        notes.push(`N3 衰减 ${decay.decayed} 张，归档 ${decay.archived} 张`)
      }

      let hypotheses = 0
      if (mode === 'manual' && lastRoute && repo.activeCards().length >= 4) {
        try {
          const created = await runRem(ctx, lastRoute, repo.activeCards(), AbortSignal.timeout(120_000))
          if (created.length > 0) {
            await repo.merge(created)
            hypotheses = created.length
            notes.push(`REM 联想新增 ${created.length} 条待评审假设`)
          }
        } catch (error) {
          notes.push(`REM 联想失败：${String(error).slice(0, 80)}`)
        }
      }

      const indexCards = await repo.rollupIndex()
      if (tieredSegments > 0 || tieredCards > 0 || indexCards > 0) {
        notes.push(`年龄分层：清理原文 ${tieredSegments} 段 · 归档 ${tieredCards} 张 · 索引 ${indexCards} 张`)
      }

      const report: DreamReportRecord = {
        id: `dream_${Date.now().toString(36)}`,
        at: Date.now(),
        mode,
        segments,
        cards,
        rejected,
        skipped,
        fidelity: fidelityCount > 0 ? fidelitySum / fidelityCount : null,
        decayed: decay.decayed,
        archived: decay.archived,
        hypotheses,
        tieredSegments,
        tieredCards,
        notes,
      }
      await repo.saveReport(report)
      return renderDream(report, Date.now() - startedAt)
    } finally {
      sleeping = false
    }
  }

  const autoCheck = async (): Promise<void> => {
    try {
      await repo.ready()
      if (sleeping) return
      if (Date.now() - lastActivityAt < IDLE_BEFORE_SLEEP_MS) return
      if (computePressure() < PRESSURE_THRESHOLD) return
      if (pendingSegments().length === 0) return
      ctx.logger.info('[rem] auto sleep starting (pressure=%s)', computePressure().toFixed(2))
      await runSleep('auto')
    } catch (error) {
      ctx.logger.warn('[rem] auto sleep failed: %s', String(error))
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { void autoCheck() }, SLEEP_INTERVAL_MS)
    // 测试/短生命周期进程不应被这个定时器吊住。
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref()
    }
    return () => clearInterval(timer)
  })

  // 观察所有已提交的会话事件。监听器抛错不会影响已提交的日志，这里自己兜底。
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = String(session.id)
      runtime.sessions.add(sessionId)
      runtime.events += 1

      const cwd = session.header?.cwd
      if (cwd) {
        sessionCwd.set(sessionId, cwd)
        if (!snapshotted.has(sessionId)) {
          snapshotted.add(sessionId)
          void writeSnapshot(sessionId)
        }
      }

      // 插件可能在会话中途才加载：第一次见到某个会话时回放最近的日志，
      // 让切片覆盖插件加载之前的轮次。Segmenter 按 seq 去重，回放与实时不会重复。
      if (!backfilled.has(sessionId)) {
        backfilled.add(sessionId)
        try {
          const history = session.snapshotEvents()
          const tail = history.slice(Math.max(0, history.length - 4000))
          for (const past of tail) {
            const observed = past as unknown as ObservedEvent
            noteRoute(sessionId, observed)
            segmenter.observe(sessionId, observed)
          }
          if (tail.length > 0) ctx.logger.info('[rem] backfilled %d events for %s', tail.length, sessionId)
        } catch (error) {
          ctx.logger.warn('[rem] backfill failed: %s', String(error))
        }
      }

      noteRoute(sessionId, event as unknown as ObservedEvent)

      lastActivityAt = Date.now()

      switch (event.type) {
        case 'turn/end':
          runtime.turns += 1
          break
        case 'tool/call':
          runtime.toolCalls += 1
          break
        case 'user/message':
          runtime.corrections += 1
          break
        default:
          break
      }

      segmenter.observe(sessionId, event as unknown as ObservedEvent)
    } catch (error) {
      ctx.logger.warn('[rem] failed to observe session event: %s', String(error))
    }
  })

  // 会话离开时把未满阈值的尾巴切出来。
  ctx.on('session/disposed', session => {
    try {
      segmenter.flush(String(session.id))
    } catch (error) {
      ctx.logger.warn('[rem] failed to flush session: %s', String(error))
    }
  })

  ctx.tools.register(defineTool({
    name: 'memory_status',
    description:
      '查看「梦忆」记忆系统的运行状态：本次 Host 运行期间观察到的会话数、事件数、轮次、切片数量与睡眠压力。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      await repo.ready()
      const uptimeMinutes = Math.max(1, Math.round((Date.now() - runtime.startedAt) / 60000))
      const slices = segmenter.stats()
      const store = repo.status()
      const pressure = computePressure()
      const sleep = pressure >= PRESSURE_THRESHOLD ? '够困了，可以睡' : '还不困'
      const lastDream = repo.lastReport()
      const activeCards = repo.activeCards()
      const now = Date.now()
      const hot = activeCards.filter(card => now - card.createdAt < 7 * 864e5).length
      const warm = activeCards.filter(card => {
        const age = now - card.createdAt
        return age >= 7 * 864e5 && age < 30 * 864e5
      }).length
      const cold = activeCards.length - hot - warm
      return [
        '## 梦忆 · 运行状态',
        '',
        `- 已观察会话：${runtime.sessions.size}`,
        `- 事件 / 轮次：${runtime.events} / ${runtime.turns}`,
        `- 工具调用：${runtime.toolCalls}`,
        `- 切片：${slices.segments} 段 / ${slices.turns} 轮（${slices.episodes} 个 Episode）`,
        `- 已整理：${store.processed} 段`,
        `- 记忆卡：${repo.activeCards().length} 张活跃 · ${repo.pendingCards().length} 张待评审（${store.mode === 'storage' ? '已持久化' : '仅内存'}）`,
        `- 分层：hot ${hot} · warm ${warm} · cold ${cold}`,
        ...(store.failure ? [`- 存储错误：${store.failure.slice(0, 120)}`] : []),
        `- 睡眠压力：${pressure.toFixed(2)} / ${PRESSURE_THRESHOLD.toFixed(2)}（${sleep}）`,
        lastDream
          ? `- 上次睡眠：${new Date(lastDream.at).toLocaleString()} · 落卡 ${lastDream.cards} 张 · 拒绝 ${lastDream.rejected} 段`
          : '- 上次睡眠：还没睡过',
        `- 已运行：${uptimeMinutes} 分钟`,
        '',
        '> P4：睡眠 / N3 衰减 / REM 联想 / 评审队列 / 年龄分层已生效。',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_episodes',
    description:
      '列出「梦忆」当前已切出的会话片段（Episode/Segment）：每段的类型、目标、动作、失败与 token 估算。',
    parameters: {
      limit: { type: 'number', description: '最多返回多少个 Episode，默认 5' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 20) : 5
      const episodes = segmenter.list().slice(0, limit)
      const stats = segmenter.stats()

      if (episodes.length === 0) {
        return [
          '## 会话切片',
          '',
          '还没有切出片段。发几轮对话后再试。',
          '',
          `当前：${stats.segments} 段 / ${stats.turns} 轮。`,
        ].join('\n')
      }

      const lines = [
        '## 会话切片',
        '',
        `共 ${stats.episodes} 个 Episode · ${stats.segments} 段 · ${stats.turns} 轮 · ${formatTokens(stats.tokens)}`,
        '',
      ]

      for (const episode of episodes) {
        lines.push(`### ${episode.id} · ${episode.segments.length} 段 · ${episode.turns} 轮 · ${formatTokens(episode.tokens)}`)
        if (episode.segments.length === 0 && episode.pendingTurns > 0) {
          lines.push(`- 未成段：${episode.pendingTurns} 轮（攒够 3 轮或 500 token 后成段；会话结束时也会切出）`)
        }
        for (const segment of episode.segments.slice(-8)) {
          const meta = [
            `turn ${segment.turnStart}–${segment.turnEnd}`,
            formatTokens(segment.tokens),
            segment.actions.length ? `动作 ${segment.actions.join('/')}` : '无工具',
            segment.failures.length ? `${segment.failures.length} 次失败` : '',
          ].filter(Boolean).join(' · ')
          lines.push(`- [${segment.kind}] ${segment.goal}`)
          lines.push(`  - ${meta}`)
          if (segment.failures.length) lines.push(`  - 失败：${segment.failures[0]}`)
        }
        if (episode.segments.length > 8) lines.push(`- … 另有 ${episode.segments.length - 8} 段`)
        lines.push('')
      }

      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_compress',
    description:
      '对最近切出的一段会话做 C1 规则清洗（工具输出折叠、diff 压缩、重复调用合并、脱敏），返回压缩前后的 token、规则命中与预览。',
    parameters: {
      segment: { type: 'string', description: '指定 segment id；省略则取最新一段' },
      preview: { type: 'number', description: '预览行数，默认 30' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const episodes = segmenter.list()
      const all = episodes.flatMap(episode => episode.segments.map(segment => ({ episode, segment })))
      if (all.length === 0) {
        return '## C1 清洗报告\n\n还没有可清洗的片段。发几轮对话后再试。'
      }

      const wanted = typeof args.segment === 'string' ? all.find(item => item.segment.id === args.segment) : undefined
      const newest = episodes[0]?.segments[episodes[0].segments.length - 1]
      const picked = wanted ?? (newest ? { episode: episodes[0], segment: newest } : all[all.length - 1])
      const result = cleanBlocks(picked.segment.raw)
      const previewLines = typeof args.preview === 'number' && args.preview > 0
        ? Math.min(Math.floor(args.preview), 200)
        : 30
      const preview = result.text.split('\n').slice(0, previewLines).join('\n')

      return [
        '## C1 清洗报告',
        '',
        `段：${picked.segment.id} · [${picked.segment.kind}] ${picked.segment.goal}`,
        `范围：turn ${picked.segment.turnStart}–${picked.segment.turnEnd} · ${picked.segment.actions.length} 个动作 · ${picked.segment.failures.length} 次失败`,
        '',
        `- 字符：${formatNumber(result.beforeChars)} → ${formatNumber(result.afterChars)}`,
        `- token 估算：${formatNumber(result.beforeTokens)} → ${formatNumber(result.afterTokens)}（${result.ratio.toFixed(1)}×）`,
        `- 规则命中：截断 ${result.hits.truncate} · 合并 ${result.hits.merge} · 删除 ${result.hits.drop} · 脱敏 ${result.hits.redact}`,
        ...(result.ratio <= 1.05 ? ['- 结论：本段过小，C1 无明显收益（建议跳过）'] : []),
        '',
        '### 预览',
        '',
        '```text',
        preview,
        '```',
        '',
        previewLines < result.text.split('\n').length
          ? `（共 ${result.text.split('\n').length} 行，已截取前 ${previewLines} 行）`
          : '（全文）',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_narrate',
    description:
      '用当前会话的模型把最新一段（或指定段）做 C2 叙事压缩，输出结构化的目标、动作、结果、决定与失败。',
    parameters: {
      segment: { type: 'string', description: '指定 segment id；省略则取最新一段' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const episodes = segmenter.list()
      const all = episodes.flatMap(episode => episode.segments.map(segment => ({ episode, segment })))
      if (all.length === 0) return '## C2 叙事报告\n\n还没有可叙事的片段。'

      const wanted = typeof args.segment === 'string' ? all.find(item => item.segment.id === args.segment) : undefined
      const newest = episodes[0]?.segments[episodes[0].segments.length - 1]
      const picked = wanted ?? (newest ? { episode: episodes[0], segment: newest } : all[all.length - 1])

      const route = routes.get(picked.episode.sessionId) ?? lastRoute
      if (!route) return '## C2 叙事报告\n\n还没有可用的模型路由（本会话尚未发生模型调用）。'

      const c1 = cleanBlocks(picked.segment.raw)
      if (!c1.text.trim()) return '## C2 叙事报告\n\n这一段没有可压缩的文本。'

      const startedAt = Date.now()
      try {
        const result = await narrate(ctx, route, c1.text, AbortSignal.timeout(90_000))
        narratives.set(picked.segment.id, result.narrative)
        const narrative = result.narrative
        const lines = [
          '## C2 叙事报告',
          '',
          `段：${picked.segment.id} · [${picked.segment.kind}] ${picked.segment.goal}`,
          `模型：${route.provider}/${route.model} · ${Date.now() - startedAt}ms`,
          `输入：${formatNumber(result.inputChars)} 字符${result.truncated ? '（已截断）' : ''}`,
          result.usage
            ? `token：${formatNumber(result.usage.inputTokens)} → ${formatNumber(result.usage.outputTokens)}`
            : 'token：（模型未报告）',
          '',
          '### 叙事',
          `- 目标：${narrative.goal || picked.segment.goal}`,
          narrative.actions.length > 0
            ? `- 动作：\n${narrative.actions.map((action, index) => `  ${index + 1}. ${action}`).join('\n')}`
            : '- 动作：（无）',
          `- 结果：${narrative.result || '（未给出）'}`,
          narrative.decisions.length > 0 ? `- 决定：${narrative.decisions.join('；')}` : null,
          narrative.failures.length > 0 ? `- 失败：${narrative.failures.join('；')}` : null,
          '',
          '### 原始 JSON',
          '',
          '```json',
          result.raw.trim(),
          '```',
        ].filter((line): line is string => line !== null)
        return lines.join('\n')
      } catch (error) {
        return ['## C2 叙事失败', '', String(error)].join('\n')
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_extract',
    description:
      '对最新一段做 C3 抽取：先生成 C2 叙事，再抽记忆卡，并用保真度考试决定是否落卡。',
    parameters: {
      segment: { type: 'string', description: '指定 segment id；省略则取最新一段' },
      fidelity: { type: 'boolean', description: '是否跑保真度考试，默认 true' },
      questions: { type: 'number', description: '保真度题目数量，默认 6' },
    },
    timeoutMs: 300_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await repo.ready()
      const picked = pickSegment(typeof args.segment === 'string' ? args.segment : undefined)
      if (!picked) return '## C3 抽取报告\n\n还没有可抽取的片段。'

      const route = routes.get(picked.episode.sessionId) ?? lastRoute
      if (!route) return '## C3 抽取报告\n\n还没有可用的模型路由。'

      const c1 = cleanBlocks(picked.segment.raw)
      if (!c1.text.trim()) return '## C3 抽取报告\n\n这一段没有可抽取的文本。'

      await repo.saveSegment({
        id: picked.segment.id,
        sessionId: picked.episode.sessionId,
        seqStart: picked.segment.seqStart,
        seqEnd: picked.segment.seqEnd,
        c1Text: c1.text,
        tokens: picked.segment.tokens,
        createdAt: Date.now(),
      })

      const signal = AbortSignal.timeout(240_000)
      const startedAt = Date.now()
      try {
        const narration = await narrate(ctx, route, c1.text, signal)
        const extracted = await extractCards(ctx, route, {
          narrative: narration.narrative,
          excerpt: c1.text.slice(0, 1200),
          segment: picked.segment,
          sessionId: picked.episode.sessionId,
        }, signal)

        if (extracted.length === 0) {
          return '## C3 抽取报告\n\n没有抽出高 salience 的记忆卡。'
        }

        let fidelity: Awaited<ReturnType<typeof runFidelity>> | undefined
        if (args.fidelity !== false) {
          const durable = durableNarrativeText(narration.narrative)
          fidelity = await runFidelity(ctx, route, {
            source: durable || narrativeText(narration.narrative),
            compressed: cardsToText(extracted),
            count: typeof args.questions === 'number' ? args.questions : 6,
          }, signal)
        }

        const threshold = 0.95
        const passed = !fidelity || fidelity.score >= threshold
        if (passed) await repo.merge(extracted)
        await repo.markProcessed(picked.segment.id)
        void writeSnapshot(picked.episode.sessionId)

        const lines = [
          '## C3 抽取报告',
          '',
          `段：${picked.segment.id} · [${picked.segment.kind}] ${picked.segment.goal}`,
          `模型：${route.provider}/${route.model} · ${Date.now() - startedAt}ms`,
          `候选卡：${extracted.length} 张 · 已存：${repo.all().length} 张`,
          fidelity
            ? `保真度：${fidelity.passed}/${fidelity.total}（${fidelity.score.toFixed(2)}）· 阈值 ${threshold}`
            : '保真度：已跳过',
          '',
          '### 卡片',
        ]

        extracted.forEach((card, index) => {
          lines.push(`${index + 1}. [${card.type}] ${card.title}`)
          if (card.conclusion) lines.push(`   结论：${card.conclusion}`)
          if (card.why) lines.push(`   为什么：${card.why}`)
          if (card.how) lines.push(`   怎么做：${card.how}`)
          lines.push(`   salience ${card.salience.toFixed(2)} · confidence ${card.confidence.toFixed(2)}`)
        })

        if (fidelity) {
          const failed = fidelity.details.filter(detail => !detail.same)
          if (failed.length > 0) {
            lines.push('', '### 未通过的题')
            for (const detail of failed) {
              lines.push(`- [${detail.kind}] ${detail.q}`)
              lines.push(`  参考：${detail.expected}`)
              lines.push(`  实际：${detail.actual}`)
            }
          }
        }

        lines.push('', '### 结果')
        lines.push(passed
          ? `已落卡 ${extracted.length} 张。`
          : `未落卡：保真度低于 ${threshold}，请检查 C1/C2 是否压掉了关键信息。`)

        return lines.join('\n')
      } catch (error) {
        return ['## C3 抽取失败', '', String(error)].join('\n')
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_cards',
    description: '列出已落盘的记忆卡（标题、类型、salience、来源）。',
    parameters: {
      limit: { type: 'number', description: '最多返回多少张，默认 10' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await repo.ready()
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 10
      const all = repo.activeCards()
      if (all.length === 0) return '## 记忆卡\n\n还没有落卡的记忆。先运行 memory_extract。'

      const cards = [...all]
        .sort((a, b) => b.createdAt - a.createdAt || b.salience - a.salience)
        .slice(0, limit)
      const lines = [
        '## 记忆卡',
        '',
        `共 ${all.length} 张活跃${repo.pendingCards().length > 0 ? ` · ${repo.pendingCards().length} 张待评审` : ''}，显示前 ${cards.length} 张。`,
        '',
      ]
      cards.forEach((card, index) => {
        lines.push(`${index + 1}. [${card.type}] ${card.title}`)
        if (card.conclusion) lines.push(`   结论：${card.conclusion}`)
        const source = card.sources[0]
        const origin = source ? `${source.sessionId.slice(0, 12)}#${source.seqStart}-${source.seqEnd}` : '—'
        lines.push(`   salience ${card.salience.toFixed(2)} · confidence ${card.confidence.toFixed(2)} · 来源 ${origin} · id ${card.id}`)
      })
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '在已落盘的记忆卡里做关键词检索，返回最相关的几张。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词或问题' },
      k: { type: 'number', description: '返回条数，默认 5' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await repo.ready()
      const k = typeof args.k === 'number' && args.k > 0 ? Math.min(Math.floor(args.k), 20) : 5
      const hits = searchCards(repo.activeCards(), args.query, k)
      if (hits.length === 0) return `## 记忆检索：${args.query}\n\n没有找到相关记忆。`

      const lines = ['## 记忆检索：' + args.query, '', `命中 ${hits.length} 张。`, '']
      hits.forEach((hit, index) => {
        lines.push(`${index + 1}. [${hit.card.type}] ${hit.card.title}`)
        if (hit.card.conclusion) lines.push(`   结论：${hit.card.conclusion}`)
        lines.push(`   相关度 ${hit.score.toFixed(2)} · salience ${hit.card.salience.toFixed(2)} · id ${hit.card.id}`)
      })
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: '按 id 展开一张记忆卡的完整内容与来源。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆卡 id，例如 mem_xxx' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await repo.ready()
      const card = repo.all().find(item => item.id === args.id)
      if (!card) return `## 记忆卡\n\n找不到 id 为 ${args.id} 的卡片。`

      const lines = [
        `## ${card.title}`,
        '',
        `- 类型：${card.type}`,
        `- 范围：${card.scope}`,
        `- salience：${card.salience.toFixed(2)} · confidence：${card.confidence.toFixed(2)}`,
        `- 创建：${new Date(card.createdAt).toLocaleString()}`,
        '',
      ]
      if (card.conclusion) lines.push(`**结论**：${card.conclusion}`, '')
      if (card.why) lines.push(`**为什么**：${card.why}`, '')
      if (card.how) lines.push(`**怎么做**：${card.how}`, '')
      lines.push('**来源**：')
      for (const source of card.sources) {
        lines.push(`- ${source.sessionId}#${source.seqStart}-${source.seqEnd}`)
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_sleep',
    description: '手动触发一次睡眠整理：处理最新的未整理片段，落卡并生成梦境报告。',
    parameters: {},
    timeoutMs: 600_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      await repo.ready()
      return runSleep('manual')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_debug_file',
    description: '调试：用宿主 workspaceFiles.stat 检查快照文件是否对会话可见。',
    parameters: {
      path: { type: 'string', description: '默认 .rem/status.json' },
      session: { type: 'string', description: '默认最近观察到的会话 id' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const sessionId = typeof args.session === 'string'
        ? args.session
        : [...sessionCwd.keys()].at(-1)
      if (!sessionId) return '没有已知会话 id。'
      const root = sessionCwd.get(sessionId)
      if (!root) return `没有 ${sessionId} 的 cwd 记录。`

      const path = typeof args.path === 'string' ? args.path : '.rem/status.json'
      try {
        const stat = await ctx.workspaceFiles.stat(
          { sessionId: sessionId as never, workspaceRoot: root },
          path,
          new AbortController().signal,
        )
        return JSON.stringify({ sessionId, root, path, stat }, null, 2)
      } catch (error) {
        return `stat 失败：${String(error)}`
      }
    },
  }))

  // 命令：面板点“立即整理”时发送 /rem-sleep，由宿主直接执行，不经过模型。
  ctx.commands.register({
    name: 'rem-sleep',
    description: '整理记忆：处理最新的未整理片段并生成梦境报告',
    handler: async () => {
      try {
        const report = await runSleep('manual')
        return { kind: 'success', text: report }
      } catch (error) {
        return { kind: 'error', text: String(error) }
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'memory_expand',
    description: '按卡片 id 或 segment id 展开该片段保存的 C1 原文（最多 12000 字符）。',
    parameters: {
      card: { type: 'string', description: '记忆卡 id' },
      segment: { type: 'string', description: '片段 id，例如 seg_xxx' },
      maxChars: { type: 'number', description: '最多返回多少字符，默认 4000' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await repo.ready()

      let record
      if (typeof args.segment === 'string') {
        record = repo.getSegment(args.segment)
      } else if (typeof args.card === 'string') {
        const card = repo.all().find(item => item.id === args.card)
        if (!card) return `找不到卡片 ${args.card}。`
        const source = card.sources[0]
        if (!source) return '这张卡没有来源锚点。'
        record = repo.findSegmentByRange(source.sessionId, source.seqStart, source.seqEnd)
      } else {
        return '需要提供 card 或 segment 参数。'
      }

      if (!record) return '找不到对应的原文（可能已超过 500 段的保留上限）。'

      const max = typeof args.maxChars === 'number'
        ? Math.min(12_000, Math.max(500, Math.floor(args.maxChars)))
        : 4000
      const text = record.c1Text
      const shown = text.slice(0, max)
      return [
        '## 原文展开',
        '',
        `片段：${record.id}`,
        `会话：${record.sessionId} · seq ${record.seqStart}-${record.seqEnd}`,
        `长度：${text.length} 字符${text.length > shown.length ? `（已截断到 ${max}）` : ''}`,
        '',
        '```text',
        shown,
        '```',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_review',
    description: '查看待评审的 REM 假设，并接受或拒绝。',
    parameters: {
      action: { type: 'string', description: 'list | accept | reject，默认 list' },
      id: { type: 'string', description: 'accept / reject 时的卡片 id' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await repo.ready()
      const action = typeof args.action === 'string' ? args.action : 'list'

      if (action === 'list') {
        const pending = repo.pendingCards()
        if (pending.length === 0) return '## 待评审\n\n没有待评审的假设。REM 只会在睡眠时生成。'
        const lines = ['## 待评审（REM 假设）', '']
        pending.forEach((card, index) => {
          lines.push(`${index + 1}. ${card.title}`)
          if (card.conclusion && card.conclusion !== card.title) lines.push(`   ${card.conclusion}`)
          lines.push(`   confidence ${card.confidence.toFixed(2)} · id ${card.id}`)
        })
        lines.push('', '用 memory_review { action: "accept" | "reject", id } 处理。')
        return lines.join('\n')
      }

      if (typeof args.id !== 'string' || !args.id) return '需要提供 id。'
      const card = repo.all().find(item => item.id === args.id)
      if (!card) return `找不到 id 为 ${args.id} 的卡片。`

      if (action === 'accept') {
        await repo.setStatus(args.id, 'active', {
          weight: 0.6,
          salience: Math.max(card.salience, 0.4),
        })
        return `已接受 ${args.id}，转为活跃记忆（weight 0.6）。`
      }
      if (action === 'reject') {
        await repo.setStatus(args.id, 'archived')
        return `已拒绝 ${args.id}，归档。`
      }
      return 'action 只能是 list / accept / reject。'
    },
  }))

  ctx.logger.info('[rem] host plugin ready')
}

/** 供后续睡眠引擎与测试读取的运行时快照。 */
export function snapshot(): Readonly<RemRuntime> {
  return runtime
}

export { Segmenter }
export { cleanBlocks }
export { narrate, parseNarrative, selectWindow }
export { extractCards, mergeCards }
export { runFidelity }
export { completeJson } from './llm/complete'
export type { EpisodeView }

/** 把卡片序列化为"压缩版"，作为保真度考试的被测文本。 */
function cardsToText(cards: readonly MemoryCard[]): string {
  return cards.map(card => {
    const lines = [`[${card.type}] ${card.title}`]
    if (card.conclusion) lines.push(card.conclusion)
    if (card.why) lines.push(`原因：${card.why}`)
    if (card.how) lines.push(`做法：${card.how}`)
    return lines.join('\n')
  }).join('\n\n')
}

/** 从 request/context 或 request/header 里取本会话实际使用的模型路由。 */
function routeOf(event: ObservedEvent): LlmRoute | undefined {
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return undefined

  if (event.type === 'request/context') {
    const provider = data.provider
    const model = data.model
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  }

  if (event.type === 'request/header') {
    const header = data.header as Record<string, unknown> | undefined
    const config = header?.config as Record<string, unknown> | undefined
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }

  return undefined
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k tok` : `${value} tok`
}
