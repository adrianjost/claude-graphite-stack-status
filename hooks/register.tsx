import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { CiState, Issue, Lane, LinkTarget, PrInfo, ReviewReply, StackRow, StackSnapshot, UpdateInfo, WaitingPrompt } from '../types'

const POLL_MS = 60_000
const POLL_BUSY_MS = 30_000
const POLL_QUIET_MS = 5 * 60_000
const QUIET_AFTER_MS = 10 * 60_000
const MIN_GAP_MS = 15_000
const LOCAL_DELAY_MS = 1_500
const SHARED_CACHE_MS = 55_000
const GITHUB_COMMAND = /\b(git\s+push|gt\s+(submit|ss|sync|merge|get|land|repo\s+sync)|gh\s+pr)\b|\bgh\s+api\b[\s\S]*\b(un)?resolveReviewThread\b/
const EMPTY: StackSnapshot = { branch: '', rows: [], columns: 1, updatedAt: 0, isLoading: false }
const snapshot = atom({ plugin: 'graphite-stack', key: 'snapshot' } as const, EMPTY)
const isHidden = atom({ plugin: 'graphite-stack', key: 'isHidden' } as const, false)
const linkTarget = atom({ plugin: 'graphite-stack', key: 'linkTarget' } as const, 'github' as LinkTarget)
const working = atom({ plugin: 'graphite-stack', key: 'working' } as const, null as string | null)
const reviewUrl = atom({ plugin: 'graphite-stack', key: 'reviewUrl' } as const, null as string | null)
const waitingPrompts = atom({ plugin: 'graphite-stack', key: 'waitingPrompts' } as const, [] as WaitingPrompt[])
const reviewReplies = atom({ plugin: 'graphite-stack', key: 'reviewReplies' } as const, {} as Record<string, ReviewReply>)
const updateInfo = atom({ plugin: 'graphite-stack', key: 'updateInfo' } as const, null as UpdateInfo | null)
const REPLY_TOOL = 'mcp__graphite-stack__review_reply'
const REPLY_LINE = `When done, call ${REPLY_TOOL} once: refs you addressed in \`fixed\`; a one-sentence reply only for questions or anything you didn't do.`
const MAX_REPLIES = 200
const MAX_REFS = 400
const REVIEW_PORT_BASE = 47100
const REVIEW_PORTS = 1800
const STACK_ACTION_TIMEOUT_MS = 3 * 60_000

type MetaRow = { branch_name: string; parent_branch_name: string | null; children: string | null; validation_result: string | null }

type GhCheck = {
  __typename: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  workflowName?: string
  startedAt?: string
}

type GqlCheck = {
  __typename: string
  name?: string
  status?: string
  conclusion?: string
  detailsUrl?: string
  startedAt?: string
  checkSuite?: { workflowRun?: { workflow?: { name: string } } | null } | null
  context?: string
  state?: string
  targetUrl?: string
}

type GqlPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string | null
  bodyHTML: string
  labels: { nodes: { name: string; color: string; description: string | null }[] }
  reviewRequests: { totalCount: number; nodes: { requestedReviewer: { login?: string; name?: string } | null }[] }
  latestReviews: { totalCount: number; nodes: { state: string; author: { login: string } | null }[] }
  reviewThreads: { nodes: { id: string; isResolved: boolean; isOutdated: boolean; comments: { totalCount: number; nodes: { id: string; updatedAt: string }[] } }[] }
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: GqlCheck[] } } | null } }[] }
}

const PR_FIELDS =
  'number title url state isDraft reviewDecision bodyHTML labels(first:20){nodes{name color description}} ' +
  'reviewRequests(first:20){totalCount nodes{requestedReviewer{... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{name}}}} ' +
  'latestReviews(first:20){totalCount nodes{state author{login}}} reviewThreads(first:100){nodes{id isResolved isOutdated comments(last:1){totalCount nodes{id updatedAt}}}} ' +
  'commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ' +
  '... on CheckRun{name status conclusion detailsUrl startedAt checkSuite{workflowRun{workflow{name}}}} ' +
  '... on StatusContext{context state targetUrl}}}}}}}'

let isRefreshing = false
type Mode = 'local' | 'github' | 'force'
const RANK: Record<Mode, number> = { local: 0, github: 1, force: 2 }
const stronger = (a: Mode | undefined, b: Mode) => (a && RANK[a] >= RANK[b] ? a : b)
let lastGithubAt = 0
let lastChangeAt = Date.now()
let scheduled: Timer | undefined
let pendingMode: Mode | undefined
let queuedMode: Mode | undefined
let pollTimer: Timer | undefined
const attachedClients = new Set<string>()
let hasSeenAttach = false

class Problem extends Error {
  constructor(readonly issue: Issue) {
    super(issue.message)
  }
}

const TOOLS: Record<string, string> = {
  git: 'git',
  gh: 'The GitHub CLI (gh)',
  gt: 'The Graphite CLI (gt)',
  sqlite3: 'sqlite3',
}

async function exec($: Engine, cwd: string, argv: string[], timeoutMs = 30_000) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch (error) {
    const tool = argv[0] ?? ''
    throw new Problem({
      message: `${TOOLS[tool] ?? tool} isn't installed or not on Claude Code's PATH`,
      detail: String(error),
      fix: {
        label: 'Fix',
        prompt:
          `The graphite-stack plugin needs \`${tool}\`, but Claude Code can't start it. ` +
          'Check whether it is installed and on the PATH Claude Code uses, and help me install or fix it.',
      },
    })
  }
}

async function run($: Engine, cwd: string, argv: string[]) {
  const result = await exec($, cwd, argv)
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

async function gtVersion($: Engine, cwd: string) {
  try {
    return (await run($, cwd, ['gt', '--version'])) ?? 'unknown version'
  } catch {
    return 'not installed'
  }
}

function detachedIssue(branch: string, trunk: string): Issue {
  return {
    message: `Graphite has lost track of ${branch}'s parent, so it's shown on ${trunk}`,
    detail: 'Usually the parent branch was merged and deleted.',
    fix: {
      label: 'Track it',
      prompt:
        `Graphite has lost track of the parent of the branch \`${branch}\` (its metadata says BAD_PARENT_NAME, ` +
        'usually because the parent was merged and deleted). Find the right parent, most likely trunk or the branch its PR targets, ' +
        're-attach it with `gt track`, and restack if needed. Switch back to the branch I was on afterwards and don\'t push anything.',
    },
  }
}

function githubIssue(error: unknown, updatedAt: number): Issue {
  const text = error instanceof Error ? error.message : String(error)
  const since = updatedAt ? ` · showing data from ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
  if (error instanceof Problem) return error.issue
  if (/rate limit/i.test(text)) {
    return { message: `GitHub API rate limit reached${since}`, detail: 'It resets within the hour.', canFix: false }
  }
  if (/auth|log ?in|401|credentials|token/i.test(text)) {
    return {
      message: `gh isn't signed in to GitHub${since}`,
      detail: text,
      fix: {
        label: 'Sign in',
        prompt: 'The graphite-stack plugin can\'t load PR data because the GitHub CLI isn\'t signed in. Run `gh auth status` and help me sign in.',
      },
    }
  }
  if (/not a GitHub repository/.test(text)) {
    return { message: "This repository's origin isn't on GitHub, so there's no PR data", canFix: false }
  }
  return { message: `Couldn't load PR data from GitHub${since}`, detail: text }
}

function checkState(check: GhCheck): CiState {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'pass'
    if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending'
    return 'fail'
  }
  if (check.status !== 'COMPLETED') return 'pending'
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? '') ? 'pass' : 'fail'
}

function latestChecks(checks: GhCheck[]) {
  const latest = new Map<string, GhCheck>()
  for (const check of checks) {
    const key = `${check.workflowName ?? ''}/${check.name ?? check.context ?? ''}`
    const seen = latest.get(key)
    if (!seen || (check.startedAt ?? '') >= (seen.startedAt ?? '')) latest.set(key, check)
  }
  return [...latest.values()]
}

function sumStat(out: string, extra = 0) {
  let added = extra
  let removed = 0
  for (const line of out.split('\n')) {
    const [a, r] = line.split('\t')
    added += Number(a) || 0
    removed += Number(r) || 0
  }
  return added || removed ? { added, removed } : undefined
}

async function diffStat($: Engine, cwd: string, parent: string, branch: string) {
  const out = await run($, cwd, ['git', 'diff', '-w', '--numstat', `${parent}...${branch}`])
  return out === undefined ? undefined : sumStat(out)
}

async function worktreeStat($: Engine, cwd: string, base: string) {
  const [tracked, listed] = await Promise.all([
    run($, cwd, ['git', 'diff', '-w', '--numstat', base]),
    run($, cwd, ['git', 'ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const files = (listed ?? '').split('\0').filter(Boolean).slice(0, 200)
  const counted = files.length ? await exec($, cwd, ['git', 'grep', '--no-index', '-I', '-c', '-e', '', '--', ...files]) : undefined
  const lines = (counted?.stdout ?? '').split('\n').reduce((sum, line) => sum + (Number(line.slice(line.lastIndexOf(':') + 1)) || 0), 0)
  return sumStat(tracked ?? '', lines)
}

const trunks = new Map<string, string>()

async function detectTrunk($: Engine, cwd: string) {
  const known = trunks.get(cwd)
  if (known) return known
  const gitDir = await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir) return undefined
  let configured: string | undefined
  try {
    configured = (JSON.parse((await run($, cwd, ['cat', `${gitDir}/.graphite_repo_config`])) || '{}') as { trunk?: string }).trunk
  } catch {}
  const remote = (await run($, cwd, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '')
  for (const name of [configured, remote, 'main', 'master']) {
    if (name && (await run($, cwd, ['git', 'rev-parse', '--verify', '--quiet', `${name}^{commit}`]))) {
      trunks.set(cwd, name)
      return name
    }
  }
  return undefined
}

const noLane: Lane = { col: 0, up: false, down: false, pipes: [], corners: [] }

async function untrackedRows($: Engine, cwd: string, branch: string): Promise<Built | undefined> {
  const trunk = await detectTrunk($, cwd)
  if (!trunk) return undefined
  const row = { branch, parent: trunk, lane: noLane, isCurrent: true, isTrunk: false, needsRestack: false }
  if (branch === trunk) {
    if (!(await run($, cwd, ['git', 'status', '--porcelain']))) return undefined
    return { rows: [{ ...row, uncommittedOnly: true }], columns: 1, untracked: true }
  }
  return {
    rows: [
      { ...row, lane: { ...noLane, down: true } },
      { branch: trunk, lane: { ...noLane, up: true, upOwner: branch }, isCurrent: false, isTrunk: true, needsRestack: false },
    ],
    columns: 1,
    untracked: true,
  }
}

const trunkOf = (rows: StackRow[]) => (rows.find(row => row.isTrunk) ?? rows.find(row => row.uncommittedOnly))?.branch

class GitHubError extends Error {}

async function githubRepo($: Engine, cwd: string) {
  const url = (await run($, cwd, ['git', 'remote', 'get-url', 'origin'])) ?? ''
  const [, owner, name] = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/) ?? []
  return owner && name ? { owner, name } : undefined
}

const threadToken = (t: { id: string; resolved: boolean; outdated: boolean; key: string }) =>
  `${t.id}:${t.resolved ? 1 : 0}${t.outdated ? 1 : 0}:${t.key}`

const commentKey = (c: { totalCount: number; nodes: { id: string; updatedAt: string }[] }) => {
  const last = c.nodes.at(-1)
  return `${c.totalCount}:${last?.id ?? ''}:${last?.updatedAt ?? ''}`
}

function fingerprint(tokens: string[]) {
  if (!tokens.length) return ''
  let h = 5381
  for (const ch of tokens.join('|')) h = (Math.imul(h, 33) + ch.charCodeAt(0)) | 0
  return `${tokens.length}.${(h >>> 0).toString(36)}`
}

function toPrInfo(pr: GqlPr): PrInfo {
  const checks: GhCheck[] = (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(check => ({
    ...check,
    workflowName: check.checkSuite?.workflowRun?.workflow?.name,
  }))
  const ciCounts = { pass: 0, fail: 0, pending: 0 }
  const failing: PrInfo['failing'] = []
  for (const check of latestChecks(checks)) {
    const state = checkState(check)
    ciCounts[state === 'none' ? 'pass' : state]++
    if (state === 'fail') {
      failing.push({ name: check.name ?? check.context ?? '?', workflow: check.workflowName, url: check.detailsUrl ?? check.targetUrl })
    }
  }
  const ci: CiState =
    ciCounts.fail > 0 ? 'fail' : ciCounts.pending > 0 ? 'pending' : ciCounts.pass > 0 ? 'pass' : 'none'

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision ?? '',
    labels: pr.labels.nodes.map(l => ({ name: l.name, color: l.color, description: l.description ?? undefined })),
    ci,
    ciCounts,
    failing,
    openThreads: pr.reviewThreads.nodes.filter(t => !t.isResolved).length,
    threadFp: fingerprint(
      pr.reviewThreads.nodes.map(t => threadToken({ id: t.id, resolved: t.isResolved, outdated: t.isOutdated, key: commentKey(t.comments) })),
    ),
    hasReviewers: pr.reviewRequests.totalCount + pr.latestReviews.totalCount > 0,
    bodyHtml: pr.bodyHTML,
    reviewers: [
      ...pr.latestReviews.nodes.flatMap(r => (r.author ? [{ name: r.author.login, state: r.state }] : [])),
      ...pr.reviewRequests.nodes.flatMap(r => {
        const name = r.requestedReviewer?.login ?? r.requestedReviewer?.name
        return name ? [{ name, state: 'REQUESTED' }] : []
      }),
    ].filter((r, i, all) => all.findIndex(o => o.name === r.name) === i),
  }
}

type SharedCache = Record<string, { at: number; pr: PrInfo | null }>

async function loadPrs($: Engine, cwd: string, branches: string[], force: boolean) {
  const prs = new Map<string, PrInfo | undefined>()
  if (!branches.length) return prs
  const repo = await githubRepo($, cwd)
  if (!repo) throw new GitHubError('origin is not a GitHub repository')
  const cacheKey = `prs:${repo.owner}/${repo.name}`
  const cache = ((await $.store.get(cacheKey)) ?? {}) as SharedCache
  const now = Date.now()
  if (!force && branches.every(branch => now - (cache[branch]?.at ?? 0) < SHARED_CACHE_MS)) {
    for (const branch of branches) prs.set(branch, cache[branch]?.pr ?? undefined)
    return prs
  }
  const fields = branches.map(
    (branch, i) =>
      `b${i}:pullRequests(headRefName:${JSON.stringify(branch)},first:1,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_FIELDS}}}`,
  )
  const query = `query{repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}){${fields.join(' ')}}}`
  const result = await exec($, cwd, ['gh', 'api', 'graphql', '-f', `query=${query}`])
  if (result.exitCode !== 0) throw new GitHubError(result.stderr.trim())
  const data = JSON.parse(result.stdout) as { data?: { repository?: Record<string, { nodes: GqlPr[] } | null> } }
  const found = data.data?.repository
  if (!found) throw new GitHubError('unexpected GitHub response')
  const fresh: SharedCache = {}
  for (const [branch, entry] of Object.entries(cache)) if (now - entry.at < 60 * 60_000) fresh[branch] = entry
  branches.forEach((branch, i) => {
    const node = found[`b${i}`]?.nodes[0]
    const pr = node ? toPrInfo(node) : undefined
    prs.set(branch, pr)
    fresh[branch] = { at: now, pr: pr ?? null }
  })
  await $.store.set(cacheKey, fresh)
  return prs
}

type ThreadComment = { author: string; avatar: string; body: string; bodyHtml: string; createdAt: string; url: string }
type ReviewThread = {
  id: string
  resolved: boolean
  outdated: boolean
  canToggle: boolean
  path: string
  line?: number
  start?: number
  originalLine?: number
  file: boolean
  side: 'old' | 'new'
  key: string
  comments: ThreadComment[]
}
type ThreadCache = Record<string, { at: number; fp: string; threads: ReviewThread[] }>
type GqlThread = {
  id: string
  isResolved: boolean
  isOutdated: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  path: string
  line: number | null
  startLine: number | null
  originalLine: number | null
  subjectType: string
  diffSide: string
  comments: {
    totalCount: number
    nodes: { id: string; updatedAt: string; createdAt: string; url: string; body: string; bodyHTML: string; author: { login: string; avatarUrl: string } | null }[]
  }
}

const THREAD_FIELDS =
  'reviewThreads(first:100){nodes{id isResolved isOutdated viewerCanResolve viewerCanUnresolve path line startLine originalLine subjectType diffSide ' +
  'comments(last:50){totalCount nodes{id updatedAt createdAt url body bodyHTML author{login avatarUrl(size:40)}}}}}'
const THREAD_CACHE_MS = 7 * 24 * 60 * 60_000
let threadCache: { key: string; cache: ThreadCache } | undefined
let syncingThreads = false
let resyncThreads = false

async function threadStore($: Engine) {
  if (threadCache) return threadCache
  const repo = await githubRepo($, await $.session.cwd())
  if (!repo) return undefined
  const key = `threads:${repo.owner}/${repo.name}`
  threadCache = { key, cache: ((await $.store.get(key)) ?? {}) as ThreadCache }
  return threadCache
}

const saveThreads = ($: Engine, store: { key: string; cache: ThreadCache }) => {
  const now = Date.now()
  for (const [number, entry] of Object.entries(store.cache)) if (now - entry.at > THREAD_CACHE_MS) delete store.cache[number]
  return $.store.set(store.key, store.cache)
}

const threadsFp = (threads: ReviewThread[]) => fingerprint(threads.map(threadToken))

function toThread(t: GqlThread): ReviewThread {
  return {
    id: t.id,
    resolved: t.isResolved,
    outdated: t.isOutdated,
    canToggle: t.isResolved ? t.viewerCanUnresolve : t.viewerCanResolve,
    path: t.path,
    line: t.line ?? undefined,
    start: t.startLine && t.line && t.startLine !== t.line ? t.startLine : undefined,
    originalLine: t.originalLine ?? undefined,
    file: t.subjectType === 'FILE',
    side: t.diffSide === 'LEFT' ? 'old' : 'new',
    key: commentKey(t.comments),
    comments: t.comments.nodes.map(c => ({
      author: c.author?.login ?? 'ghost',
      avatar: c.author?.avatarUrl ?? '',
      body: c.body,
      bodyHtml: c.bodyHTML,
      createdAt: c.createdAt,
      url: c.url,
    })),
  }
}

async function fetchThreads($: Engine) {
  const cwd = await $.session.cwd()
  const repo = await githubRepo($, cwd)
  const store = await threadStore($)
  if (!repo || !store) return
  const prs = (await read($, snapshot)).rows.flatMap(row => (row.pr?.state === 'OPEN' && row.pr.threadFp !== undefined ? [row.pr] : []))
  const now = Date.now()
  const changed = prs.filter(pr => (store.cache[pr.number]?.fp ?? '') !== pr.threadFp)
  if (!changed.length) return
  for (const pr of changed.filter(pr => !pr.threadFp)) store.cache[pr.number] = { at: now, fp: '', threads: [] }
  const stale = changed.filter(pr => pr.threadFp)
  if (stale.length) {
    const fields = stale.map(pr => `p${pr.number}:pullRequest(number:${pr.number}){${THREAD_FIELDS}}`)
    const query = `query{repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}){${fields.join(' ')}}}`
    const result = await exec($, cwd, ['gh', 'api', 'graphql', '-f', `query=${query}`])
    if (result.exitCode !== 0) throw new GitHubError(result.stderr.trim())
    const found = (JSON.parse(result.stdout) as { data?: { repository?: Record<string, { reviewThreads: { nodes: GqlThread[] } } | null> } }).data?.repository
    if (!found) throw new GitHubError('unexpected GitHub response')
    for (const pr of stale) {
      const nodes = found[`p${pr.number}`]?.reviewThreads.nodes
      if (nodes) store.cache[pr.number] = { at: now, fp: pr.threadFp ?? '', threads: nodes.map(toThread) }
    }
  }
  await saveThreads($, store)
  schedulePushReview($)
}

async function syncThreads($: Engine) {
  if (!review) return
  if (syncingThreads) {
    resyncThreads = true
    return
  }
  syncingThreads = true
  try {
    do {
      resyncThreads = false
      await fetchThreads($)
    } while (resyncThreads)
  } catch (error) {
    $.ui.log(`review threads failed: ${String(error)}`, { to: 'debug' })
  } finally {
    syncingThreads = false
  }
}

const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.gen(\.[^/]*)?$|\.min\.(js|css)$|\.snap$|(^|\/)(generated|__generated__|insurance-tables)\//

function stackOrder(rows: StackRow[]) {
  return [...rows].reverse().filter(row => !row.isTrunk && row.parent)
}

async function readMetadata($: Engine, cwd: string, gitDir: string) {
  const db = `${gitDir}/.graphite_metadata.db`
  if ((await run($, cwd, ['test', '-e', db])) === undefined) {
    const legacy = await run($, cwd, ['git', 'for-each-ref', 'refs/branch-metadata', '--count=1', '--format=%(refname)'])
    if (!legacy) return undefined
    throw new Problem({
      message: 'This repo\'s stack data is in an older Graphite format. Update gt to read it',
      detail: `gt ${await gtVersion($, cwd)}`,
      fix: {
        label: 'Update gt',
        prompt:
          'The graphite-stack plugin can\'t read this repo\'s Graphite stack: the stack metadata is stored in git refs ' +
          '(refs/branch-metadata), the format of older gt versions, instead of .git/.graphite_metadata.db. ' +
          'Check which gt version I have and how it was installed, then help me update the Graphite CLI and migrate the repo.',
      },
    })
  }
  const result = await exec($, cwd, ['sqlite3', '-json', db, 'select branch_name, parent_branch_name, children, validation_result from branch_metadata'])
  if (result.exitCode !== 0) {
    const version = await gtVersion($, cwd)
    const isSchema = /no such (table|column)/i.test(result.stderr)
    throw new Problem({
      message: isSchema
        ? `Graphite changed its stack data format (gt ${version}). The plugin may need an update`
        : "Couldn't read Graphite's stack data",
      detail: result.stderr.trim(),
    })
  }
  return JSON.parse(result.stdout.trim() || '[]') as MetaRow[]
}

type Built = { rows: StackRow[]; columns: number; detached?: string; untracked?: boolean }

async function buildRows($: Engine, cwd: string, branch: string): Promise<Built | string> {
  const gitDir = await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir) return 'Not a git repository.'
  const metadata = await readMetadata($, cwd, gitDir)
  if (!metadata) return 'No Graphite metadata in this repository.'
  const meta = new Map<string, MetaRow>()
  for (const row of metadata) meta.set(row.branch_name, row)

  const trunk = metadata.find(row => row.validation_result === 'TRUNK')?.branch_name ?? 'main'
  const current = meta.get(branch)
  if (!current || branch === trunk) return `${branch} is not part of a Graphite stack.`

  const parentOf = (name: string) => {
    const parent = meta.get(name)?.parent_branch_name
    return parent && meta.has(parent) ? parent : undefined
  }
  let root = branch
  const seen = new Set([root])
  for (let parent = parentOf(root); parent && parent !== trunk && !seen.has(parent); parent = parentOf(parent)) {
    seen.add(parent)
    root = parent
  }
  const detached = parentOf(root) ? undefined : root

  const childrenOf = (name: string) =>
    (JSON.parse(meta.get(name)?.children ?? '[]') as string[]).filter(child => meta.has(child))
  const rows: StackRow[] = []
  let columns = 1
  const layout = (name: string, col: number, open: number[], openOwners: string[], parent?: string) => {
    const children = childrenOf(name)
    children.forEach((child, i) => {
      layout(
        child,
        col + i,
        [...open, ...children.slice(0, i).map((_, k) => col + k)],
        [...openOwners, ...children.slice(0, i)],
        name,
      )
    })
    const corners = children.slice(1).map((_, i) => col + i + 1)
    columns = Math.max(columns, col + 1, ...corners.map(c => c + 1))
    rows.push({
      branch: name,
      parent,
      lane: {
        col,
        up: children.length > 0,
        down: true,
        pipes: open,
        corners,
        pipeOwners: openOwners,
        cornerOwners: children.slice(1),
        upOwner: children[0],
      },
      isCurrent: name === branch,
      isTrunk: false,
      needsRestack: false,
    })
  }
  layout(root, 0, [], [], trunk)
  rows.push({
    branch: trunk,
    lane: { col: 0, up: true, down: false, pipes: [], corners: [], upOwner: root },
    isCurrent: trunk === branch,
    isTrunk: true,
    needsRestack: false,
  })

  return { rows, columns, detached }
}

function requestRefresh($: Engine, mode: Mode) {
  pendingMode = stronger(pendingMode, mode)
  if (scheduled) return
  const wait = pendingMode === 'local' ? LOCAL_DELAY_MS : Math.max(0, lastGithubAt + MIN_GAP_MS - Date.now())
  scheduled = $.clock.after(Math.max(1, wait), () => {
    scheduled = undefined
    const run = pendingMode ?? 'local'
    pendingMode = undefined
    void refresh($, run)
  })
}

const isPaused = () => hasSeenAttach && attachedClients.size === 0

async function pollDelay($: Engine) {
  const rows = (await read($, snapshot)).rows
  if (rows.some(row => row.pr?.state === 'OPEN' && row.pr.ciCounts.pending > 0)) return POLL_BUSY_MS
  return Date.now() - lastChangeAt > QUIET_AFTER_MS ? POLL_QUIET_MS : POLL_MS
}

async function schedulePoll($: Engine) {
  pollTimer?.cancel()
  pollTimer = $.clock.after(await pollDelay($), () => {
    void (async () => {
      if (!isPaused() && !(await read($, isHidden))) requestRefresh($, 'github')
      await schedulePoll($)
    })()
  })
}

async function stackAction($: Engine, branch?: string) {
  if (await read($, working)) return
  const label = branch ? `Restacking ${branch}…` : 'Syncing with main…'
  await update($, working, () => label)
  const handOff = (reason: string) =>
    void $.prompt.submit({
      text:
        `${reason} Bring my Graphite stack up to date with origin/main: run \`gt sync\` (accept updating trunk and ` +
        'deleting merged branches), then `gt restack`, resolving any conflicts (`gt continue` after each). ' +
        "Switch back to the branch I was on afterwards, don't push anything, and tell me what changed.",
      asUser: true,
    })
  try {
    const cwd = await $.session.cwd()
    const original = await run($, cwd, ['git', 'branch', '--show-current'])
    const dirty = await run($, cwd, ['git', 'status', '--porcelain', '--untracked-files=no'])
    if (dirty) return handOff('The working tree has uncommitted changes, so the graphite-stack plugin did not sync on its own.')

    const steps = [
      ['gt', 'sync', '--force', '--no-interactive'],
      ['gt', 'restack', '--no-interactive', ...(branch ? ['--branch', branch] : [])],
    ]
    for (const argv of steps) {
      const result = await exec($, cwd, argv, STACK_ACTION_TIMEOUT_MS)
      if (result.exitCode === 0) continue
      const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-15).join('\n')
      const rebasing = (await run($, cwd, ['git', 'status']))?.includes('rebase in progress') ||
        /conflict/i.test(output)
      return void $.prompt.submit({
        text:
          `\`${argv.join(' ')}\` ${rebasing ? 'stopped on a conflict' : 'failed'}:\n\n\`\`\`\n${output}\n\`\`\`\n\n` +
          (rebasing
            ? 'Resolve the conflicts and run `gt continue` until the restack finishes. '
            : 'Find out what went wrong and finish syncing and restacking my Graphite stack. ') +
          `Switch back to ${original ? `\`${original}\`` : 'the branch I was on'} afterwards and don't push anything.`,
        asUser: true,
      })
    }
    if (original && (await run($, cwd, ['git', 'branch', '--show-current'])) !== original) {
      await run($, cwd, ['git', 'checkout', original])
    }
    $.ui.toast(branch ? `Restacked ${branch}` : 'Stack synced with main')
  } catch (error) {
    if (error instanceof Problem) await update($, snapshot, s => ({ ...s, issue: error.issue }))
    else handOff(`The graphite-stack plugin failed to sync (${String(error)}).`)
  } finally {
    await update($, working, () => null)
    void refresh($, 'local')
  }
}


let review: { port: number; token: string } | undefined
let reviewStarting: Promise<void> | undefined
let reviewPushTimer: Timer | undefined

function portFor(id: string) {
  let h = 0
  for (const ch of id) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0
  return REVIEW_PORT_BASE + (Math.abs(h) % REVIEW_PORTS)
}

async function storedReviewToken($: Engine) {
  const stored = await $.store.get('reviewToken')
  return typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored) ? stored : ''
}

function startReview($: Engine) {
  if (review) return Promise.resolve()
  reviewStarting ??= (async () => {
    const [cwd, id, stored] = await Promise.all([$.session.cwd(), $.session.id(), storedReviewToken($)])
    let port = 0
    let token = stored
    let failure: string | undefined
    const ended = (async () => {
      try {
        const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/review/server.mjs`, cwd, stored, String(portFor(id))] })
        for await (const { stream, text } of child) {
          if (stream === 'stderr') {
            failure = text.trim()
            continue
          }
          const issued = /TOKEN ([0-9a-f]{64})/.exec(text)?.[1]
          if (issued) token = issued
          const found = /PORT (\d+)/.exec(text)
          if (found) port = Number(found[1])
        }
      } catch (error) {
        failure = String(error)
      }
    })()
    void ended.then(async () => {
      if (review?.port !== port) return
      review = undefined
      await update($, reviewUrl, () => null)
      $.clock.after(500, () => void startReview($))
    })
    for (let i = 0; i < 50 && !port && !failure; i++) await $.clock.sleep(100)
    if (!port) {
      $.ui.log(`review page didn't start: ${failure ?? 'no answer from node'}`, { to: 'debug' })
      return
    }
    if (token !== stored) await $.store.set('reviewToken', token)
    review = { port, token }
    await update($, reviewUrl, () => `http://127.0.0.1:${port}/?t=${token}`)
    await pushReview($)
    void syncThreads($)
    void pollReviewActions($, port)
  })().finally(() => {
    reviewStarting = undefined
  })
  return reviewStarting
}

function schedulePushReview($: Engine) {
  if (!review) return
  reviewPushTimer?.cancel()
  reviewPushTimer = $.clock.after(300, () => void pushReview($))
}

async function pushReview($: Engine) {
  const server = review
  if (!server) return
  const s = await read($, snapshot)
  const cwd = await $.session.cwd()
  const behind = new Set(s.rows.filter(row => row.needsRestack).map(row => row.branch))
  const threads = await threadStore($)
  const payload = {
    repo: cwd.split('/').pop(),
    trunk: trunkOf(s.rows),
    untracked: s.untracked,
    current: s.branch,
    generated: GENERATED.source,
    rows: s.rows.map(row => ({
      branch: row.branch,
      parent: row.parent,
      isTrunk: row.isTrunk,
      uncommittedOnly: row.uncommittedOnly,
      isCurrent: row.isCurrent,
      needsRestack: row.needsRestack,
      diff: row.diff,
      lane: laneSvg(row.lane, s.columns, row.branch, row.pr ? prDot(row.pr) : undefined, owner => behind.has(owner), row.isCurrent).source,
      pr: row.pr && {
        number: row.pr.number,
        title: row.pr.title,
        url: row.pr.url,
        graphiteUrl: graphiteUrl(row.pr),
        state: row.pr.state,
        isDraft: row.pr.isDraft,
        reviewDecision: row.pr.reviewDecision,
        labels: row.pr.labels,
        reviewers: row.pr.reviewers ?? [],
        bodyHtml: row.pr.bodyHtml ?? '',
        threads: threads?.cache[row.pr.number]?.threads ?? [],
      },
    })),
    replies: await read($, reviewReplies),
  }
  try {
    await $.http.fetch(`http://127.0.0.1:${server.port}/state?t=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    $.ui.log(`review page update failed: ${String(error)}`, { to: 'debug' })
  }
}

type ReviewComment = {
  kind?: 'description' | 'thread' | 'file'
  file?: boolean
  thread?: { id: string; url: string }
  note?: string
  quote?: string
  id?: string | number
  branch?: string
  base?: string
  path: string
  start?: number
  line?: number
  side?: 'old' | 'new'
  text: string
  code?: string
  replyTo?: string | number
  parentRef?: string
  context?: string
}
type PrReadyAction = { type: 'pr-ready'; number: number; ready: boolean }
type ReviewersLoadAction = { type: 'reviewers-load'; number: number; query?: string }
type ReviewersSetAction = { type: 'reviewers-set'; number: number; add: string[]; remove: string[] }
type SubmitBranchAction = { type: 'submit-branch'; branch: string }
type ThreadResolveAction = { type: 'thread-resolve'; threadId: string; resolve: boolean; branch?: string }
type PageAction = ReviewAction | PrReadyAction | ReviewersLoadAction | ReviewersSetAction | SubmitBranchAction | ThreadResolveAction
type ActionResult = { ok: boolean; message?: string; data?: unknown }

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

type Person = { login: string; name: string | null; avatarUrl: string }

async function loadReviewers($: Engine, number: number, query = ''): Promise<ActionResult> {
  const cwd = await $.session.cwd()
  const repo = await githubRepo($, cwd)
  if (!repo) return { ok: false, message: 'Not a GitHub repository' }
  const result = await exec($, cwd, [
    'gh', 'api', 'graphql',
    '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${number}`, '-f', `search=${query.slice(0, 100)}`,
    '-f',
    'query=query($owner:String!,$name:String!,$number:Int!,$search:String){repository(owner:$owner,name:$name){' +
      'pullRequest(number:$number){author{login} suggestedReviewers{isAuthor reviewer{login name avatarUrl(size:40)}} ' +
      'reviewRequests(first:50){nodes{requestedReviewer{... on User{login name avatarUrl(size:40)}}}} ' +
      'latestReviews(first:50){nodes{state author{login ... on User{name avatarUrl(size:40)}}}}} ' +
      'assignableUsers(first:100,query:$search){nodes{login name avatarUrl(size:40)}}}}',
  ])
  if (result.exitCode !== 0) return { ok: false, message: (result.stderr || result.stdout).trim().split('\n')[0] }
  const repository = JSON.parse(result.stdout).data.repository
  const pr = repository.pullRequest
  const author: string | undefined = pr.author?.login
  const strip = (people: (Person | null | undefined)[]) =>
    people.filter((p): p is Person => !!p?.login && p.login !== author)
  return {
    ok: true,
    data: {
      author,
      suggestions: strip(pr.suggestedReviewers.filter((s: { isAuthor: boolean }) => !s.isAuthor).map((s: { reviewer: Person }) => s.reviewer)),
      requested: strip(pr.reviewRequests.nodes.map((n: { requestedReviewer: Person | null }) => n.requestedReviewer)),
      reviewed: pr.latestReviews.nodes
        .filter((n: { author: Person | null }) => n.author)
        .map((n: { state: string; author: Person }) => ({ ...n.author, state: n.state })),
      users: strip(repository.assignableUsers.nodes),
    },
  }
}

async function setReviewers($: Engine, action: ReviewersSetAction): Promise<ActionResult> {
  const add = (action.add ?? []).filter(login => LOGIN.test(login)).slice(0, 15)
  const remove = (action.remove ?? []).filter(login => LOGIN.test(login))
  if (!add.length && !remove.length) return { ok: true }
  const cwd = await $.session.cwd()
  const result = await exec($, cwd, [
    'gh', 'pr', 'edit', String(action.number),
    ...(add.length ? ['--add-reviewer', add.join(',')] : []),
    ...(remove.length ? ['--remove-reviewer', remove.join(',')] : []),
  ])
  requestRefresh($, 'force')
  return result.exitCode === 0 ? { ok: true } : { ok: false, message: (result.stderr || result.stdout).trim().split('\n')[0] }
}
async function setThreadResolved($: Engine, action: ThreadResolveAction): Promise<ActionResult> {
  const store = await threadStore($)
  const entry = Object.entries(store?.cache ?? {}).find(([, e]) => e.threads.some(t => t.id === action.threadId))
  const thread = entry?.[1].threads.find(t => t.id === action.threadId)
  if (!store || !entry || !thread) return { ok: false, message: 'Unknown review thread. Wait for the page to refresh.' }
  const mutation = action.resolve ? 'resolveReviewThread' : 'unresolveReviewThread'
  const cwd = await $.session.cwd()
  const result = await exec($, cwd, [
    'gh', 'api', 'graphql', '-f', `query=mutation{${mutation}(input:{threadId:${JSON.stringify(thread.id)}}){thread{isResolved}}}`,
  ])
  if (result.exitCode !== 0) return { ok: false, message: (result.stderr || result.stdout).trim().split('\n')[0] }
  thread.resolved = action.resolve
  entry[1].fp = threadsFp(entry[1].threads)
  entry[1].at = Date.now()
  const number = Number(entry[0])
  const openThreads = entry[1].threads.filter(t => !t.resolved).length
  const patch = <T extends PrInfo | null | undefined>(pr: T): T => (pr?.number === number ? { ...pr, openThreads, threadFp: entry[1].fp } : pr)
  await update($, snapshot, s => ({ ...s, rows: s.rows.map(row => (row.pr ? { ...row, pr: patch(row.pr) } : row)) }))
  const repo = await githubRepo($, cwd)
  const shared = repo ? ((await $.store.get(`prs:${repo.owner}/${repo.name}`)) as SharedCache | undefined) : undefined
  if (repo && shared) {
    for (const cached of Object.values(shared)) cached.pr = patch(cached.pr)
    await $.store.set(`prs:${repo.owner}/${repo.name}`, shared)
  }
  await saveThreads($, store)
  schedulePushReview($)
  return { ok: true }
}

type ReviewAction = {
  type: 'review'
  branch: string
  compareTo?: string
  includesUncommitted?: boolean
  summary?: string
  comments: ReviewComment[]
}

function layerLabel(rows: StackRow[], branch: string) {
  const layers = stackOrder(rows)
  const at = layers.findIndex(row => row.branch === branch)
  const pr = layers[at]?.pr
  const subject = pr ? `PR #${pr.number}` : `\`${branch}\``
  return at >= 0 && layers.length > 1 ? `${subject} (stack layer ${at + 1}/${layers.length})` : subject
}

function quoteLines(code?: string) {
  const lines = (code ?? '').replace(/\s+$/, '').split('\n')
  if (!lines.join('').trim()) return ''
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^\s*/)![0].length))
  const shown = lines.map(line => line.slice(indent)).slice(0, 3)
  if (lines.length > 3) shown.push('…')
  return `\n${shown.map(line => `   > ${line}`).join('\n')}`
}

const RESOLVE_THREAD = `gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<thread id>"}){thread{isResolved}}}'`
const THREAD_TAIL = `fix it on that branch, then resolve the thread with \`${RESOLVE_THREAD}\`. Reply on the thread instead only if you chose not to change any code.`

function indent(text: string) {
  return text.split('\n').map(line => `   ${line}`).join('\n').trim()
}

let refSeq = 0
const refTargets = new Map<string, { branch: string; id: string }>()

function newRef(branch: string, comment: ReviewComment) {
  const ref = `c${++refSeq}`
  if (comment.id !== undefined) refTargets.set(ref, { branch, id: String(comment.id) })
  if (refTargets.size > MAX_REFS) refTargets.delete(refTargets.keys().next().value!)
  return ref
}

function reviewPrompt(action: ReviewAction, rows: StackRow[]) {
  const where = (c: ReviewComment) =>
    c.kind === 'file' || c.file
      ? `\`${c.path}\` (file)`
      : `\`${c.path}:${c.start && c.start !== c.line ? `${c.start}-${c.line}` : c.line}\`` + (c.side === 'old' ? ` (removed line${c.start && c.start !== c.line ? 's' : ''})` : '')
  const followUp = (c: ReviewComment) => {
    if (!c.replyTo) return undefined
    if (c.parentRef && refTargets.get(c.parentRef)?.id === String(c.replyTo)) return { target: `re ${c.parentRef}`, tail: '' }
    const context = (c.context ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
    return { target: where(c), tail: context ? `\n   (follow-up to: "${context}")` : '' }
  }
  const mine = action.comments.filter(c => (c.branch ?? action.branch) === action.branch)
  const comments = mine.filter(c => c.kind !== 'description')
  const notes = mine.filter(c => c.kind === 'description')
  const pr = stackOrder(rows).find(row => row.branch === action.branch)?.pr
  const subject = layerLabel(rows, action.branch)
  const single = mine.length === 1 && !action.summary ? mine[0] : undefined
  const refs: string[] = []
  const withRefs = mine.some(c => !c.thread)
  const mark = (c: ReviewComment, i: number) => {
    if (!withRefs) return `${i + 1}. `
    refs.push(newRef(action.branch, c))
    return `[${refs.at(-1)}] `
  }
  if (single?.thread) {
    const { id, url } = single.thread
    return { refs, text: `GitHub review thread on ${subject}, ${where(single)} (${url}, thread id \`${id}\`):\n\n${single.text}${single.note ? `\nGuidance: ${single.note}` : ''}${quoteLines(single.code)}\n\nPlease ${THREAD_TAIL.replace('<thread id>', id)}` }
  }
  if (single) {
    const follow = followUp(single)
    const target = follow ? follow.target : single.kind === 'description' ? (pr ? 'the PR description' : 'the commit message') : where(single)
    const apply =
      single.kind === 'description'
        ? pr
          ? ' Apply it by editing the PR description on GitHub.'
          : " Apply it to the branch's commit message."
        : ''
    return { refs, text: `Review comment on ${subject}, ${mark(single, 0)}${target}: ${single.text}${follow ? follow.tail : quoteLines(single.kind === 'description' ? single.quote : single.code)}${apply ? `\n\n${apply.trim()}` : ''}` }
  }
  const base = action.compareTo ?? comments.find(c => c.base)?.base
  const text = [
    `Review feedback on ${subject}` +
      (base ? ` vs \`${base}\`` : '') +
      (action.includesUncommitted ? ' including uncommitted changes' : '') +
      ':',
    action.summary ? `\n${action.summary}` : '',
    notes.length
      ? `\nOn the ${pr ? 'PR description' : 'commit message (the future PR description)'}:\n${notes.map((c, i) => `${mark(c, i)}${c.text}${quoteLines(c.quote)}`).join('\n')}`
      : '',
    comments.length
      ? `\n${notes.length ? 'On the code:\n' : ''}${comments
          .map((c, i) =>
            c.thread
              ? `${mark(c, i)}${where(c)}: GitHub review thread ${c.thread.url} (thread id \`${c.thread.id}\`)\n   ${indent(c.text)}${c.note ? `\n   Guidance: ${indent(c.note)}` : ''}${quoteLines(c.code)}`
              : (follow => `${mark(c, i)}${follow ? follow.target : where(c)}: ${c.text}${follow ? follow.tail : quoteLines(c.code)}`)(followUp(c)),
          )
          .join('\n')}`
      : '',
    comments.some(c => c.thread) ? `\nFor each GitHub review thread, ${THREAD_TAIL}` : '',
    notes.length && pr ? '\nApply the description points by editing the PR description on GitHub, changing only what they ask for.' : '',
    notes.length && !pr ? "\nApply the description points to the branch's commit message, which becomes the PR title and description." : '',
  ]
    .filter(Boolean)
    .join('\n')
  return { refs, text }
}

type Tracked = { from: Record<string, string>; refs: string[] }
let tracked: Tracked | undefined

async function snap($: Engine, branch: string) {
  try {
    const cwd = await $.session.cwd()
    const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })
    const head = await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`)
    const sha = head.exitCode === 0 ? head.stdout.trim() : ''
    if (!sha) return undefined
    if ((await git('symbolic-ref', '--short', '-q', 'HEAD')).stdout.trim() !== branch) return sha
    const index = (await git('rev-parse', '--path-format=absolute', '--git-path', 'graphite-review-index')).stdout.trim()
    if (!index) return sha
    const step = (...args: string[]) => $.process.run(['git', ...args], { cwd, env: { GIT_INDEX_FILE: index }, timeoutMs: 20_000 })
    if ((await step('read-tree', sha)).exitCode !== 0 || (await step('add', '-A')).exitCode !== 0) return sha
    return (await step('write-tree')).stdout.trim() || sha
  } catch {
    return undefined
  }
}

async function sameTree($: Engine, a: string, b: string) {
  try {
    const cwd = await $.session.cwd()
    const [x, y] = await Promise.all([a, b].map(sha => $.process.run(['git', 'rev-parse', `${sha}^{tree}`], { cwd, timeoutMs: 10_000 })))
    return x!.exitCode === 0 && y!.exitCode === 0 && x!.stdout.trim() === y!.stdout.trim()
  } catch {
    return false
  }
}

async function beginTrack($: Engine, refs: string[]) {
  const from = tracked?.from ?? {}
  for (const branch of new Set(refs.flatMap(ref => refTargets.get(ref)?.branch ?? []))) {
    if (from[branch]) continue
    const sha = await snap($, branch)
    if (sha) from[branch] = sha
  }
  tracked = { from, refs: [...(tracked?.refs ?? []), ...refs] }
}

async function endTrack($: Engine) {
  const done = tracked
  tracked = undefined
  if (!done) return
  const changes: Record<string, { from: string; to: string }> = {}
  for (const [branch, from] of Object.entries(done.from)) {
    const to = await snap($, branch)
    if (to && to !== from && !(await sameTree($, from, to))) changes[branch] = { from, to }
  }
  const touched = done.refs.flatMap(ref => {
    const target = refTargets.get(ref)
    const change = target && changes[target.branch]
    return target && change ? [[target.id, change] as const] : []
  })
  if (!touched.length) return
  await update($, reviewReplies, map => trimReplies({ ...map, ...Object.fromEntries(touched.map(([id, change]) => [id, { ...map[id], ...change }])) }))
  schedulePushReview($)
}

async function storeRefs($: Engine, refs: string[]) {
  const entries = refs.flatMap(ref => {
    const target = refTargets.get(ref)
    return target ? [[target.id, ref] as const] : []
  })
  if (!entries.length) return
  await update($, reviewReplies, map => trimReplies({ ...map, ...Object.fromEntries(entries.map(([id, ref]) => [id, { ...map[id], ref }])) }))
  schedulePushReview($)
}

function trimReplies(map: Record<string, ReviewReply>) {
  const keys = Object.keys(map)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REPLIES))) delete map[key]
  return map
}

async function answerReview($: Engine, input: { fixed?: unknown; replies?: unknown }) {
  const entries: [string, ReviewReply][] = []
  for (const ref of Array.isArray(input.fixed) ? input.fixed : []) {
    const target = typeof ref === 'string' ? refTargets.get(ref) : undefined
    if (target) entries.push([target.id, { status: 'fixed', text: undefined, ref }])
  }
  for (const item of Array.isArray(input.replies) ? input.replies : []) {
    const { ref, text } = (item ?? {}) as { ref?: unknown; text?: unknown }
    const target = typeof ref === 'string' ? refTargets.get(ref) : undefined
    if (target && typeof text === 'string' && text.trim()) entries.push([target.id, { status: 'replied', text: text.trim().slice(0, 1000), ref: ref as string }])
  }
  if (!entries.length) return { deny: 'No matching refs: use the refs from the review message, like c1.' }
  await update($, reviewReplies, map => {
    const next = { ...map }
    for (const [id, entry] of entries) next[id] = { ...next[id], ...entry }
    return trimReplies(next)
  })
  schedulePushReview($)
  return { result: 'ok' }
}

let actionLoop = 0
let turnRunning = false
async function submitPrompt($: Engine, text: string, parts: { refs?: string[] }[] = []) {
  const refs = parts.flatMap(part => part.refs ?? [])
  if (refs.length) {
    text += `\n\n${REPLY_LINE}`
    await beginTrack($, refs)
  }
  void $.prompt
    .submit({ text, asUser: true })
    .catch(error => $.ui.toast(`Couldn't hand this to Claude: ${String(error)}`, { timeoutMs: 10_000 }))
}

async function queuePrompt($: Engine, text: string, branch?: string, refs?: string[]) {
  if (turnRunning) await update($, waitingPrompts, list => [...list, { text, branch, refs }])
  else await submitPrompt($, text, [{ refs }])
}

async function flushPrompts($: Engine) {
  const batch = (await read($, waitingPrompts)).map(entry => (typeof entry === 'string' ? { text: entry } : entry))
  if (!batch.length) return
  await update($, waitingPrompts, () => [])
  const branches = new Set(batch.flatMap(entry => (entry.branch ? [entry.branch] : [])))
  await submitPrompt(
    $,
    batch.length === 1
      ? batch[0]!.text
      : `${batch.length} requests from the review page came in while you were busy. Handle them in order${branches.size > 1 ? ', addressing each review point on its branch' : ''}:\n\n` +
          batch.map((entry, i) => `## ${i + 1}.\n\n${entry.text}`).join('\n\n'),
    batch,
  )
}

async function pollReviewActions($: Engine, port: number) {
  const handled = new Set<number>()
  const loop = ++actionLoop
  while (review?.port === port && loop === actionLoop) {
    const base = `http://127.0.0.1:${port}`
    const token = review.token
    let actions: (PageAction & { id: number })[] = []
    try {
      const response = await $.http.fetch(`${base}/actions?t=${token}`)
      actions = response.ok ? JSON.parse(response.text) : []
    } catch (error) {
      $.ui.log(`review actions poll failed: ${String(error)}`, { to: 'debug' })
      await $.clock.sleep(2_000)
      continue
    }
    const done: number[] = []
    const results: Record<number, ActionResult> = {}
    for (const action of actions) {
      if (!handled.has(action.id) && action.type === 'reviewers-load' && Number.isInteger(action.number)) {
        results[action.id] = await loadReviewers($, action.number, action.query).catch(error => ({ ok: false, message: String(error) }))
      }
      if (!handled.has(action.id) && action.type === 'submit-branch') {
        const current = await read($, snapshot)
        const rows = current.rows
        const row = rows.find(r => r.branch === action.branch && !r.isTrunk)
        if (current.untracked) results[action.id] = { ok: false, message: 'This branch is not tracked by Graphite yet.' }
        else if (!row) results[action.id] = { ok: false, message: 'That branch is not part of the stack.' }
        else {
          await queuePrompt(
            $,
            `Submit ${layerLabel(rows, row.branch)} to GitHub with Graphite (\`gt submit\` for that branch), ` +
              'opening its PR as a draft and submitting unsubmitted layers below it as needed. ' +
              "Use the commit message as the PR title and description, and don't change any code.",
          )
          results[action.id] = { ok: true, data: { queued: turnRunning } }
        }
      }
      if (!handled.has(action.id) && action.type === 'reviewers-set' && Number.isInteger(action.number)) {
        results[action.id] = await setReviewers($, action).catch(error => ({ ok: false, message: String(error) }))
      }
      if (!handled.has(action.id) && action.type === 'thread-resolve' && typeof action.threadId === 'string') {
        results[action.id] = await setThreadResolved($, action).catch(error => ({ ok: false, message: String(error) }))
      }
      if (!handled.has(action.id) && action.type === 'pr-ready' && Number.isInteger(action.number)) {
        const cwd = await $.session.cwd()
        const argv = ['gh', 'pr', 'ready', String(action.number), ...(action.ready ? [] : ['--undo'])]
        const result = await exec($, cwd, argv).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
        results[action.id] = result.exitCode === 0 ? { ok: true } : { ok: false, message: (result.stderr || result.stdout).trim().split('\n')[0] }
        requestRefresh($, 'force')
      }
      if (!handled.has(action.id) && action.type === 'review' && (action.comments.length || action.summary)) {
        const { text, refs } = reviewPrompt(action, (await read($, snapshot)).rows)
        await storeRefs($, refs)
        await queuePrompt($, text, action.branch, refs)
        results[action.id] = { ok: true, data: { queued: turnRunning } }
      }
      handled.add(action.id)
      done.push(action.id)
    }
    if (done.length) {
      await $.http
        .fetch(`${base}/actions?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: done, results }) })
        .catch(() => undefined)
    }
  }
}

const RELEASES = 'https://api.github.com/repos/adrianjost/claude-graphite-stack-status/releases/latest'
const UPDATE_COMMANDS = [
  ['claude', 'plugin', 'marketplace', 'update', 'adrianjost'],
  ['claude', 'plugin', 'update', 'graphite-stack@adrianjost'],
]
const DAY_MS = 24 * 60 * 60_000
let updateTimer: Timer | undefined

function isNewer(a: string, b: string) {
  const [x, y] = [a, b].map(v => v.split('.').map(n => parseInt(n, 10) || 0))
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return (x![i] ?? 0) > (y![i] ?? 0)
  return false
}

async function checkUpdate($: Engine) {
  updateTimer?.cancel()
  updateTimer = $.clock.after(6 * 60 * 60_000, () => void checkUpdate($))
  try {
    const current = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version
    if (!current) return
    let latest = (await $.store.get('latestRelease')) as { at: number; version: string; url: string } | undefined
    if (!latest || Date.now() - latest.at > DAY_MS) {
      const response = await $.http.fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } })
      const release = response.ok ? (JSON.parse(response.text) as { tag_name?: string; html_url?: string }) : {}
      const version = release.tag_name?.replace(/^v/, '')
      latest = { at: Date.now(), version: version ?? latest?.version ?? current, url: release.html_url ?? latest?.url ?? '' }
      await $.store.set('latestRelease', latest)
    }
    const available = isNewer(latest.version, current) && (await $.store.get('dismissedRelease')) !== latest.version
    await update($, updateInfo, info => (available ? { version: latest.version, url: latest.url, state: info?.version === latest.version ? info.state : 'available' } : null))
    if (available && (await $.store.get('notifiedRelease')) !== latest.version) {
      await $.store.set('notifiedRelease', latest.version)
      $.ui.toast(`graphite-stack ${latest.version} is available. Update it from the stack band.`, { timeoutMs: 10_000 })
    }
  } catch (error) {
    $.ui.log(`update check failed: ${String(error)}`, { to: 'debug' })
  }
}

async function installUpdate($: Engine) {
  const info = await read($, updateInfo)
  if (!info || info.state === 'updating') return
  await update($, updateInfo, i => i && { ...i, state: 'updating' as const })
  const cwd = await $.session.cwd()
  let ok = true
  for (const argv of UPDATE_COMMANDS) {
    const result = await $.process.run(argv, { cwd, timeoutMs: 180_000 }).catch(() => undefined)
    if (result?.exitCode !== 0) {
      ok = false
      break
    }
  }
  if (ok) {
    await update($, updateInfo, i => i && { ...i, state: 'installed' as const })
    $.ui.toast(`graphite-stack ${info.version} is installed. Restart Claude Code to use it.`, { timeoutMs: 15_000 })
    return
  }
  await update($, updateInfo, i => i && { ...i, state: 'available' as const })
  await queuePrompt($, `Update the graphite-stack plugin to ${info.version}: run \`${UPDATE_COMMANDS.map(c => c.join(' ')).join(' && ')}\` and tell me to restart Claude Code afterwards. Don't change anything else.`)
}

async function dismissUpdate($: Engine) {
  const info = await read($, updateInfo)
  if (info) await $.store.set('dismissedRelease', info.version)
  await update($, updateInfo, () => null)
}

async function openReview($: Engine, branch?: string) {
  await startReview($)
  const url = await read($, reviewUrl)
  if (!url) {
    $.ui.toast("The review page couldn't start: it needs Node.js on Claude Code's PATH.", { timeoutMs: 8000 })
    return
  }
  const target = branch ? `${url}#branch=${encodeURIComponent(branch)}` : url
  const cwd = await $.session.cwd()
  const system = (await $.process.run(['uname', '-s'], { cwd }).catch(() => undefined))?.stdout.trim()
  const argv =
    system === 'Darwin'
      ? ['open', target]
      : system
        ? ['xdg-open', target]
        : ['rundll32', 'url.dll,FileProtocolHandler', target]
  const opened = await $.process.run(argv, { cwd }).catch(() => undefined)
  if (opened?.exitCode === 0) return
  $.ui.toast(`Open ${target} in your browser`, { timeoutMs: 15000 })
}

async function refresh($: Engine, mode: Mode) {
  if (isRefreshing) {
    queuedMode = stronger(queuedMode, mode)
    return
  }
  if (mode === 'github' && Date.now() - lastGithubAt < MIN_GAP_MS) {
    requestRefresh($, 'github')
    mode = 'local'
  }
  isRefreshing = true
  if (mode !== 'local') lastGithubAt = Date.now()
  try {
    const cwd = await $.session.cwd()
    const branch = (await run($, cwd, ['git', 'branch', '--show-current'])) ?? ''
    await update($, snapshot, s => ({ ...s, isLoading: true }))
    let built = branch ? await buildRows($, cwd, branch) : 'Detached HEAD.'
    if (typeof built === 'string') {
      const held = await read($, snapshot)
      if (held.rows.length && (!branch || (branch === trunkOf(held.rows) && !held.untracked))) {
        await update($, snapshot, s => ({ ...s, hold: branch ? `on ${branch}` : 'rebasing…', isLoading: false }))
        $.clock.after(3_000, () => requestRefresh($, 'local'))
        return
      }
      const fallback = branch && built !== 'Not a git repository.' ? await untrackedRows($, cwd, branch) : undefined
      if (!fallback) {
        await update($, snapshot, () => ({ branch, rows: [], columns: 1, updatedAt: Date.now(), isLoading: false }))
        return
      }
      built = fallback
    }

    const before = await read($, snapshot)
    const previous = new Map(before.rows.map(row => [row.branch, row.pr]))
    let ghIssue = before.githubIssue
    const prs =
      mode === 'local'
        ? undefined
        : await loadPrs(
            $,
            cwd,
            built.rows.filter(row => !row.isTrunk && !row.uncommittedOnly).map(row => row.branch),
            mode === 'force',
          ).then(
            result => {
              ghIssue = undefined
              return result
            },
            error => {
              ghIssue = githubIssue(error, before.updatedAt)
              return undefined
            },
          )
    const isStale = mode === 'local' ? !!before.isStale : !prs
    if (prs && [...prs].some(([branch, pr]) => JSON.stringify(pr) !== JSON.stringify(previous.get(branch)))) {
      lastChangeAt = Date.now()
    }
    const rows = await Promise.all(
      built.rows.map(async row => {
        if (row.isTrunk) return row
        const parent = row.parent
        if (built.untracked) {
          const base = row.uncommittedOnly ? 'HEAD' : await run($, cwd, ['git', 'merge-base', parent ?? '', row.branch])
          const pr = row.uncommittedOnly ? undefined : prs ? prs.get(row.branch) : previous.get(row.branch)
          return { ...row, pr, diff: base ? await worktreeStat($, cwd, base) : undefined }
        }
        const [pr, isAncestor, diff] = await Promise.all([
          prs ? prs.get(row.branch) : previous.get(row.branch),
          parent
            ? $.process
                .run(['git', 'merge-base', '--is-ancestor', parent, row.branch], { cwd })
                .then(r => r.exitCode === 0)
            : Promise.resolve(true),
          parent ? diffStat($, cwd, parent, row.branch) : Promise.resolve(undefined),
        ])
        return { ...row, pr, diff, needsRestack: !isAncestor }
      }),
    )

    await update($, snapshot, s => ({
      branch,
      rows,
      columns: built.columns,
      updatedAt: prs ? Date.now() : s.updatedAt,
      isStale,
      hold: undefined,
      untracked: built.untracked,
      githubIssue: ghIssue,
      issue: ghIssue ?? (built.detached ? detachedIssue(built.detached, built.rows.find(row => row.isTrunk)?.branch ?? 'main') : undefined),
      isLoading: false,
    }))
    if (rows.some(row => !row.isTrunk) && !review) void startReview($)
    else if (prs) void syncThreads($)
    const failing = rows.filter(r => r.pr?.ci === 'fail').length
    $.ui.status(failing ? `stack: ${failing} PR${failing > 1 ? 's' : ''} failing CI` : undefined)
  } catch (error) {
    const issue: Issue =
      error instanceof Problem ? error.issue : { message: 'The Graphite stack couldn\'t be refreshed', detail: String(error) }
    await update($, snapshot, s => ({ ...s, rows: error instanceof Problem ? [] : s.rows, issue, isLoading: false }))
  } finally {
    isRefreshing = false
    schedulePushReview($)
    if (queuedMode) {
      const next = queuedMode
      queuedMode = undefined
      void refresh($, next)
    }
  }
}

const DOT = {
  draft: '#8b949e',
  open: '#2da44e',
  merged: '#8250df',
  closed: '#cf222e',
}
const REVIEW = {
  approved: '#2da44e',
  waiting: '#8b949e',
  feedback: '#8b949e',
}
const ICON = 16
const CI_ICON = 14
const LINE = '#8b949e'
const COL = 14
const ROW = 26
const R = 4.5
const GAP = 2
const HALO_R = 6.25
const HALO_STROKE = 1.25
const CURVE = 5
const STROKE = 1.5

function prDot(pr: PrInfo): string {
  if (pr.state === 'MERGED') return DOT.merged
  if (pr.state === 'CLOSED') return DOT.closed
  return pr.isDraft ? DOT.draft : DOT.open
}

function reviewStatus(pr?: PrInfo): { alt: string; body: string } {
  const icon = (body: string) => `<g fill="none" stroke="${REVIEW.waiting}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
  if (pr?.state !== 'OPEN') return { alt: '', body: '' }
  if (pr.reviewDecision === 'APPROVED') {
    return { alt: 'approved', body: icon(`<path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="${REVIEW.approved}"/>`) }
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      alt: 'changes requested',
      body: icon('<path d="M3.5 3h9a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5v-2.5H3.5A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3z"/>'),
    }
  }
  if (pr.isDraft) return { alt: 'draft', body: '' }
  if (!pr.hasReviewers) {
    return {
      alt: 'no reviewers',
      body: icon('<circle cx="6.5" cy="5.5" r="2.5"/><path d="M2 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M13 6.5v4M11 8.5h4"/>'),
    }
  }
  return { alt: 'waiting for review', body: icon('<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>') }
}

type MetaLayout = { hasCi: boolean; numberChars: number; threadDigits: number }

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const NUMBER_FONT = 11.5
const NUMBER_CHAR = NUMBER_FONT * 0.6

function metaLayout(prs: PrInfo[]): MetaLayout {
  return {
    hasCi: prs.some(pr => pr.ci === 'fail'),
    numberChars: Math.max(0, ...prs.map(pr => `#${pr.number}`.length)),
    threadDigits: Math.max(0, ...prs.map(pr => (pr.state === 'OPEN' && pr.openThreads ? `${pr.openThreads}`.length : 0))),
  }
}

const REVIEW_TIPS: Record<string, string> = {
  approved: 'Approved',
  'changes requested': 'Changes requested',
  'no reviewers': 'No reviewers requested yet',
  'waiting for review': 'Waiting for review',
}

function metaSvg(layout: MetaLayout, pr?: PrInfo) {
  const cy = ROW / 2
  const numberX = layout.hasCi ? CI_ICON + 6 : 0
  const leftWidth = numberX + Math.ceil(layout.numberChars * NUMBER_CHAR) + 7
  const reviewWidth = ICON + (layout.threadDigits ? 3 + Math.ceil(layout.threadDigits * 6.5) : 0)
  const left: string[] = []
  const right: string[] = []
  const alt: string[] = []
  const tip: string[] = []
  if (pr) {
    alt.push(`#${pr.number}`)
    if (pr.ci === 'fail') {
      alt.push('CI failing')
      left.push(
        `<g transform="translate(0 ${cy - CI_ICON / 2})"><circle cx="7" cy="7" r="6.2" fill="${DOT.closed}"/>` +
          `<path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></g>`,
      )
    }
    left.push(
      `<text x="${numberX}" y="${cy}" dy="0.35em" font-size="${NUMBER_FONT}" font-family="${MONO}" fill="${LINE}">#${pr.number}</text>`,
    )
    const review = reviewStatus(pr)
    const label = REVIEW_TIPS[review.alt]
    if (label) tip.push(label)
    right.push(`<g transform="translate(0 ${cy - ICON / 2})">${review.body}</g>`)
    const threads = pr.state === 'OPEN' ? pr.openThreads : 0
    if (threads) {
      tip.push(`${threads} unresolved conversation${threads === 1 ? '' : 's'}`)
      right.push(
        `<text x="${ICON + 2.5}" y="${cy}" dy="0.35em" font-size="10.5" font-weight="600" ` +
          `font-family="system-ui, -apple-system, sans-serif" fill="${LINE}">${threads}</text>`,
      )
    }
  }
  const svg = (width: number, parts: string[]) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${parts.join('')}</svg>`
  return {
    left: { width: leftWidth, alt: alt.join(', ') || 'no pull request', source: svg(leftWidth, left) },
    review: { width: reviewWidth, alt: tip.join(', ') || 'no review status', tip: tip.join(' · '), source: svg(reviewWidth, right) },
  }
}


const diffText = (diff: { added: number; removed: number }) => [`+${diff.added}`, `−${diff.removed}`] as const
const DIFF_FONT = 11
const DIFF_CHAR = DIFF_FONT * 0.6

function diffSvg(diff: { added: number; removed: number }, chars: number) {
  const width = Math.ceil(chars * DIFF_CHAR) + 2
  const [added, removed] = diffText(diff)
  return {
    width,
    alt: `${diff.added} lines added, ${diff.removed} removed`,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">` +
      `<text x="${width}" y="${ROW / 2}" dy="0.35em" text-anchor="end" font-size="${DIFF_FONT}" font-family="${MONO}">` +
      `<tspan fill="${DOT.open}">${added}</tspan><tspan fill="${DOT.closed}" dx="${DIFF_CHAR}">${removed}</tspan></text></svg>`,
  }
}


const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const DOT_STEP = ROW / 6
const DOT_R = 1.25

function dotsBetween(a: number, b: number, place: (at: number) => string) {
  const out: string[] = []
  for (let k = Math.ceil(a / DOT_STEP - 1e-6); k * DOT_STEP <= b + 1e-6; k++) out.push(place(+(k * DOT_STEP).toFixed(2)))
  return out.join('')
}

function laneSvg(lane: Lane, columns: number, branch: string, color?: string, isBehind = (_: string) => false, isCurrent = false) {
  const x = (c: number) => COL / 2 + c * COL
  const cy = ROW / 2
  const clear = isCurrent ? HALO_R + HALO_STROKE / 2 + 1.5 : R + GAP
  const solid = `stroke="${LINE}" stroke-width="${STROKE}" fill="none" stroke-linecap="round"`
  const dot = (dx: number, dy: number) => `<circle cx="${dx}" cy="${dy}" r="${DOT_R}" fill="${LINE}"/>`
  const vertical = (vx: number, y1: number, y2: number, dotted: boolean) =>
    dotted ? dotsBetween(y1, y2, y => dot(vx, y)) : `<line x1="${vx}" y1="${y1}" x2="${vx}" y2="${y2}" ${solid}/>`
  const horizontal = (x1: number, x2: number, dotted: boolean) =>
    dotted ? dotsBetween(x1, x2, hx => dot(hx, cy)) : `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" ${solid}/>`
  const behind = (owner?: string) => !!owner && isBehind(owner)
  const parts: string[] = []
  lane.pipes.forEach((c, i) => parts.push(vertical(x(c), 0, ROW, behind(lane.pipeOwners?.[i]))))
  if (lane.up) parts.push(vertical(x(lane.col), 0, cy - clear, behind(lane.upOwner)))
  if (lane.down) parts.push(vertical(x(lane.col), cy + clear, ROW, behind(branch)))
  let from = x(lane.col) + clear
  lane.corners.forEach((c, i) => {
    const owners = (lane.cornerOwners ?? []).slice(i)
    if (x(c) - CURVE > from) parts.push(horizontal(from, x(c) - CURVE, owners.length > 0 && owners.every(behind)))
    from = x(c) - CURVE
    if (behind(lane.cornerOwners?.[i])) {
      const t = 0.5
      const qx = (1 - t) ** 2 * x(c) + 2 * (1 - t) * t * x(c) + t ** 2 * (x(c) - CURVE)
      const qy = (1 - t) ** 2 * (cy - CURVE) + 2 * (1 - t) * t * cy + t ** 2 * cy
      parts.push(vertical(x(c), 0, cy - CURVE, true), dot(qx, qy))
    } else {
      parts.push(`<path d="M${x(c)} 0 V${cy - CURVE} Q${x(c)} ${cy} ${x(c) - CURVE} ${cy}" ${solid}/>`)
    }
  })
  parts.push(
    color
      ? `<circle cx="${x(lane.col)}" cy="${cy}" r="${R}" fill="${color}"/>`
      : `<circle cx="${x(lane.col)}" cy="${cy}" r="${R - STROKE / 2}" fill="none" stroke="${LINE}" stroke-width="${STROKE}"/>`,
  )
  if (isCurrent) {
    parts.push(`<circle cx="${x(lane.col)}" cy="${cy}" r="${HALO_R}" fill="none" stroke="${color ?? LINE}" stroke-width="${HALO_STROKE}"/>`)
  }
  const width = columns * COL
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${parts.join('')}</svg>`,
    width,
  }
}

function pillSvg(label: { name: string; color: string }) {
  const pill = pillParts(label.name, `#${label.color}`, labelInk(label.color), 0, 0)
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${pill.width}" height="18" viewBox="0 0 ${pill.width} 18">${pill.body}</svg>`,
    width: pill.width,
    height: 18,
  }
}

const LABELS_MAX = 160
const PILL_GAP = 4

function pillParts(name: string, fill: string, ink: string, x: number, y: number, fillOpacity = 1) {
  const font = 11
  const width = Math.ceil(name.length * font * 0.6 + 14)
  const height = 18
  return {
    width,
    body:
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}" fill-opacity="${fillOpacity}"/>` +
      `<text x="${x + width / 2}" y="${y + height / 2}" dy="0.35em" text-anchor="middle" font-size="${font}" ` +
      `font-family="${MONO}" fill="${ink}">${esc(name)}</text>`,
  }
}

function labelInk(color: string) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(color.slice(i, i + 2), 16) || 0)
  return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 150 ? '#1f2328' : '#ffffff'
}

function labelsSvg(labels: PrInfo['labels']) {
  const widthOf = (name: string) => pillParts(name, '', '', 0, 0).width
  const total = (names: string[]) => names.reduce((sum, name) => sum + widthOf(name), 0) + Math.max(0, names.length - 1) * PILL_GAP
  let shown = labels
  if (total(labels.map(l => l.name)) > LABELS_MAX) {
    const more = `+${labels.length}`
    shown = []
    for (const label of labels) {
      if (total([...shown, label].map(l => l.name).concat(more)) <= LABELS_MAX) shown = [...shown, label]
    }
  }
  const hidden = labels.length - shown.length
  const y = (ROW - 18) / 2
  const pills = [
    ...shown.map(label => ({ label, ...pillParts(label.name, `#${label.color}`, labelInk(label.color), 0, y) })),
    ...(hidden ? [{ label: undefined, ...pillParts(`+${hidden}`, LINE, LINE, 0, y, 0.22) }] : []),
  ]
  return pills.map((pill, i) => {
    const width = pill.width + (i < pills.length - 1 ? PILL_GAP : 0)
    return {
      label: pill.label,
      width,
      source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${pill.body}</svg>`,
    }
  })
}

function graphiteUrl(pr: PrInfo) {
  const [, owner, repo] = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\//) ?? []
  return owner && repo ? `https://app.graphite.com/github/pr/${owner}/${repo}/${pr.number}` : pr.url
}

const fixPrompt = (issue: Issue) =>
  `The graphite-stack Claude Code plugin (github.com/adrianjost/claude-graphite-stack-status) shows this problem: ` +
  `"${issue.message}"${issue.detail ? ` (details: ${issue.detail})` : ''}. ` +
  'Investigate the cause on this machine, search the web if that helps, and suggest a fix.'

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const stored = await $.store.get('linkTarget')
    if (stored === 'github' || stored === 'graphite') await update($, linkTarget, () => stored)
    void checkUpdate($)
    await $.command.register({
      name: 'stack',
      description: 'Show or hide the Graphite stack above the prompt',
    })
    await $.tool
      .register({
        name: 'review_reply',
        description:
          'Report on the review comments you handled (refs like c1). List simply addressed refs in `fixed`; add a reply only when the comment asked a question or you didn\'t do what it asked, in one short sentence.',
        inputSchema: {
          type: 'object',
          properties: {
            fixed: { type: 'array', items: { type: 'string' } },
            replies: {
              type: 'array',
              items: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] },
            },
          },
        },
        isDeferred: false,
      })
      .catch(error => $.ui.log(`review_reply tool not registered: ${String(error)}`, { to: 'debug' }))
    void refresh($, 'github').then(async () => {
      void schedulePoll($)
      if ((await read($, snapshot)).rows.some(row => !row.isTrunk)) void startReview($)
    })

    return started
  })

  on('command.run', { command: 'stack' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    if (!hidden) void refresh($, 'force')

    return { text: hidden ? 'Graphite stack hidden.' : 'Graphite stack shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) turnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      turnRunning = false
      await endTrack($)
      await flushPrompts($)
    }
    return done
  })

  on('tool.call', { tool: REPLY_TOOL }, async ($, e) => answerReview($, e))

  on('turn.abort', async ($, e, next) => {
    const done = await next(e)
    turnRunning = false
    await endTrack($)
    await flushPrompts($)
    return done
  })


  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'terminal') {
      const wasPaused = isPaused()
      hasSeenAttach = true
      attachedClients.add(e.clientId)
      if (wasPaused) requestRefresh($, 'github')
    }
    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    if (e.surface !== 'terminal') hasSeenAttach = true
    attachedClients.delete(e.clientId)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (GITHUB_COMMAND.test(e.command)) requestRefresh($, 'force')
    else if (/\b(gt|git)\s/.test(e.command)) requestRefresh($, 'local')

    return ran
  })

  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const ran = await next(e)
    schedulePushReview($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || (await read($, isHidden)) || (!s.rows.length && !s.issue)) return next(e)

    if (e.surface !== 'desktop') return next(e)
    const elements = $.ui.resolve(e)
    if (!('Svg' in elements)) return next(e)
    const { Box, Text, Button, Link, Svg, Select } = elements

    const links = await read($, linkTarget)
    const busy = await read($, working)
    const behind = new Set(s.rows.filter(row => row.needsRestack).map(row => row.branch))
    const prUrl = (pr: PrInfo) => (links === 'graphite' ? graphiteUrl(pr) : pr.url)
    const prs = s.rows.filter(row => row.pr)
    const failing = prs.filter(row => row.pr?.ci === 'fail').length
    const diffChars = Math.max(
      0,
      ...s.rows.map(row => (row.diff ? diffText(row.diff).join(' ').length : 0)),
    )
    const layout = metaLayout(prs.flatMap(row => (row.pr ? [row.pr] : [])))
    const newVersion = await read($, updateInfo)
    const summary = [
      s.untracked && !prs.length ? '' : `${prs.length} PR${prs.length === 1 ? '' : 's'}`,
      failing ? `${failing} failing` : '',
      busy ?? s.hold ?? (s.isLoading ? 'refreshing…' : ''),

    ].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column">
        {newVersion ? (
          <Box key="update" flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
            <Text color="suggestion">
              {newVersion.state === 'installed'
                ? `graphite-stack ${newVersion.version} is installed. Restart Claude Code to use it.`
                : `graphite-stack ${newVersion.version} is available.`}
            </Text>
            {newVersion.url ? <Link key="notes" href={newVersion.url} label="Release notes" /> : null}
            <Box flexGrow={1} />
            {newVersion.state === 'installed' ? null : (
              <Button
                key="install"
                label={newVersion.state === 'updating' ? 'Updating…' : 'Update'}
                onPress={() => void installUpdate($)}
              />
            )}
            <Button key="dismiss" plain dimColor label="Dismiss" onPress={() => void dismissUpdate($)} />
          </Box>
        ) : null}
        <Box flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
          <Text bold>Graphite stack</Text>
          <Text dimColor>{summary}</Text>
          <Box flexGrow={1} />
          <Select
            key="links"
            label="Links"
            value={links}
            options={[
              { value: 'github', label: 'GitHub' },
              { value: 'graphite', label: 'Graphite' },
            ]}
            onSelect={value => {
              const target: LinkTarget = value === 'graphite' ? 'graphite' : 'github'
              void update($, linkTarget, () => target)
              void $.store.set('linkTarget', target)
            }}
          />
          <Button key="review" plain dimColor label="Review stack" onPress={() => void openReview($, s.branch)} />
          {!s.untracked && (
            <Button
              key="sync"
              plain
              dimColor
              label={busy && !busy.startsWith('Restacking') ? 'Syncing…' : 'Sync with main'}
              onPress={() => void stackAction($)}
            />
          )}
          <Button key="refresh" plain dimColor label="Refresh" onPress={() => void refresh($, 'force')} />
          <Button key="hide" plain dimColor label="Hide" onPress={() => void update($, isHidden, () => true)} />
        </Box>
        {s.issue && (
          <Box flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
            <Text color="warning">⚠</Text>
            <Box flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">{s.issue.message}</Text>
            </Box>
            {s.issue.detail && (
              <Box flexShrink={2} minWidth={0}>
                <Text dimColor wrap="truncate-end">{s.issue.detail}</Text>
              </Box>
            )}
            {s.issue.canFix !== false && (
              <Box flexShrink={0}>
                <Button
                  key="fix-issue"
                  plain
                  label={s.issue.fix?.label ?? 'Suggest fix'}
                  onPress={() => {
                    const issue = s.issue
                    if (issue) void $.prompt.submit({ text: issue.fix?.prompt ?? fixPrompt(issue), asUser: true })
                  }}
                />
              </Box>
            )}
          </Box>
        )}
        {s.rows.map(row => {
          const pr = row.pr
          const lane = laneSvg(row.lane, s.columns, row.branch, pr ? prDot(pr) : undefined, owner => behind.has(owner), row.isCurrent)
          const meta = metaSvg(layout, pr)

          return (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Svg source={lane.source} alt={row.parent ? `${row.branch} on ${row.parent}` : row.branch} width={lane.width} height={ROW} />
              <Box flexDirection="row" flexShrink={0}>
                <Box key={`meta-${row.branch}`} flexShrink={0}>
                  <Svg source={meta.left.source} alt={meta.left.alt} width={meta.left.width} height={ROW} />
                  {pr?.ci === 'fail' && (
                    <Box
                      position="absolute"
                      top={1}
                      left={0}
                      display="none"
                      hover={{ display: 'flex' }}
                      flexDirection="column"
                      paddingX={1}
                    >
                      <Box flexDirection="row" gap={1}>
                        <Text color="error" bold>CI failing</Text>
                        <Text dimColor>
                          {pr.ciCounts.fail} of {pr.ciCounts.pass + pr.ciCounts.fail + pr.ciCounts.pending} checks
                          {pr.ciCounts.pending ? ` · ${pr.ciCounts.pending} still running` : ''}
                        </Text>
                      </Box>
                      {pr.failing.map(check => (
                        <Box flexDirection="row" gap={1}>
                          <Text color="error">✕</Text>
                          {check.url ? <Link href={check.url} label={check.name} /> : <Text>{check.name}</Text>}
                          {check.workflow && check.workflow !== check.name && <Text dimColor>{check.workflow}</Text>}
                        </Box>
                      ))}
                      <Link href={`${pr.url}/checks`} label="All checks on GitHub →" />
                    </Box>
                  )}
                </Box>
                <Box key={`review-${row.branch}`} flexShrink={0}>
                  <Svg source={meta.review.source} alt={meta.review.alt} width={meta.review.width} height={ROW} />
                  {meta.review.tip && (
                    <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }} paddingX={1}>
                      <Text>{meta.review.tip}</Text>
                    </Box>
                  )}
                </Box>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                {pr ? (
                  <Link href={prUrl(pr)}><Text wrap="truncate-end">{pr.title}</Text></Link>
                ) : row.uncommittedOnly ? (
                  <Text dimColor italic wrap="truncate-end">uncommitted changes on {row.branch}</Text>
                ) : (
                  <Text dimColor italic={!row.isTrunk} wrap="truncate-end">{row.branch}</Text>
                )}
              </Box>
              {s.untracked && !row.isTrunk && !row.uncommittedOnly && (
                <Box flexShrink={0}>
                  <Text dimColor>not tracked by Graphite</Text>
                </Box>
              )}
              {row.needsRestack && (
                <Box flexShrink={0}>
                  <Button
                    key={`restack-${row.branch}`}
                    plain
                    label={busy === `Restacking ${row.branch}…` ? '↻ restacking…' : '↻ restack'}
                    onPress={() => void stackAction($, row.branch)}
                  />
                </Box>
              )}
              {pr && pr.labels.length > 0 && (
                <Box flexDirection="row" alignItems="center" flexShrink={0}>
                  {labelsSvg(pr.labels).map(pill => (
                    <Box key={`label-${row.branch}-${pill.label?.name ?? 'more'}`} flexShrink={0}>
                      <Svg source={pill.source} alt={pill.label?.name ?? pr.labels.map(l => l.name).join(', ')} width={pill.width} height={ROW} />
                      {pill.label ? (
                        pill.label.description && (
                          <Box position="absolute" top={1} right={0} display="none" hover={{ display: 'flex' }} paddingX={1}>
                            <Text>{pill.label.description}</Text>
                          </Box>
                        )
                      ) : (
                        <Box
                          position="absolute"
                          top={1}
                          right={0}
                          display="none"
                          hover={{ display: 'flex' }}
                          flexDirection="column"
                          paddingX={1}
                        >
                          <Text dimColor>{pr.labels.length} labels</Text>
                          {pr.labels.map(label => {
                            const badge = pillSvg(label)
                            return (
                              <Box flexDirection="row" alignItems="center" gap={1}>
                                <Svg source={badge.source} alt={label.name} width={badge.width} height={badge.height} />
                                {label.description && <Text dimColor>{label.description}</Text>}
                              </Box>
                            )
                          })}
                        </Box>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
              {diffChars > 0 && (() => {
                if (!row.diff || row.isTrunk) {
                  const width = Math.ceil(diffChars * DIFF_CHAR) + 2
                  const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}"></svg>`
                  return <Svg source={blank} alt="no changes" width={width} height={ROW} />
                }
                const stat = diffSvg(row.diff, diffChars)
                return (
                  <Box key={`diff-${row.branch}`} flexShrink={0} justifyContent="flex-end">
                    <Svg source={stat.source} alt={stat.alt} width={stat.width} height={ROW} />
                    <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
                      <Button key={`review-${row.branch}`} plain label="Review ↗" onPress={() => void openReview($, row.branch)} />
                    </Box>
                  </Box>
                )
              })()}
            </Box>
          )
        })}
      </Box>
    )
  })
}
