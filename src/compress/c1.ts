/**
 * P1-2 · C1 规则清洗
 *
 * 输入一个 Segment 的原始块序列，输出一段压缩后的可读文本。
 * 全部是确定性规则，不调模型，方便单测与复现。
 *
 * 规则（对齐设计稿 §5.2）：
 *  R1 工具结果截断     超长结果保留头尾
 *  R2 文件读取折叠     只留路径与首几行
 *  R3 命令压缩         失败留尾部，成功留首几行
 *  R4 diff 压缩        只留文件头与块头
 *  R5 重复调用合并     同名同参合并为 ×N 并吞掉结果
 *  R6 冗余消息删除     纯确认/寒暄
 *  R7 空白规整
 *  R8 敏感信息脱敏
 */
import type { RawBlock } from '../capture/segmenter'

export interface C1Options {
  /** 超过多少字符的工具结果触发截断。 */
  maxToolResultChars: number
  /** 截断时保留的行数（头/尾各一半）。 */
  maxResultLines: number
  maxAssistantChars: number
  maxUserChars: number
  maxArgsChars: number
  /** 脱敏正则（字符串形式，便于配置化）。 */
  redactPatterns: string[]
}

export const DEFAULT_C1: C1Options = {
  maxToolResultChars: 4000,
  maxResultLines: 20,
  maxAssistantChars: 4000,
  maxUserChars: 2000,
  maxArgsChars: 300,
  redactPatterns: [
    'sk-[A-Za-z0-9]{16,}',
    'ghp_[A-Za-z0-9]{20,}',
    'AKIA[0-9A-Z]{16}',
  ],
}

export interface C1RuleHits {
  truncate: number
  merge: number
  drop: number
  redact: number
}

export interface C1Result {
  text: string
  beforeChars: number
  afterChars: number
  beforeTokens: number
  afterTokens: number
  ratio: number
  hits: C1RuleHits
}

const READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'view', 'cat', 'open_file', 'open'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'pwsh', 'exec', 'terminal', 'run', 'cmd', 'sh'])
const ACK_RE = /^(好的?|好|嗯+|哦|ok|okay|继续|可以|行|收到|谢谢|thanks|thank you|yes|yep|y)[。.!！~～]*$/i

export function cleanBlocks(blocks: readonly RawBlock[], overrides: Partial<C1Options> = {}): C1Result {
  const options: C1Options = { ...DEFAULT_C1, ...overrides }
  const lines: string[] = []
  const hits: C1RuleHits = { truncate: 0, merge: 0, drop: 0, redact: 0 }
  const seenCalls = new Map<string, number>()
  let beforeChars = 0

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    switch (block.kind) {
      case 'user': {
        beforeChars += block.text.length
        const text = normalize(block.text)
        if (!text) break
        if (text.length <= 8 && ACK_RE.test(text)) {
          hits.drop += 1
          break
        }
        lines.push(`U: ${clip(text, options.maxUserChars, hits)}`)
        break
      }
      case 'assistant': {
        beforeChars += block.text.length
        const text = normalize(block.text)
        if (!text) break
        lines.push(`A: ${clip(text, options.maxAssistantChars, hits)}`)
        break
      }
      case 'tool-call': {
        beforeChars += block.name.length + block.args.length
        const key = `${block.name}\u0000${block.args}`
        const count = (seenCalls.get(key) ?? 0) + 1
        seenCalls.set(key, count)
        if (count > 1) {
          hits.merge += 1
          const next = blocks[i + 1]
          if (next?.kind === 'tool-result' && next.name === block.name) i += 1
          lines.push(`T(${block.name}) ×${count}（重复调用，结果已折叠）`)
          break
        }
        lines.push(`T(${block.name}) ${normalizeArgs(block.args, options.maxArgsChars, hits)}`)
        break
      }
      case 'tool-result': {
        beforeChars += block.text.length
        const text = normalize(block.text)
        lines.push(`R(${block.name})${block.isError ? ' [失败]' : ''}: ${compressResult(block.name, text, block.isError, options, hits)}`)
        break
      }
    }
  }

  let text = lines.join('\n')
  for (const pattern of options.redactPatterns) {
    try {
      const re = new RegExp(pattern, 'g')
      text = text.replace(re, () => {
        hits.redact += 1
        return '[REDACTED]'
      })
    } catch {
      // 配置里的非法正则不应中断清洗。
    }
  }

  const beforeTokens = Math.max(1, Math.ceil(beforeChars / 4))
  const afterTokens = Math.max(1, Math.ceil(text.length / 4))
  return {
    text,
    beforeChars,
    afterChars: text.length,
    beforeTokens,
    afterTokens,
    ratio: beforeTokens / afterTokens,
    hits,
  }
}

function compressResult(
  name: string,
  text: string,
  isError: boolean,
  options: C1Options,
  hits: C1RuleHits,
): string {
  if (!text) return '（空）'

  if (isDiff(text)) {
    const kept = text.split('\n').filter(line => /^(diff --git|index |--- |\+\+\+ |@@)/.test(line))
    const total = text.split('\n').length
    hits.truncate += 1
    return `${kept.slice(0, 40).join('\n')}\n…[diff ${total} 行，保留 ${Math.min(kept.length, 40)} 行]`
  }

  if (READ_TOOLS.has(name)) {
    const kept = firstNonEmptyLines(text, 3)
    const total = text.split('\n').length
    if (total > kept.length) hits.truncate += 1
    return `${kept.join('\n')}\n…[共 ${total} 行]`
  }

  if (SHELL_TOOLS.has(name)) {
    const all = text.split('\n')
    const kept = isError ? all.slice(-options.maxResultLines) : firstNonEmptyLines(text, 3)
    if (all.length > kept.length) hits.truncate += 1
    return `${kept.join('\n')}\n…[共 ${all.length} 行]`
  }

  const all = text.split('\n')
  if (text.length > options.maxToolResultChars || all.length > options.maxResultLines) {
    hits.truncate += 1
    const half = Math.max(2, Math.floor(options.maxResultLines / 2))
    const head = all.slice(0, half)
    const tail = all.slice(-half)
    return `${head.join('\n')}\n…（已省略 ${all.length - head.length - tail.length} 行 / ${text.length} 字符）\n${tail.join('\n')}`
  }

  return text
}

function isDiff(text: string): boolean {
  return /(^|\n)(diff --git |@@ )/.test(text)
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeArgs(args: string, limit: number, hits: C1RuleHits): string {
  const compacted = normalize(args).replace(/\n/g, ' ')
  if (!compacted) return '()'
  if (compacted.length <= limit) return compacted
  hits.truncate += 1
  return `${compacted.slice(0, limit)}…`
}

function clip(text: string, limit: number, hits: C1RuleHits): string {
  if (text.length <= limit) return text
  hits.truncate += 1
  return `${text.slice(0, limit)}…`
}

function firstNonEmptyLines(text: string, count: number): string[] {
  return text.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(0, count)
}
