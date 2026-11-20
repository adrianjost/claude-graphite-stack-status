// Runs every test: the plugin's own tests under Claude Code, then the browser tests that render and screenshot
// what those tests drew. Arguments go to Playwright, e.g. `npm test -- --update-snapshots`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const claude = process.env.CLAUDE_CODE_EXECPATH || 'claude'
const out = 'tests/.out'

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const plugin = spawnSync(claude, ['plugin', 'test', '.'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
rmSync(out, { recursive: true, force: true })
let emitted = 0
for (const line of `${plugin.stdout}\n${plugin.stderr}`.split('\n')) {
  const m = /^@@(band|review) (\S+) (.*)$/.exec(line)
  if (!m) {
    if (line.trim()) console.log(line)
    continue
  }
  mkdirSync(`${out}/${m[1]}`, { recursive: true })
  writeFileSync(`${out}/${m[1]}/${m[2]}.json`, m[3])
  emitted++
}
if (plugin.error) console.error(`Couldn't run ${claude}: ${plugin.error.message}`)
if (plugin.status !== 0) process.exit(plugin.status ?? 1)
console.log(`\n${emitted} drawings handed to the browser tests\n`)

const browser = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(browser.status ?? 1)
