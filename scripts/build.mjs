import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const src = 'review/src'
const out = 'review/dist'
const theme = name => readFile(`node_modules/highlight.js/styles/${name}.css`, 'utf8')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

await build({
  entryPoints: [`${src}/app.js`],
  outfile: `${out}/app.js`,
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  legalComments: 'eof',
  tsconfigRaw: {},
})

const css = [
  `@media (prefers-color-scheme: light) {\n${await theme('github')}\n}`,
  `@media (prefers-color-scheme: dark) {\n${await theme('github-dark')}\n}`,
  await readFile(`${src}/app.css`, 'utf8'),
].join('\n')
await writeFile(`${out}/app.css`, css)
await writeFile(`${out}/index.html`, await readFile(`${src}/index.html`, 'utf8'))
await writeFile(`${out}/better-github.svg`, await readFile(`${src}/better-github.svg`))
