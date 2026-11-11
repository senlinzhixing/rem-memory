/**
 * P1-5 · 保真度考试
 *
 * 从原文出 N 道题，再让模型只读压缩版回答，最后统一评分。
 * 题目覆盖事实/决策/失败/数值四类；数值与路径要求一致。
 *
 * 调用次数：出题 1 + 回答 N + 评分 1。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  asNumber,
  asRecord,
  asString,
  completeJson,
  completeText,
  type LlmRoute,
} from '../llm/complete'
import { selectWindow } from './c2'

export interface FidelityDetail {
  q: string
  kind: string
  expected: string
  actual: string
  same: boolean
}

export interface FidelityResult {
  score: number
  total: number
  passed: number
  details: FidelityDetail[]
  usage: { inputTokens: number; outputTokens: number }
}

const QUESTION_SYSTEM = `你是出题器。根据给定的「决策与失败教训」，出若干道能检验读者是否理解这段会话要点的题。

只出这四类：
- decision：为什么选 A 不选 B
- failure：什么失败了、教训是什么
- procedure：以后遇到同类问题该怎么做
- fact：哪条结论以后仍然成立

只输出 JSON 对象，不要解释：
{"questions":[{"q":"问题","a":"可从给定内容核实的答案","kind":"decision|failure|procedure|fact"}]}

严格禁止：
- 不要问本次运行的结果、数量、版本号、当前状态。
- 不要问实现细节（具体 token 数、变量名、行号）。
- 不要出开放题（「哪条结论仍然成立？」「以下哪个正确？」），每题必须指向一条具体决策或失败，并有唯一确定的答案。
- 不要出主观题或需要外部知识的题。`

const ANSWER_SYSTEM = `你是资料问答器。只根据给定资料回答，不要使用资料以外的知识。

规则：
- 资料里找不到就回答「不知道」。
- 答案尽量短，直接给结论。
- 不要解释推理过程。`

const JUDGE_SYSTEM = `你是评分器。判断每个「回答」是否回答了问题，并且与「参考答案」或「摘要」一致。

规则：
- 措辞不同但意思相同算一致。
- 数字、文件名、路径、命令必须完全一致，否则算不一致。
- 回答与参考答案不同，但同样被摘要支持且正确回答了问题，也算一致。
- 回答为「不知道」而参考答案有内容，算不一致。

只输出 JSON 对象，不要解释：
{"results":[{"index":0,"same":true}]}`

export async function runFidelity(
  ctx: Context,
  route: LlmRoute,
  input: { source: string; compressed: string; count?: number },
  signal?: AbortSignal,
): Promise<FidelityResult> {
  const count = Math.min(12, Math.max(3, input.count ?? 6))
  const usage = { inputTokens: 0, outputTokens: 0 }
  const addUsage = (value?: { inputTokens: number; outputTokens: number }) => {
    if (!value) return
    usage.inputTokens += value.inputTokens
    usage.outputTokens += value.outputTokens
  }

  // 1. 出题（题目基于会话摘要，考的是要点保留而非实现细节）
  const sourceWindow = selectWindow(input.source, 12_000)
  const questionResult = await completeJson(ctx, route, {
    system: QUESTION_SYSTEM,
    user: `摘要：\n${sourceWindow.text}\n\n题目数量：${count}`,
    maxTokens: 2200,
  }, signal)
  addUsage(questionResult.usage)

  const questions = parseQuestions(questionResult.value)
  if (questions.length === 0) throw new Error('出题失败：模型未返回可用题目')

  // 2. 只给压缩版，逐题回答
  const compressedWindow = selectWindow(input.compressed, 12_000)
  const details: FidelityDetail[] = []
  for (const question of questions) {
    const answerResult = await completeText(ctx, route, {
      system: ANSWER_SYSTEM,
      user: `资料：\n${compressedWindow.text}\n\n问题：${question.q}`,
      maxTokens: 300,
    }, signal)
    addUsage(answerResult.usage)
    details.push({
      q: question.q,
      kind: question.kind,
      expected: question.a,
      actual: answerResult.text.trim(),
      same: false,
    })
  }

  // 3. 一次性评分
  const judgeResult = await completeJson(ctx, route, {
    system: JUDGE_SYSTEM,
    user: JSON.stringify({
      source: sourceWindow.text,
      items: details.map((detail, index) => ({
        index,
        question: detail.q,
        reference: detail.expected,
        answer: detail.actual,
      })),
    }),
    maxTokens: 1500,
  }, signal)
  addUsage(judgeResult.usage)

  const verdicts = parseVerdicts(judgeResult.value)
  for (const detail of details) {
    const index = details.indexOf(detail)
    detail.same = verdicts[index] === true
  }

  const passed = details.filter(detail => detail.same).length
  return {
    score: details.length === 0 ? 0 : passed / details.length,
    total: details.length,
    passed,
    details,
    usage,
  }
}

interface Question {
  q: string
  a: string
  kind: string
}

function parseQuestions(value: unknown): Question[] {
  const record = asRecord(value)
  const list = Array.isArray(record.questions) ? record.questions : []
  return list
    .map(item => {
      const entry = asRecord(item)
      return {
        q: asString(entry.q),
        a: asString(entry.a),
        kind: asString(entry.kind) || 'fact',
      }
    })
    .filter(question => question.q.length > 0 && question.a.length > 0)
}

function parseVerdicts(value: unknown): boolean[] {
  const record = asRecord(value)
  const list = Array.isArray(record.results) ? record.results : []
  const verdicts: boolean[] = []
  for (const item of list) {
    const entry = asRecord(item)
    const index = asNumber(entry.index, -1)
    if (index < 0) continue
    verdicts[index] = entry.same === true
  }
  return verdicts
}
