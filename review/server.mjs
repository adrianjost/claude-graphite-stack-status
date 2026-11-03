import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { watch } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , cwd, givenToken, preferredPort] = process.argv
const token = /^[0-9a-f]{64}$/.test(givenToken ?? '') ? givenToken : randomBytes(32).toString('hex')
const tokenBytes = Buffer.from(token)
const root = dirname(fileURLToPath(import.meta.url))
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] }
const MAX_BUFFER = 64 * 1024 * 1024
const UNTRACKED_MAX = 200

let state = { version: 0 }
let stateWaiters = []
let actions = []
let actionWaiters = []
let lastSeen = 0

function hasToken(value) {
  const given = Buffer.from(String(value ?? ''))
  return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes)
}

function git(args) {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) =>
      resolve({ ok: !error || error.code === 1, stdout, stderr: String(stderr || error?.message || '') }),
    )
  })
}

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...HEADERS, 'content-type': `${type}; charset=utf-8` })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > limit) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function publish(next) {
  state = { ...next, version: state.version + 1 }
  for (const wake of stateWaiters) wake()
  stateWaiters = []
}

function waitFor(list, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    list.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function untrackedDiff(ignoreWhitespace) {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'])
  const files = listed.stdout.split('\0').filter(Boolean).slice(0, UNTRACKED_MAX)
  const parts = await Promise.all(
    files.map(file => git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', ...(ignoreWhitespace ? ['-w'] : []), '--', '/dev/null', file])),
  )
  return parts.map(part => part.stdout).join('')
}

async function diffFor(query) {
  const rows = state.rows ?? []
  const row = rows.find(r => r.branch === query.get('branch'))
  if (!row || row.isTrunk) return { error: 'Pick a branch of the stack.' }
  const parent = query.get('compare') === 'trunk' ? state.trunk : row.parent
  if (!parent) return { error: `${row.branch} has no parent branch.` }
  const ws = query.get('ws') === '1' ? [] : ['-w']
  const base = (await git(['merge-base', parent, row.branch])).stdout.trim()
  if (!base) return { error: `${row.branch} and ${parent} share no history.` }
  const head = (await git(['rev-parse', row.branch])).stdout.trim()
  const isCurrent = row.branch === state.current
  const status = isCurrent ? (await git(['status', '--porcelain'])).stdout : ''
  const dirty = status.trim().length > 0
  const requested = query.get('uncommitted')
  const mode = isCurrent && dirty ? (requested === '0' ? 'committed' : requested === 'only' ? 'uncommitted' : 'all') : 'committed'
  const includeWorktree = mode !== 'committed'
  const pending =
    mode === 'committed' ? '' : (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, 'HEAD'])).stdout + (await untrackedDiff(ws.length > 0))
  const diff =
    mode === 'uncommitted'
      ? pending
      : mode === 'all'
        ? (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, base])).stdout + (await untrackedDiff(ws.length > 0))
        : (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, base, row.branch])).stdout
  const log = await git(['log', '--no-color', '--format=%h%x1f%s%x1f%an%x1f%cr', `${base}..${row.branch}`])
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, subject, author, when] = line.split('\x1f')
      return { sha, subject, author, when }
    })
  return { branch: row.branch, parent, base, head, diff, pending: mode === 'all' ? pending : '', commits, isCurrent, dirty, mode, includeWorktree }
}

async function fileFor(query) {
  const row = (state.rows ?? []).find(r => r.branch === query.get('branch'))
  const path = query.get('path') ?? ''
  if (!row || !path || path.startsWith('/') || path.split('/').includes('..')) return { error: 'unknown file' }
  if (query.get('worktree') === '1' && row.branch === state.current) {
    const top = await realpath((await git(['rev-parse', '--show-toplevel'])).stdout.trim())
    try {
      const real = await realpath(join(top, path))
      if (!real.startsWith(top + sep)) return { error: 'outside the repository' }
      return { text: await readFile(real, 'utf8') }
    } catch {
      return { error: 'unreadable' }
    }
  }
  const shown = await git(['show', `${row.branch}:${path}`])
  return shown.ok ? { text: shown.stdout } : { error: 'unreadable' }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const own = `127.0.0.1:${server.address().port}`
    if (req.headers.host !== own) return send(res, 403, { error: 'host' })
    const origin = req.headers.origin
    if (origin && origin !== `http://${own}`) return send(res, 403, { error: 'origin' })
    if (STATIC[url.pathname] && req.method === 'GET') {
      const [file, type] = STATIC[url.pathname]
      return send(res, 200, await readFile(join(root, 'dist', file), 'utf8'), type)
    }
    if (!hasToken(url.searchParams.get('t') ?? req.headers['x-token'])) return send(res, 401, { error: 'token' })

    if (url.pathname === '/state' && req.method === 'POST') {
      publish(await readBody(req, 8 * 1024 * 1024))
      return send(res, 200, { version: state.version, isConnected: Date.now() - lastSeen < 40_000 })
    }
    if (url.pathname === '/state') {
      lastSeen = Date.now()
      const since = Number(url.searchParams.get('v') ?? -1)
      if (state.version === since || state.version === 0) await waitFor(stateWaiters, 25_000)
      lastSeen = Date.now()
      return send(res, 200, state)
    }
    if (url.pathname === '/diff') return send(res, 200, await diffFor(url.searchParams))
    if (url.pathname === '/file') return send(res, 200, await fileFor(url.searchParams))
    if (url.pathname === '/action' && req.method === 'POST') {
      if (actions.length >= 20) return send(res, 429, { error: 'busy' })
      actions.push(await readBody(req, 256 * 1024))
      for (const wake of actionWaiters) wake()
      actionWaiters = []
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/actions') {
      if (!actions.length) await waitFor(actionWaiters, 25_000)
      const taken = actions
      actions = []
      return send(res, 200, taken)
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    send(res, 500, { error: String(error) })
  }
})

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && server.preferred) {
    server.preferred = false
    server.listen(0, '127.0.0.1')
  } else {
    console.error(String(error))
    process.exit(1)
  }
})
server.on('listening', () => console.log(`TOKEN ${token}\nPORT ${server.address().port}`))
server.preferred = Boolean(Number(preferredPort))
server.listen(Number(preferredPort) || 0, '127.0.0.1')
watch(fileURLToPath(import.meta.url), () => process.exit(0))
