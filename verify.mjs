/**
 * 离线验证客户端 bundle：
 *  1. 用假的 window.__ModuleLoader__ 捕获 loader 注册项；
 *  2. 用真实 react 执行 factory，得到插件模块；
 *  3. 用假 ctx 调用 apply，断言页签类型与正文席位都注册成功；
 *  4. 用 react-dom/server 渲染面板，断言关键文案出现。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

const captured = []
globalThis.window = { __ModuleLoader__: { load: entry => captured.push(entry) } }

const code = readFileSync('lib/client.js', 'utf8')
vm.runInThisContext(code, { filename: 'lib/client.js' })

assert.equal(captured.length, 1, 'client bundle must register exactly one loader entry')
const entry = captured[0]
assert.equal(entry.id, 'rem-memory', 'loader entry id must equal the package name')
assert.equal(typeof entry.factory, 'function')

const plugin = entry.factory(spec => require(spec))
assert.equal(plugin.name, 'dsh-rem-client')
assert.deepEqual(plugin.inject, ['sidebarRightTabs', 'slots', 'remote', 'remote.workspaceFiles'])

const seen = { tab: null, body: null, injected: [] }
const ctx = {
  effect(run) {
    const disposer = run()
    return disposer
  },
  sidebarRightTabs: {
    register(definition) {
      seen.tab = definition
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      seen.injected.push(key)
      callback()
      return () => {}
    },
    register(registration, component) {
      seen.body = { registration, component }
      return () => {}
    },
  },
}

plugin.apply(ctx)

assert.ok(seen.tab, 'tab type must be registered')
assert.equal(seen.tab.id, 'dsh-rem')
assert.equal(seen.tab.kind, 'rem')
assert.equal(seen.tab.title(), '梦忆')
assert.equal(seen.tab.guide.length, 1)
assert.equal(seen.tab.guide[0].title(), '梦忆')
assert.equal(seen.tab.guide[0].description(), '记忆压缩与睡眠整理')

assert.deepEqual(seen.injected, ['sidebar.right.pane.tab'])
assert.equal(seen.body.registration.name, 'sidebar.right.pane.tab')
assert.equal(seen.body.registration.key, 'dsh-rem')

const html = renderToStaticMarkup(React.createElement(seen.body.component, {
  sessionId: 'session-test',
  useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
  readText: async () => '',
  useInput: selector => selector({ draft: '' }),
  inputActions: { setDraft() {}, submit() {} },
  useTabInfo: () => ({
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1', isFloating: false },
    tab: { id: 'tab-1', kind: 'rem', title: '梦忆', contentId: 'sidebar://rem' },
  }),
}))

for (const text of ['梦忆', '最近记忆', '梦境报告', '睡眠压力']) {
  assert.ok(html.includes(text), `rendered panel must contain ${text}`)
}

console.log('[verify] client bundle OK')
console.log(`[verify] html length = ${html.length}`)
