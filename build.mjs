/**
 * Build both halves of the plugin:
 *  - lib/index.js  — host ESM plugin (Node)
 *  - lib/client.js — browser bundle wrapped in DSH's __ModuleLoader__ envelope
 *
 * The browser half cannot be plain ESM: DSH's browser module system registers
 * factories via `window.__ModuleLoader__.load({ id, factory(require) })`, and
 * dependencies such as React are provided by the host through `require`.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const external = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@deepseek-ai/*',
]

await mkdir('lib', { recursive: true })

// Host half: ESM, loaded directly by the host Node process.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external,
  logLevel: 'warning',
})

// Client half: CJS first, then wrapped for the DSH module loader.
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/.client.body.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external,
  logLevel: 'warning',
})

const body = await readFile('lib/.client.body.cjs', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: "rem-memory",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
await writeFile('lib/client.js', wrapped, 'utf8')
await rm('lib/.client.body.cjs')

console.log('[rem-memory] built lib/index.js and lib/client.js')
