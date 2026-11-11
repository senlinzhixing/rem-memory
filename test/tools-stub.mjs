/**
 * 测试用 loader 钩子：把宿主侧的重依赖换成最小桩，避免为了跑单元验证
 * 而拉入整条 DSH 依赖链。
 *
 * 只验证本插件对这些契约的使用方式，不验证宿主实现本身。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: 'stub:dsh-tools', shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-storage-domain') {
    return { url: 'stub:storage-domain', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === 'stub:dsh-tools') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
export function defineTool(options) {
  if (!options || typeof options.name !== 'string' || typeof options.execute !== 'function') {
    throw new Error('defineTool: invalid definition')
  }
  return { ...options }
}
`,
    }
  }

  if (url === 'stub:storage-domain') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
export function defineDomain(spec) { return spec }
export function domainTable(schema) { return { valueSchema: schema } }
`,
    }
  }

  return nextLoad(url, context)
}
