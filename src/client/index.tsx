/**
 * 梦忆 · 客户端插件
 *
 * 在右侧栏注册 `rem` 页签类型与引导入口；正文通过注入的 `readText`
 * 读取宿主写在工作区的快照文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { RemPanel } from './panel'

export const name = 'dsh-rem-client'

export const inject = ['sidebarRightTabs', 'slots', 'remote', 'remote.workspaceFiles']

const TAB_ID = 'dsh-rem'

interface WorkspaceFilesRemote {
  workspaceFiles?: {
    read?: (
      sessionId: string,
      path: string,
      range?: { offset?: number; limit?: number },
      signal?: AbortSignal,
    ) => Promise<{ text?: string }>
  }
}

export function apply(ctx: Context): void {
  try {
    applyInner(ctx)
  } catch (error) {
    ctx.logger.error('[rem] client setup failed: %s', String(error))
    // 同时打到浏览器控制台，便于在 DevTools 里定位。
    console.error('[rem] client setup failed', error)
  }
}

function applyInner(ctx: Context): void {
  const remote = (ctx as unknown as { remote?: WorkspaceFilesRemote }).remote

  ctx.effect(
    () => ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: 'rem',
      title: () => '梦忆',
      guide: [{
        id: 'rem-home',
        order: 12,
        title: () => '梦忆',
        description: () => '记忆压缩与睡眠整理',
      }],
    }),
    'rem tab type',
  )

  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        inject: (sessionId: string) => ({
          readText: async (path: string) => {
            const read = remote?.workspaceFiles?.read
            if (!read) throw new Error('workspaceFiles.read 不可用')

            // 文件可能超过单页行数上限：按 offset/lines 分页读到 eof。
            const chunks: string[] = []
            let offset = 1
            for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
              const page = await read(
                sessionId,
                path,
                { offset },
                new AbortController().signal,
              ) as unknown
              const record = typeof page === 'string'
                ? { text: page, lines: 0, eof: true }
                : ((page as { value?: unknown })?.value
                  ?? (page as { data?: unknown })?.data
                  ?? page) as { text?: unknown; lines?: unknown; eof?: unknown }

              const text = record?.text
              if (typeof text !== 'string') {
                throw new Error(`read 返回异常：${JSON.stringify(page).slice(0, 120)}`)
              }
              chunks.push(text)

              const lines = typeof record.lines === 'number'
                ? record.lines
                : text.split('\n').length
              if (record.eof === true || lines === 0) break
              offset += lines
            }

            const text = chunks.join('\n')
            if (text.length === 0) throw new Error('read 返回空文本')
            return text
          },
        }),
      },
      RemPanel,
    )),
    'rem tab body',
  )
}
