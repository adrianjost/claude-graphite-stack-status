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
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'], '/badge.svg': ['badge.svg', 'image/svg+xml'] }
const MAX_BUFFER = 64 * 1024 * 1024
const UNTRACKED_MAX = 200

let state = { version: 0 }
let stateWaiters = []
let actions = []
let actionWaiters = []
let nextActionId = 1
const delivered = new Map()

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
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://github.com https://*.githubusercontent.com; media-src https://github.com https://*.githubusercontent.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
    const wake = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      list.splice(list.indexOf(wake) >>> 0, 1)
      resolve()
    }, ms)
    list.push(wake)
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
  const mode = row.uncommittedOnly ? 'uncommitted' : isCurrent && dirty ? (requested === '0' ? 'committed' : requested === 'only' ? 'uncommitted' : 'all') : 'committed'
  const includeWorktree = mode !== 'committed'
  const pending =
    mode === 'committed' ? '' : (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, 'HEAD'])).stdout + (await untrackedDiff(ws.length > 0))
  const diff =
    mode === 'uncommitted'
      ? pending
      : mode === 'all'
        ? (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, base])).stdout + (await untrackedDiff(ws.length > 0))
        : (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, base, row.branch])).stdout
  const log = await git(['log', '--no-color', '--format=%h%x1f%H%x1f%P%x1f%s%x1f%an%x1f%cr%x1f%b%x1e', `${base}..${row.branch}`])
  const commits = log.stdout
    .split('\x1e')
    .map(entry => entry.replace(/^\n/, ''))
    .filter(Boolean)
    .map(entry => {
      const [sha, full, parents, subject, author, when, body = ''] = entry.split('\x1f')
      return { sha, full, parent: parents.split(' ')[0], subject, author, when, body: body.trim() }
    })
  const first = commits.at(-1)
  const draft = first?.subject.trim() ? { title: first.subject.trim(), body: first.body } : undefined
  const versions = row.uncommittedOnly || !row.parent ? [] : await versionsOf(row.branch, row.parent)
  return { branch: row.branch, parent, base, head, diff, versions, pending: mode === 'all' ? pending : '', commits, isCurrent, dirty, mode, includeWorktree, draft, uncommittedOnly: row.uncommittedOnly }
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

async function reflogOf(branch) {
  const log = await git(['log', '-g', '--format=%H%x1f%ct%x1f%gs', `refs/heads/${branch}`, '--'])
  return log.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, ct, subject = ''] = line.split('\x1f')
      return { sha, time: Number(ct), kind: subject.includes('(amend)') ? 'amend' : subject.split(/[:(]/)[0].trim() }
    })
    .reverse()
}

// shortcut: reads the last 60 reflog entries, each costs a merge-base; raise if longer histories matter
async function versionsOf(branch, parent) {
  const parentLog = await reflogOf(parent)
  const entries = (await reflogOf(branch)).slice(-60).filter((v, i, all) => all[i - 1]?.sha !== v.sha)
  const versions = await Promise.all(
    entries.map(async v => {
      const parentThen = parentLog.findLast(p => p.time <= v.time)?.sha ?? parent
      const base = (await git(['merge-base', parentThen, v.sha])).stdout.trim() || (await git(['merge-base', parent, v.sha])).stdout.trim()
      return { ...v, base }
    }),
  )
  return versions.filter(v => v.base && v.base !== v.sha).map((v, i) => ({ ...v, number: i + 1 }))
}

async function interdiffFor(query) {
  const [oldBase, old, newBase, next] = ['oldBase', 'old', 'newBase', 'new'].map(key => query.get(key) ?? '')
  if (![oldBase, old, newBase, next].every(sha => SHA.test(sha))) return { error: 'bad range' }
  const ws = query.get('ws') === '1' ? [] : ['-w']
  let from = old
  let conflict = false
  if (oldBase !== newBase) {
    const merged = await git(['merge-tree', '--write-tree', `--merge-base=${oldBase}`, newBase, old])
    const lines = merged.stdout.trim().split('\n')
    if (!merged.ok || !SHA.test(lines[0])) return { error: 'unavailable' }
    from = lines[0]
    conflict = lines.length > 1
  }
  const result = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, from, next])
  return result.ok ? { diff: result.stdout, conflict, rebased: oldBase !== newBase } : { error: 'unavailable' }
}

async function changesFor(query) {
  const from = query.get('from') ?? ''
  const to = query.get('to') ?? ''
  const path = query.get('path') ?? ''
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(from) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(to)) return { error: 'bad range' }
  if (path.startsWith('/') || path.split('/').includes('..')) return { error: 'bad path' }
  const ws = query.get('ws') === '1' ? [] : ['-w']
  const result = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...ws, from, to, ...(path ? ['--', path] : [])])
  return result.ok ? { diff: result.stdout } : { error: 'unavailable' }
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
  const ref = query.get('ref')
  if (ref && !/^([0-9a-f]{7,40}|HEAD)$/.test(ref)) return { error: 'unknown ref' }
  const shown = await git(['show', `${ref || row.branch}:${path}`])
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
      return send(res, 200, { version: state.version })
    }
    if (url.pathname === '/state') {
      const since = Number(url.searchParams.get('v') ?? -1)
      if (state.version === since || state.version === 0) await waitFor(stateWaiters, 25_000)
      return send(res, 200, state)
    }
    if (url.pathname === '/diff') return send(res, 200, await diffFor(url.searchParams))
    if (url.pathname === '/interdiff') return send(res, 200, await interdiffFor(url.searchParams))
    if (url.pathname === '/changes') return send(res, 200, await changesFor(url.searchParams))
    if (url.pathname === '/file') return send(res, 200, await fileFor(url.searchParams))
    if (url.pathname === '/action' && req.method === 'POST') {
      if (actions.length >= 20) return send(res, 429, { error: 'busy' })
      const id = nextActionId++
      actions.push({ ...(await readBody(req, 256 * 1024)), id })
      for (const wake of actionWaiters) wake()
      actionWaiters = []
      return send(res, 200, { ok: true, id })
    }
    if (url.pathname === '/action-cancel' && req.method === 'POST') {
      const id = Number((await readBody(req, 1024)).id)
      const before = actions.length
      actions = actions.filter(a => a.id !== id)
      return send(res, 200, { cancelled: actions.length < before, delivered: delivered.has(id) })
    }
    if (url.pathname === '/action') {
      const id = Number(url.searchParams.get('id'))
      return send(res, 200, { delivered: delivered.has(id), result: delivered.get(id), pending: actions.some(a => a.id === id) })
    }
    if (url.pathname === '/actions' && req.method === 'POST') {
      const { ids = [], results = {} } = await readBody(req, 1024 * 1024)
      for (const id of ids) delivered.set(id, results[id] ?? { ok: true })
      actions = actions.filter(a => !ids.includes(a.id))
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/actions') {
      if (!actions.length) await waitFor(actionWaiters, 10_000)
      return send(res, 200, actions)
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
