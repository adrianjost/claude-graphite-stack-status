// Builds the git repositories the review page reads in the browser tests.
// Branch names match the fake world of the plugin tests, so the states those tests emit fit these repos.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const lines = (n, word) => Array.from({ length: n }, (_, i) => `export const ${word}${i + 1} = ${i + 1}`).join('\n') + '\n'
const svg = fill =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" rx="12" fill="${fill}"/></svg>\n`

function repo(name) {
  const dir = mkdtempSync(join(tmpdir(), `graphite-stack-${name}-`))
  // fixed dates, so every run gets the same commit hashes
  let time = Date.parse('2026-01-01T00:00:00Z') / 1000
  const git = (...args) => {
    time += 60
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.test', GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` },
    }).trim()
  }
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'commit.gpgsign', 'false')
  return { dir, git, write }
}

function base(r) {
  r.write('src/feature.ts', lines(12, 'feature'))
  r.write('src/logo.svg', svg('#8250df'))
  r.write('README.md', '# App\n\nA small app.\n')
  r.write('package-lock.json', '{\n  "lockfileVersion": 3\n}\n')
  r.git('add', '-A')
  r.git('commit', '-q', '-m', '🎉 init')
}

// main ← shared-story-intro ← parents-gate ← parents-questions (needs a restack), checked out on parents-gate with uncommitted changes
export function stackRepo() {
  const r = repo('stack')
  base(r)
  r.git('checkout', '-q', '-b', 'adrian/shared-story-intro')
  r.write('src/feature.ts', lines(12, 'feature').replace('feature2 = 2', 'feature2 = 20').replace('feature3 = 3', 'feature3 = 30'))
  r.write('src/intro.ts', 'export function intro(name: string) {\n  return `Hello ${name}`\n}\n')
  r.write('src/logo.svg', svg('#2da44e'))
  r.git('add', '-A')
  r.git('commit', '-q', '-m', '✨ Ask the shared story intro', '-m', 'Adds the intro question and a greener logo.')

  r.git('checkout', '-q', '-b', 'adrian/parents-gate')
  r.write(
    'src/feature.ts',
    lines(12, 'feature')
      .replace('feature2 = 2', 'feature2 = 200')
      .replace('feature3 = 3', 'feature3 = 300')
      .replace('feature4 = 4', 'feature4 = 400')
      .replace('export const feature7 = 7\n', '')
      .replace('export const feature8 = 8\n', ''),
  )
  r.write('src/gate.ts', 'export const isOpen = (age: number) => age >= 18\n')
  r.write('src/gate.test.ts', "import { isOpen } from './gate'\n\nif (!isOpen(18)) throw new Error('18 is open')\n")
  mkdirSync(join(r.dir, 'docs'), { recursive: true })
  r.git('mv', 'README.md', 'docs/README.md')
  r.git('add', '-A')
  r.git('commit', '-q', '-m', '✨ Gate the parents chapter')

  r.git('checkout', '-q', '-b', 'adrian/parents-questions')
  r.write('src/questions.ts', "export const questions = ['Where did they meet?', 'What did they do?']\n")
  r.git('add', '-A')
  r.git('commit', '-q', '-m', '✨ Ask the „Über die Eltern“ questions')

  // a new commit on the gate below, so parents-questions needs a restack
  r.git('checkout', '-q', 'adrian/parents-gate')
  r.write('src/gate.ts', 'export const isOpen = (age: number) => age >= 16\n')
  r.git('commit', '-q', '-am', '🐛 open the gate at 16')

  // uncommitted work on the checked-out branch
  r.write('src/gate.ts', 'export const isOpen = (age: number) => age >= 16 && age < 120\n')
  r.write('notes.md', 'Remember to ask about grandparents.\n')
  return r.dir
}

// main ← quick-fix, a branch without Graphite or a GitHub stack
export function plainRepo() {
  const r = repo('plain')
  base(r)
  r.git('checkout', '-q', '-b', 'adrian/quick-fix')
  r.write('src/feature.ts', lines(12, 'feature').replace('feature5 = 5', 'feature5 = 55'))
  r.git('commit', '-q', '-am', '🐛 fix feature five')
  return r.dir
}

export const TOKEN = 'b'.repeat(64)

// Starts the real review server on the repo; resolves with its base URL and a stop function.
export function startServer(dir) {
  const child = spawn(process.execPath, [join(root, 'review/server.mjs'), dir, TOKEN, '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', chunk => {
      out += chunk
      const port = /PORT (\d+)/.exec(out)?.[1]
      if (port) resolve({ base: `http://127.0.0.1:${port}`, stop: () => child.kill() })
    })
    child.on('exit', code => reject(new Error(`review server exited with ${code}`)))
  })
}

export async function api(base, path, body) {
  const response = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return response.json()
}
