import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , cwd, token, preferredPort] = process.argv
const root = dirname(fileURLToPath(import.meta.url))
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] }
const MAX_BUFFER = 64 * 1024 * 1024
const UNTRACKED_MAX = 200

let state = { version: 0 }
let stateWaiters = []
let actions = []
let actionWaiters = []
let lastSeen = 0

function git(args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) =>
      resolve({ ok: !error || error.code === 1, stdout, stderr: String(stderr || error?.message || '') }),
    )
  })
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 8 * 1024 * 1024) req.destroy()
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
    files.map(file => git(['diff', '--no-color', '--no-index', ...(ignoreWhitespace ? ['-w'] : []), '--', '/dev/null', file])),
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
    mode === 'committed' ? '' : (await git(['diff', '--no-color', '-M', ...ws, 'HEAD'])).stdout + (await untrackedDiff(ws.length > 0))
  const diff =
    mode === 'uncommitted'
      ? pending
      : mode === 'all'
        ? (await git(['diff', '--no-color', '-M', ...ws, base])).stdout + (await untrackedDiff(ws.length > 0))
        : (await git(['diff', '--no-color', '-M', ...ws, base, row.branch])).stdout
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
    const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim()
    try {
      return { text: await readFile(join(top, path), 'utf8') }
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
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${server.address().port}`) return send(res, 403, { error: 'origin' })
    if (STATIC[url.pathname] && req.method === 'GET') {
      const [file, type] = STATIC[url.pathname]
      return send(res, 200, await readFile(join(root, file), 'utf8'), type)
    }
    if ((url.searchParams.get('t') ?? req.headers['x-token']) !== token) return send(res, 401, { error: 'token' })

    if (url.pathname === '/state' && req.method === 'POST') {
      publish(await readBody(req))
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
      actions.push(await readBody(req))
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
server.on('listening', () => console.log(`PORT ${server.address().port}`))
server.preferred = Boolean(Number(preferredPort))
server.listen(Number(preferredPort) || 0, '127.0.0.1')
watch(fileURLToPath(import.meta.url), () => process.exit(0))
