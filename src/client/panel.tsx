/**
 * 梦忆 · 侧栏面板（真实数据）
 *
 * 数据路径：宿主把快照写到 `<workspace>/.rem/status.json`，面板用
 * `useResource<'file'>` 定位文件（拿 absolutePath + version），再通过
 * 注入的 `readText`（remote.workspaceFiles.read）读取内容。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

interface RemInject {
  readText: (path: string) => Promise<string>
}

type Props = PropsRuntime<'sidebar.right.pane.tab'> & RemInject

const c = {
  dim: 'color-mix(in srgb, currentColor 60%, transparent)',
  faint: 'color-mix(in srgb, currentColor 40%, transparent)',
  line: 'color-mix(in srgb, currentColor 14%, transparent)',
  soft: 'color-mix(in srgb, currentColor 5%, transparent)',
  accent: '#7c6cff',
} as const

const TYPE_META: Record<string, { label: string; color: string }> = {
  failure: { label: '坑', color: '#e5484d' },
  decision: { label: '决策', color: '#3b82f6' },
  procedure: { label: '流程', color: '#8b5cf6' },
  preference: { label: '偏好', color: '#f59e0b' },
  fact: { label: '事实', color: '#10b981' },
  entity: { label: '实体', color: '#6b7280' },
}

interface SnapshotCard {
  id: string
  type: string
  title: string
  scope: string
  salience: number
}

interface DreamSummary {
  at: number
  cards: number
  rejected: number
  fidelity: number | null
  notes: string[]
}

interface RemSnapshot {
  version: number
  updatedAt: number
  cards: number
  processed: number
  pressure: number
  lastDream: DreamSummary | null
  top: SnapshotCard[]
}

export function RemPanel({ useTabInfo, sessionId, useResource, useInput, inputActions, readText }: Props) {
  const info = useTabInfo()
  const address = `dsh-resource://file/session/${sessionId}/.rem/status.json`
  const resource = useResource<'file'>(address)
  const absolutePath = resource.value?.absolutePath
  const version = resource.value?.version

  const [snapshot, setSnapshot] = useState<RemSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState(() => new Date())
  const [reloadToken, setReloadToken] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const draft = useInput((state: { draft: string }) => state.draft)

  const load = useCallback(async () => {
    if (!absolutePath) return
    setRefreshing(true)
    try {
      const text = await readText(absolutePath)
      try {
        const parsed = JSON.parse(text) as RemSnapshot
        setSnapshot(previous => previous && previous.updatedAt === parsed.updatedAt ? previous : parsed)
        setError(null)
      } catch {
        setError(`快照解析失败（${text.length} 字符）：${text.slice(0, 80)}`)
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setRefreshing(false)
    }
  }, [absolutePath, readText])

  useEffect(() => {
    void load()
  }, [load, version, reloadToken])

  // 宿主写快照后不一定有资源变更通知；面板打开期间每 5 秒兜底轮询一次。
  useEffect(() => {
    if (!absolutePath) return
    const timer = setInterval(() => { void load() }, 5_000)
    return () => clearInterval(timer)
  }, [absolutePath, load])

  const cards = snapshot?.top ?? []
  const visibleCards = showAll ? cards : cards.slice(0, 8)
  const pressure = snapshot?.pressure ?? 0
  const dream = snapshot?.lastDream ?? null
  const live = snapshot !== null

  const resourceState = resource.status
  const hint = error
    ? `读取失败：${error.slice(0, 80)}`
    : live
      ? `快照 ${new Date(snapshot.updatedAt).toLocaleTimeString()} · 已整理 ${snapshot.processed} 段`
      : resourceState === 'failed'
        ? `资源失败：${JSON.stringify(resource.failure).slice(0, 100)}`
        : resourceState === 'none'
          ? 'file 资源不可用（provider 未注册）'
          : resourceState === 'loading'
            ? '正在定位快照…'
            : absolutePath
              ? `已定位：${absolutePath}`
              : '等待文件定位…'

  const refresh = () => {
    setRefreshedAt(new Date())
    setReloadToken(value => value + 1)
  }

  const startSleep = () => {
    if (!inputActions) {
      setError('输入服务不可用，无法从面板触发整理')
      return
    }
    if (draft.trim().length > 0) {
      setError('输入框里有草稿，先清空再点「立即整理」')
      return
    }
    try {
      inputActions.setDraft('/rem-sleep')
      inputActions.submit()
      setError(null)
      setRefreshedAt(new Date())
      // 整理需要 30–90 秒，之后自动重读快照。
      setTimeout(() => setReloadToken(value => value + 1), 8_000)
      setTimeout(() => setReloadToken(value => value + 1), 30_000)
    } catch (reason) {
      setError(String(reason))
    }
  }

  const tabLabel = useMemo(
    () => String(info.tab.id).replace(/^tab[-_]?/, '').slice(0, 10),
    [info.tab.id],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13, lineHeight: 1.5 }}>
      <header style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${c.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 7, fontSize: 12,
            background: `color-mix(in srgb, ${c.accent} 18%, transparent)`,
            color: c.accent,
          }}>✦</span>
          <strong style={{ fontSize: 14, fontWeight: 600 }}>梦忆</strong>
          <span style={{
            marginLeft: 'auto', fontSize: 10.5, letterSpacing: '0.04em',
            padding: '1px 6px', borderRadius: 999,
            color: live ? '#047857' : '#b45309',
            background: live
              ? 'color-mix(in srgb, #10b981 16%, transparent)'
              : 'color-mix(in srgb, #f59e0b 16%, transparent)',
            border: `1px solid ${live
              ? 'color-mix(in srgb, #10b981 35%, transparent)'
              : 'color-mix(in srgb, #f59e0b 35%, transparent)'}`,
          }}>{live ? '实时' : '等待快照'}</span>
        </div>
        <p style={{ margin: '4px 0 0 30px', fontSize: 12, color: c.dim }}>
          记忆压缩 · 睡眠整理
        </p>
        <p style={{ margin: '6px 0 0 30px', fontSize: 10.5, color: c.faint }}>
          {hint}
        </p>
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Stat label="记忆" value={live ? String(snapshot.cards) : '—'} />
          <Stat label="压力" value={live ? pressure.toFixed(2) : '—'} hint="阈值 0.80" />
          <Stat label="上次睡眠" value={dream ? new Date(dream.at).toLocaleTimeString() : '—'} hint={dream ? `落卡 ${dream.cards}` : '还没睡过'} />
        </section>

        <section>
          <SectionTitle>睡眠压力</SectionTitle>
          <div style={{ height: 6, borderRadius: 999, background: c.line, overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(100, (pressure / 0.8) * 100)}%`,
              height: '100%',
              borderRadius: 999,
              background: 'linear-gradient(90deg, #6ee7b7, #7c6cff)',
              transition: 'width 240ms ease',
            }} />
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: c.faint }}>
            未整理片段的 token 量 ÷ 80K；空闲且 ≥0.80 时自动整理。
          </p>
        </section>

        <section>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 8,
            marginBottom: 8, fontSize: 11, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: c.faint,
          }}>
            <span>最近记忆</span>
            {cards.length > 8 ? (
              <button
                type="button"
                onClick={() => setShowAll(value => !value)}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none',
                  color: c.accent, cursor: 'pointer', font: 'inherit',
                  fontSize: 10.5, textTransform: 'none', letterSpacing: 0,
                }}
              >
                {showAll ? '收起' : `查看全部 ${cards.length}`}
              </button>
            ) : (
              <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>{cards.length} 条</span>
            )}
          </div>
          {cards.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: c.faint }}>还没有记忆卡。让我抽取一段后自动出现。</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visibleCards.map(card => {
                const meta = TYPE_META[card.type] ?? { label: card.type, color: '#6b7280' }
                return (
                  <li key={card.id} style={{
                    display: 'flex', gap: 8, alignItems: 'flex-start',
                    padding: '8px 9px', borderRadius: 8,
                    background: c.soft, border: `1px solid ${c.line}`,
                  }}>
                    <span style={{
                      flex: 'none', marginTop: 1, padding: '0 5px', borderRadius: 4,
                      fontSize: 10, lineHeight: '16px',
                      color: meta.color,
                      background: `color-mix(in srgb, ${meta.color} 16%, transparent)`,
                    }}>{meta.label}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {card.title}
                      </span>
                      <span style={{ display: 'block', marginTop: 2, fontSize: 10.5, color: c.faint }}>
                        {card.scope} · salience {card.salience.toFixed(2)}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle aside={dream ? '上次' : undefined}>梦境报告</SectionTitle>
          {dream && dream.notes.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 16, color: c.dim, fontSize: 12 }}>
              {dream.notes.slice(0, 5).map(note => <li key={note} style={{ marginBottom: 4 }}>{note}</li>)}
            </ul>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: c.faint }}>
              {dream ? '上次整理没有产生卡片。' : '还没有整理过。'}
            </p>
          )}
        </section>
      </div>

      <footer style={{ padding: '10px 14px 12px', borderTop: `1px solid ${c.line}` }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={startSleep}
            disabled={!inputActions}
            style={{ ...buttonStyle, opacity: inputActions ? 1 : 0.5, cursor: inputActions ? 'pointer' : 'not-allowed' }}
          >
            立即整理
          </button>
          <button type="button" onClick={refresh} style={buttonStyle}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 10.5, color: c.faint }}>
          已刷新 {refreshedAt.toLocaleTimeString()}
          {snapshot ? ` · 数据 ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : ''}
          {' · '}{info.tab.kind} · {sessionId.slice(0, 14)}
        </p>
      </footer>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ padding: '8px 9px', borderRadius: 8, background: c.soft, border: `1px solid ${c.line}` }}>
      <div style={{ fontSize: 10.5, color: c.faint }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 1 }}>{value}</div>
      {hint ? <div style={{ fontSize: 10, color: c.faint }}>{hint}</div> : null}
    </div>
  )
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 8,
      marginBottom: 8, fontSize: 11, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: c.faint,
    }}>
      <span>{children}</span>
      {aside ? <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>{aside}</span> : null}
    </div>
  )
}

const buttonStyle: CSSProperties = {
  flex: 1,
  padding: '7px 10px',
  borderRadius: 8,
  border: `1px solid ${c.line}`,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
