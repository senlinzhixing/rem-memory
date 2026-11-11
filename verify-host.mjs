/**
 * 离线验证宿主 bundle：
 *  1. 动态 import lib/index.js（dsh-tools 用最小桩替换）；
 *  2. 用假 ctx 调用 apply，断言两个工具注册成功；
 *  3. 喂入伪造的 session/event，断言压力与切段结果；
 *  4. 真正执行 memory_status / memory_episodes。
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'

// 用最小桩替换 dsh-tools，避免测试时加载整条宿主依赖链。
register('./test/tools-stub.mjs', import.meta.url)

const mod = await import('./lib/index.js')

assert.equal(mod.name, 'dsh-rem')
assert.deepEqual(mod.inject, ['tools', 'llm', 'systemPrompt', 'storageDomain', 'workspaceFiles', 'commands'])

const registered = []
const listeners = new Map()

const logger = Object.assign(() => ({ info() {}, warn() {}, error() {}, debug() {} }), {
  info() {}, warn() {}, error() {}, debug() {},
})

const llm = {
  calls: [],
  async *stream(options) {
    llm.calls.push(options)
    const system = String(options.system ?? '')
    let payload
    if (system.includes('记忆抽取器')) {
      payload = JSON.stringify({
        cards: [
          { type: 'failure', title: 'conftest 顶层 import 导致循环导入', conclusion: '必须在 fixture 内延迟导入', why: '收集阶段模块尚未初始化', how: '把 import 移到 fixture 函数体', confidence: 0.9 },
          { type: 'decision', title: 'fixture 改用延迟导入', conclusion: '统一用函数内 import', why: '避开循环依赖', how: '每个 fixture 内部 import', confidence: 0.85 },
        ],
      })
    } else if (system.includes('联想器')) {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '')
      const count = (text.match(/^\d+\.\s/gm) ?? []).length
      payload = JSON.stringify({
        hypotheses: count >= 2
          ? [{ a: 1, b: 2, title: '两条经验可能同源', text: '下次遇到同类变更时，先核对验证脚本', confidence: 0.5 }]
          : [],
      })
    } else if (system.includes('出题器')) {
      payload = JSON.stringify({
        questions: [
          { q: '改了什么文件？', a: 'conftest.py', kind: 'fact' },
          { q: '为什么失败？', a: '循环导入', kind: 'failure' },
        ],
      })
    } else if (system.includes('资料问答器')) {
      payload = 'conftest.py'
    } else if (system.includes('评分器')) {
      payload = JSON.stringify({ results: [{ index: 0, same: true }, { index: 1, same: true }] })
    } else {
      payload = JSON.stringify({
        goal: '修好 pytest fixtures 的循环导入',
        actions: ['读取 conftest', '改为延迟导入', '补三个 fixture'],
        result: '测试全部通过',
        decisions: ['conftest 不 import 应用模块'],
        failures: ['循环导入'],
      })
    }
    yield { type: 'text-delta', index: 0, text: payload }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const prompts = []

const ctx = {
  effect(run) {
    return run()
  },
  on(name, callback) {
    listeners.set(name, callback)
    return () => {}
  },
  commands: {
    register(definition) {
      registered.push({ name: `/${definition.name}`, command: true })
      return () => {}
    },
  },
  systemPrompt: {
    context(entry) {
      prompts.push(entry)
      return () => {}
    },
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  llm,
  logger,
}

mod.apply(ctx)

const names = registered.map(tool => tool.name).sort()
assert.deepEqual(names.filter(name => !name.startsWith('/')), [
  'memory_cards',
  'memory_compress',
  'memory_debug_file',
  'memory_episodes',
  'memory_expand',
  'memory_extract',
  'memory_narrate',
  'memory_read',
  'memory_recall',
  'memory_review',
  'memory_sleep',
  'memory_status',
])
assert.ok(names.includes('/rem-sleep'), 'rem-sleep command should be registered')

const feed = listeners.get('session/event')
assert.equal(typeof feed, 'function')

const session = { id: 'session-6c1757d6-1111-2222', snapshotEvents: () => [] }
let seq = 0
const emit = (type, data) => {
  seq += 1
  feed(session, { type, seq, time: Date.now(), data })
}

const turn = (n, { user, tool, fail, answer }) => {  emit('turn/start', { turn: n })
  if (user) emit('user/message', { message: { role: 'user', content: [{ type: 'text', text: user }] } })
  if (tool) emit('tool/call', { turn: n, step: 1, callId: `c${n}`, name: tool, arguments: '{}' })
  if (tool) {
    emit('tool/result', {
      turn: n,
      step: 1,
      message: {
        role: 'tool',
        callId: `c${n}`,
        content: [{ type: 'text', text: fail ? 'ImportError: partially initialized module' : 'ok' }],
        isError: Boolean(fail),
      },
      ...(fail ? { error: { name: 'ToolError', code: 'E_FAIL' } } : {}),
    })
  }
  if (answer) {
    emit('assistant/message', {
      turn: n,
      step: 1,
      message: { content: [{ type: 'text', text: answer }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    })
  }
  emit('turn/end', { turn: n, reason: 'success' })
}

emit('request/context', { provider: 'deepseek-official', model: 'deepseek-flash' })
turn(1, { user: '帮我修 pytest fixtures 报错', tool: 'read', fail: true, answer: '找到循环导入，改成延迟导入。' })
turn(2, { user: '再补三个 fixture', tool: 'edit', answer: '已补上。' })
turn(3, { user: '顺手跑一下测试', tool: 'bash', answer: '全部通过。' })
turn(4, { user: '提交前再跑一次', tool: 'bash', answer: '通过。' })

// 模拟会话离开，把尾巴切出来。
listeners.get('session/disposed')?.(session)

const statusTool = registered.find(tool => tool.name === 'memory_status')
const episodesTool = registered.find(tool => tool.name === 'memory_episodes')

const status = await statusTool.execute({}, { signal: new AbortController().signal })
assert.ok(status.includes('已观察会话：1'), status)
assert.ok(status.includes('事件 / 轮次：25 / 4'), status)
assert.ok(status.includes('切片：2 段 / 4 轮'), status)

const episodes = await episodesTool.execute({}, { signal: new AbortController().signal })
assert.ok(episodes.includes('## 会话切片'), episodes)
assert.ok(episodes.includes('[debug]'), episodes)
assert.ok(episodes.includes('pytest'), episodes)
assert.ok(episodes.includes('失败'), episodes)

// 直接验证切段器的结构。
const segmenter = new mod.Segmenter()
let s = 0
const ev = (type, data) => segmenter.observe('session-abcdef12', { type, seq: ++s, time: 1000 + s, data })
ev('turn/start', { turn: 1 })
ev('user/message', { message: { role: 'user', content: [{ type: 'text', text: '重构缓存层\n\nCurrent runtime context. This snapshot supersedes earlier ones.' }] } })
ev('turn/end', { turn: 1, reason: 'success' })
ev('turn/start', { turn: 2 })
ev('user/message', { message: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
ev('turn/end', { turn: 2, reason: 'success' })
ev('turn/start', { turn: 3 })
ev('user/message', { message: { role: 'user', content: [{ type: 'text', text: '收尾' }] } })
ev('turn/end', { turn: 3, reason: 'success' })

const list = segmenter.list()
assert.equal(list.length, 1)
assert.equal(list[0].segments.length, 1)
assert.equal(list[0].segments[0].kind, 'refactor')
assert.equal(list[0].segments[0].goal, '重构缓存层')
assert.equal(list[0].segments[0].turnStart, 1)
assert.equal(list[0].segments[0].turnEnd, 3)

// 直接验证 C1 清洗规则。
const c1 = mod.cleanBlocks([
  { kind: 'user', text: '好的' },
  { kind: 'user', text: '帮我看看这个报错' },
  { kind: 'assistant', text: '先读文件' },
  { kind: 'tool-call', name: 'read', args: '{"path":"a.py"}' },
  { kind: 'tool-result', name: 'read', text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), isError: false },
  { kind: 'tool-call', name: 'bash', args: '{"cmd":"pytest"}' },
  { kind: 'tool-result', name: 'bash', text: Array.from({ length: 50 }, (_, i) => `out ${i}`).join('\n'), isError: true },
  { kind: 'tool-call', name: 'bash', args: '{"cmd":"pytest"}' },
  { kind: 'tool-result', name: 'bash', text: 'again', isError: false },
  { kind: 'user', text: 'token 是 sk-abcdefghijklmnop123456' },
])

assert.ok(c1.hits.drop >= 1, 'ack message should be dropped')
assert.ok(c1.hits.merge >= 1, 'duplicate call should be merged')
assert.equal(c1.hits.redact, 1, 'secret should be redacted')
assert.ok(c1.text.includes('[REDACTED]'), c1.text)
assert.ok(c1.text.includes('共 100 行'), c1.text)
assert.ok(c1.ratio > 1, `ratio should be > 1, got ${c1.ratio}`)

// 通过工具看一份完整报告。
const compressTool = registered.find(tool => tool.name === 'memory_compress')
const report = await compressTool.execute({}, { signal: new AbortController().signal })
assert.ok(report.includes('## C1 清洗报告'), report)
assert.ok(report.includes('规则命中'), report)
assert.ok(report.includes('### 预览'), report)

// C2：模型流聚合 + JSON 解析 + 报告
assert.equal(mod.parseNarrative('```json\n{"goal":"x"}\n```').goal, 'x')
const windowed = mod.selectWindow('a'.repeat(100), 40)
assert.equal(windowed.truncated, true)
assert.ok(windowed.text.includes('省略'), windowed.text)
assert.ok(windowed.text.startsWith('aaaa') && windowed.text.endsWith('aaaa'), windowed.text)
const narrateTool = registered.find(tool => tool.name === 'memory_narrate')
const narration = await narrateTool.execute({}, { signal: new AbortController().signal })
assert.ok(narration.includes('## C2 叙事报告'), narration)
assert.ok(narration.includes('\n\n### 叙事'), 'blank line before the narrative section')
assert.ok(narration.includes('修好 pytest fixtures 的循环导入'), narration)
assert.ok(narration.includes('deepseek-flash'), narration)
assert.equal(llm.calls.length, 1)
assert.equal(llm.calls[0].provider, 'deepseek-official')
assert.equal(llm.calls[0].model, 'deepseek-flash')
assert.ok(llm.calls[0].messages[0].content[0].text.length > 0)

// C3 抽取 + 保真度考试
const extractTool = registered.find(tool => tool.name === 'memory_extract')
const extracted = await extractTool.execute({ questions: 2 }, { signal: new AbortController().signal })
assert.ok(extracted.includes('## C3 抽取报告'), extracted)
assert.ok(extracted.includes('已落卡'), extracted)
assert.ok(extracted.includes('保真度：2/2'), extracted)
assert.ok(extracted.includes('conftest 顶层 import'), extracted)

const cardsTool = registered.find(tool => tool.name === 'memory_cards')
const listed = await cardsTool.execute({}, { signal: new AbortController().signal })
assert.ok(listed.includes('共 2 张'), listed)
assert.ok(listed.includes('循环导入'), listed)

// 检索、展开与简报注入
const recallTool = registered.find(tool => tool.name === 'memory_recall')
const recalled = await recallTool.execute({ query: '循环导入' }, { signal: new AbortController().signal })
assert.ok(recalled.includes('记忆检索'), recalled)
assert.ok(recalled.includes('循环导入'), recalled)

const idMatch = listed.match(/mem_[a-z0-9]+/)
assert.ok(idMatch, listed)
const readTool = registered.find(tool => tool.name === 'memory_read')
const detail = await readTool.execute({ id: idMatch[0] }, { signal: new AbortController().signal })
assert.ok(detail.includes('来源'), detail)

const expandTool = registered.find(tool => tool.name === 'memory_expand')
const expanded = await expandTool.execute({ card: idMatch[0] }, { signal: new AbortController().signal })
assert.ok(expanded.includes('## 原文展开'), expanded)
assert.ok(expanded.includes('片段：'), expanded)

const brief = prompts[0]?.text() ?? ''
assert.ok(brief.includes('记忆简报'), brief)
assert.ok(brief.includes('循环导入'), brief)

// 睡眠：处理剩余未整理片段并生成报告
const sleepTool = registered.find(tool => tool.name === 'memory_sleep')
const dream = await sleepTool.execute({}, { signal: new AbortController().signal })
assert.ok(dream.includes('## 梦境报告'), dream)
assert.ok(dream.includes('处理：'), dream)
assert.ok(dream.includes('N3：'), dream)

const reviewTool = registered.find(tool => tool.name === 'memory_review')
const pendingList = await reviewTool.execute({ action: 'list' }, { signal: new AbortController().signal })
assert.ok(pendingList.includes('待评审'), pendingList)
const pendingId = pendingList.match(/mem_[a-z0-9]+/)?.[0]
if (pendingId) {
  const accepted = await reviewTool.execute({ action: 'accept', id: pendingId }, { signal: new AbortController().signal })
  assert.ok(accepted.includes('已接受'), accepted)
}

const statusAfter = await statusTool.execute({}, { signal: new AbortController().signal })
assert.ok(statusAfter.includes('已整理：'), statusAfter)
assert.ok(statusAfter.includes('上次睡眠：'), statusAfter)

// 合并：同题卡片来源取并集、置信度取最大
const base = {
  id: 'mem_1', type: 'failure', scope: 'session:x', title: 'A B', conclusion: '', why: '', how: '',
  confidence: 0.5, salience: 0.8, sources: [{ sessionId: 's', seqStart: 1, seqEnd: 2 }], createdAt: 1,
}
const merged = mod.mergeCards([base], [{
  ...base, id: 'mem_2', confidence: 0.9, sources: [{ sessionId: 's', seqStart: 3, seqEnd: 4 }],
}])
assert.equal(merged.length, 1)
assert.equal(merged[0].sources.length, 2)
assert.equal(merged[0].confidence, 0.9)

// JSON 解析失败时应自动做一次修复重试
const retryCtx = {
  llm: {
    calls: 0,
    async *stream() {
      this.calls += 1
      const payload = this.calls === 1 ? '抱歉，我只能用自然语言回答。' : '{"ok":true}'
      yield { type: 'text-delta', index: 0, text: payload }
    },
  },
}
const retried = await mod.completeJson(retryCtx, { provider: 'p', model: 'm' }, { system: 's', user: 'u' })
assert.equal(retried.value.ok, true)
assert.equal(retryCtx.llm.calls, 2)

// 输出被 maxTokens 截断时，应直接用更大预算重发原请求
const truncCtx = {
  llm: {
    calls: 0,
    async *stream() {
      this.calls += 1
      if (this.calls === 1) {
        yield { type: 'text-delta', index: 0, text: '{"cards":[{"type"' }
        yield { type: 'finish', reason: { kind: 'length' } }
      } else {
        yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
      }
    },
  },
}
const truncatedRetry = await mod.completeJson(truncCtx, { provider: 'p', model: 'm' }, { system: 's', user: 'u', maxTokens: 900 })
assert.equal(truncatedRetry.value.ok, true)
assert.equal(truncCtx.llm.calls, 2)

// 回放：插件中途加载时，第一次见到会话应把历史补切出来。
const historical = [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: '历史任务：修登录' }] } } },
  { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: '已修好' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: 'success' } },
]
const replaySession = { id: 'session-replay-1', snapshotEvents: () => historical }
feed(replaySession, { type: 'turn/end', seq: 5, time: 5, data: { turn: 2, reason: 'success' } })
listeners.get('session/disposed')?.(replaySession)

const afterReplay = await episodesTool.execute({}, { signal: new AbortController().signal })
assert.ok(afterReplay.includes('历史任务'), afterReplay)
assert.ok(afterReplay.includes('2 个 Episode'), afterReplay)

console.log('[verify] host bundle OK')
console.log(status)
console.log('')
console.log(report.split('\n').slice(0, 12).join('\n'))
