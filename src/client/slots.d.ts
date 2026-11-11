/**
 * 最小化的 `ctx.slots` 类型声明。
 *
 * Slot 注册表的宿主声明由产品内置的 renderer 包提供，而该包未随
 * 0.2.2-rc.1 的公开客户端包一起发布。插件只需要 `inject` / `register`
 * 两个方法，这里按官方文档的运行时契约补齐，避免引入整个渲染器。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      /** 等待某个 slot 的声明就绪，回调返回注册的清理函数。 */
      inject(key: string, callback: () => () => void): () => void
      /** 向已声明的 slot 贡献一个 entry。 */
      register(entry: {
        name: string
        key?: string
        id?: string
        order?: number
        inject?: (...args: any[]) => any
      }, component: ComponentType<any>): () => void
    }
  }
}

export {}
