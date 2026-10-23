import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { CiState, DiffFile, DiffView, Issue, Lane, LinkTarget, PrInfo, StackRow, StackSnapshot } from '../types'

const POLL_MS = 60_000
const POLL_BUSY_MS = 30_000
const POLL_QUIET_MS = 5 * 60_000
const QUIET_AFTER_MS = 10 * 60_000
const MIN_GAP_MS = 15_000
const LOCAL_DELAY_MS = 1_500
const SHARED_CACHE_MS = 55_000
const GITHUB_COMMAND = /\b(git\s+push|gt\s+(submit|ss|sync|merge|get|land|repo\s+sync)|gh\s+pr)\b/
const EMPTY: StackSnapshot = { branch: '', rows: [], columns: 1, updatedAt: 0, isLoading: false }
const snapshot = atom({ plugin: 'graphite-stack', key: 'snapshot' } as const, EMPTY)
const isHidden = atom({ plugin: 'graphite-stack', key: 'isHidden' } as const, false)
const DIFF_PANE = 'graphite-stack-diff'
const DIFF_MAX_CHARS = 90_000
const DIFF_DRAW_BUDGET = 95_000
const diffView = atom({ plugin: 'graphite-stack', key: 'diffView' } as const, null as DiffView | null)
const linkTarget = atom({ plugin: 'graphite-stack', key: 'linkTarget' } as const, 'github' as LinkTarget)

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
  labels: { nodes: { name: string; color: string; description: string | null }[] }
  reviewRequests: { totalCount: number }
  latestReviews: { totalCount: number }
  reviewThreads: { nodes: { isResolved: boolean }[] }
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: GqlCheck[] } } | null } }[] }
}

const PR_FIELDS =
  'number title url state isDraft reviewDecision labels(first:20){nodes{name color description}} ' +
  'reviewRequests{totalCount} latestReviews{totalCount} reviewThreads(first:100){nodes{isResolved}} ' +
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

async function exec($: Engine, cwd: string, argv: string[]) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs: 30_000 })
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

async function diffStat($: Engine, cwd: string, parent: string, branch: string) {
  const out = await run($, cwd, ['git', 'diff', '-w', '--numstat', `${parent}...${branch}`])
  if (out === undefined) return undefined
  let added = 0
  let removed = 0
  for (const line of out.split('\n')) {
    const [a, r] = line.split('\t')
    added += Number(a) || 0
    removed += Number(r) || 0
  }
  return added || removed ? { added, removed } : undefined
}

class GitHubError extends Error {}

async function githubRepo($: Engine, cwd: string) {
  const url = (await run($, cwd, ['git', 'remote', 'get-url', 'origin'])) ?? ''
  const [, owner, name] = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/) ?? []
  return owner && name ? { owner, name } : undefined
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
    hasReviewers: pr.reviewRequests.totalCount + pr.latestReviews.totalCount > 0,
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

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', svg: 'xml', xml: 'xml',
  py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  graphql: 'graphql', gql: 'graphql', vue: 'vue', svelte: 'svelte', php: 'php', c: 'c', h: 'c', cpp: 'cpp',
}

const languageOf = (path: string) => LANGUAGES[path.split('.').pop()?.toLowerCase() ?? '']

const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.gen(\.[^/]*)?$|\.min\.(js|css)$|\.snap$|(^|\/)(generated|__generated__|insurance-tables)\//

function parseDiff(out: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const chunk of out.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n')
    const target = lines.find(line => line.startsWith('+++ '))?.slice(4)
    const source = lines.find(line => line.startsWith('--- '))?.slice(4)
    const path = (target && target !== '/dev/null' ? target : source ?? lines[0] ?? '?').replace(/^[ab]\//, '')
    const start = lines.findIndex(line => line.startsWith('@@'))
    const hunks = start < 0 ? '' : lines.slice(start).join('\n').trimEnd()
    let added = 0
    let removed = 0
    for (const line of start < 0 ? [] : lines.slice(start)) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
    const isNew = lines.some(line => line.startsWith('new file mode')) || source === '/dev/null'
    const body = isNew
      ? lines
          .slice(start)
          .filter(line => line.startsWith('+'))
          .map(line => line.slice(1))
          .join('\n')
      : hunks
    const isTooLarge = body.length > DIFF_MAX_CHARS
    files.push({
      path,
      added,
      removed,
      hunks: isTooLarge ? '' : body,
      isTooLarge,
      isBinary: start < 0,
      isNew,
      isGenerated: GENERATED.test(path),
    })
  }
  return files
}

type DiffTarget = Pick<DiffView, 'branch' | 'parent' | 'trunk' | 'compareTo' | 'showWhitespace' | 'title' | 'url'>

async function loadDiff($: Engine, target: DiffTarget, keepCollapsed?: string[]) {
  await update($, diffView, view => ({
    ...target,
    root: view?.root ?? '',
    commits: view?.branch === target.branch ? view.commits : [],
    files: view?.branch === target.branch ? view.files : [],
    collapsed: view?.collapsed ?? [],
    isLoading: true,
  }))
  const cwd = await $.session.cwd()
  const base = target.compareTo === 'trunk' ? target.trunk : target.parent
  const [out, log, head, root] = await Promise.all([
    run($, cwd, ['git', 'diff', ...(target.showWhitespace ? [] : ['-w']), '--no-color', '--no-ext-diff', `${base}...${target.branch}`]),
    run($, cwd, ['git', 'log', '--format=%h%x09%s', `${base}..${target.branch}`]),
    run($, cwd, ['git', 'rev-parse', target.branch]),
    run($, cwd, ['git', 'rev-parse', '--show-toplevel']),
  ])
  const files = out === undefined ? [] : parseDiff(out)
  const paths = new Set(files.map(file => file.path))
  await update($, diffView, () => ({
    ...target,
    root: root ?? '',
    headSha: head,
    commits: (log ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha = '', ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      }),
    files,
    collapsed: keepCollapsed
      ? keepCollapsed.filter(path => paths.has(path))
      : files.filter(file => file.isGenerated).map(file => file.path),
    isLoading: false,
    error: out === undefined ? `git diff ${base}...${target.branch} failed` : undefined,
  }))
}

function stackOrder(rows: StackRow[]) {
  return [...rows].reverse().filter(row => !row.isTrunk && row.parent)
}

async function openDiff($: Engine, row: StackRow, options?: Partial<Pick<DiffView, 'compareTo' | 'showWhitespace'>>) {
  if (!row.parent) return
  const [view, s] = await Promise.all([read($, diffView), read($, snapshot)])
  const trunk = s.rows.find(r => r.isTrunk)?.branch ?? row.parent
  const isSame = view?.branch === row.branch
  void $.ui.open({ id: DIFF_PANE, title: row.pr ? `#${row.pr.number} changes` : 'Branch changes' })
  await loadDiff(
    $,
    {
      branch: row.branch,
      parent: row.parent,
      trunk,
      compareTo: options?.compareTo ?? view?.compareTo ?? 'parent',
      showWhitespace: options?.showWhitespace ?? view?.showWhitespace ?? false,
      title: row.pr ? `#${row.pr.number} ${row.pr.title}` : row.branch,
      url: row.pr?.url,
    },
    isSame && options ? view?.collapsed : undefined,
  )
}

async function refreshDiff($: Engine) {
  const view = await read($, diffView)
  if (!view?.branch || view.isLoading) return
  const cwd = await $.session.cwd()
  const head = await run($, cwd, ['git', 'rev-parse', view.branch])
  if (head && head !== view.headSha) await loadDiff($, view, view.collapsed)
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

async function buildRows(
  $: Engine,
  cwd: string,
  branch: string,
): Promise<{ rows: StackRow[]; columns: number; detached?: string } | string> {
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
    isCurrent: false,
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
    const built = branch ? await buildRows($, cwd, branch) : 'Detached HEAD.'
    if (typeof built === 'string') {
      await update($, snapshot, () => ({ branch, rows: [], columns: 1, updatedAt: Date.now(), isLoading: false }))
      return
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
            built.rows.filter(row => !row.isTrunk).map(row => row.branch),
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
      githubIssue: ghIssue,
      issue: ghIssue ?? (built.detached ? detachedIssue(built.detached, built.rows.find(row => row.isTrunk)?.branch ?? 'main') : undefined),
      isLoading: false,
    }))
    void refreshDiff($)
    const failing = rows.filter(r => r.pr?.ci === 'fail').length
    $.ui.status(failing ? `stack: ${failing} PR${failing > 1 ? 's' : ''} failing CI` : undefined)
  } catch (error) {
    const issue: Issue =
      error instanceof Problem ? error.issue : { message: 'The Graphite stack couldn\'t be refreshed', detail: String(error) }
    await update($, snapshot, s => ({ ...s, rows: error instanceof Problem ? [] : s.rows, issue, isLoading: false }))
  } finally {
    isRefreshing = false
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
const ROW = 24
const R = 4.5
const GAP = 2
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

const DOT_STEP = 4
const DOT_R = 1.25

function dotsBetween(a: number, b: number, place: (at: number) => string) {
  const out: string[] = []
  for (let at = Math.ceil(a / DOT_STEP) * DOT_STEP; at <= b; at += DOT_STEP) out.push(place(at))
  return out.join('')
}

function laneSvg(lane: Lane, columns: number, branch: string, color?: string, isBehind = (_: string) => false) {
  const x = (c: number) => COL / 2 + c * COL
  const cy = ROW / 2
  const solid = `stroke="${LINE}" stroke-width="${STROKE}" stroke-opacity="0.7" fill="none" stroke-linecap="round"`
  const dot = (dx: number, dy: number) => `<circle cx="${dx}" cy="${dy}" r="${DOT_R}" fill="${LINE}"/>`
  const vertical = (vx: number, y1: number, y2: number, dotted: boolean) =>
    dotted ? dotsBetween(y1, y2, y => dot(vx, y)) : `<line x1="${vx}" y1="${y1}" x2="${vx}" y2="${y2}" ${solid}/>`
  const horizontal = (x1: number, x2: number, dotted: boolean) =>
    dotted ? dotsBetween(x1, x2, hx => dot(hx, cy)) : `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" ${solid}/>`
  const behind = (owner?: string) => !!owner && isBehind(owner)
  const parts: string[] = []
  lane.pipes.forEach((c, i) => parts.push(vertical(x(c), 0, ROW, behind(lane.pipeOwners?.[i]))))
  if (lane.up) parts.push(vertical(x(lane.col), 0, cy - R - GAP, behind(lane.upOwner)))
  if (lane.down) parts.push(vertical(x(lane.col), cy + R + GAP, ROW, behind(branch)))
  let from = x(lane.col) + R + GAP
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
    await $.command.register({
      name: 'stack',
      description: 'Show or hide the Graphite stack above the prompt',
    })
    void refresh($, 'github').then(() => schedulePoll($))

    return started
  })

  on('command.run', { command: 'stack' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    if (!hidden) void refresh($, 'force')

    return { text: hidden ? 'Graphite stack hidden.' : 'Graphite stack shown.' }
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

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    if (!('Select' in elements)) return <elements.Text dimColor>The diff view needs the Claude Code desktop app.</elements.Text>
    const { Box, Text, Link, Code, Button, Select } = elements
    const view = await read($, diffView)
    if (!view?.branch) return <Text dimColor>Hover a branch's line counts and click View diff to see its changes.</Text>
    const order = stackOrder((await read($, snapshot)).rows)
    const at = order.findIndex(row => row.branch === view.branch)
    const previous = at > 0 ? order[at - 1] : undefined
    const following = at >= 0 ? order[at + 1] : undefined
    const added = view.files.reduce((sum, file) => sum + file.added, 0)
    const removed = view.files.reduce((sum, file) => sum + file.removed, 0)
    const collapsed = new Set(view.collapsed)
    const setCollapsed = (paths: string[]) => void update($, diffView, v => (v ? { ...v, collapsed: paths } : v))
    const toggle = (path: string) =>
      setCollapsed(collapsed.has(path) ? view.collapsed.filter(p => p !== path) : [...view.collapsed, path])
    const base = view.compareTo === 'trunk' ? view.trunk : view.parent
    let budget = DIFF_DRAW_BUDGET

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            {previous && (
              <Box flexShrink={0}>
                <Button key="diff-previous" plain label="◀" onPress={() => void openDiff($, previous)} />
              </Box>
            )}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text bold wrap="truncate-end">{view.title}</Text>
            </Box>
            {following && (
              <Box flexShrink={0}>
                <Button key="diff-next" plain label="▶" onPress={() => void openDiff($, following)} />
              </Box>
            )}
          </Box>
          <Text dimColor>
            {view.isLoading
              ? 'loading…'
              : `${view.files.length} file${view.files.length === 1 ? '' : 's'} · +${added} −${removed} · ` +
                `${view.commits.length} commit${view.commits.length === 1 ? '' : 's'} · ` +
                `${at + 1} of ${order.length} in the stack`}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={2} flexWrap="wrap">
          <Select
            key="diff-compare"
            label="Compare to"
            value={view.compareTo}
            options={[
              { value: 'parent', label: `parent (${view.parent})` },
              { value: 'trunk', label: view.trunk },
            ]}
            onSelect={value => {
              const row = order[at]
              if (row) void openDiff($, row, { compareTo: value === 'trunk' ? 'trunk' : 'parent' })
            }}
          />
          <Select
            key="diff-whitespace"
            label="Whitespace"
            value={view.showWhitespace ? 'shown' : 'ignored'}
            options={[
              { value: 'ignored', label: 'ignored' },
              { value: 'shown', label: 'shown' },
            ]}
            onSelect={value => {
              const row = order[at]
              if (row) void openDiff($, row, { showWhitespace: value === 'shown' })
            }}
          />
          <Button key="diff-expand-all" plain label="Expand all" onPress={() => setCollapsed([])} />
          <Button key="diff-collapse-all" plain label="Collapse all" onPress={() => setCollapsed(view.files.map(f => f.path))} />
        </Box>
        {view.error && <Text color="error">{view.error}</Text>}
        {view.commits.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Commits since {base}</Text>
            {view.commits.map(commit => (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{commit.sha}</Text>
                <Text wrap="truncate-end">{commit.subject}</Text>
              </Box>
            ))}
          </Box>
        )}
        {view.files.length > 1 && (
          <Box flexDirection="column">
            <Text dimColor>Files</Text>
            {view.files.map((file, i) => (
              <Box flexDirection="row" gap={1}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button
                    key={`jump-${i}`}
                    plain
                    dimColor={file.isGenerated}
                    label={file.path}
                    onPress={() => {
                      if (collapsed.has(file.path)) toggle(file.path)
                      void $.ui.scroll({ in: DIFF_PANE, to: { key: `file-${i}` } })
                    }}
                  />
                </Box>
                <Text color="success">+{file.added}</Text>
                <Text color="error">−{file.removed}</Text>
              </Box>
            ))}
          </Box>
        )}
        {view.files.map((file, i) => {
          const isOpen = !collapsed.has(file.path)
          const size = file.hunks.length
          const fits = size <= budget
          if (isOpen && fits) budget -= size
          return (
            <Box key={`file-${i}`} flexDirection="column">
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Box flexShrink={0}>
                  <Button key={`toggle-${i}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(file.path)} />
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  {view.root ? (
                    <Link href={`file://${view.root}/${file.path}`}>
                      <Text bold wrap="truncate-start">{file.path}</Text>
                    </Link>
                  ) : (
                    <Text bold wrap="truncate-start">{file.path}</Text>
                  )}
                </Box>
                {file.isNew && <Text color="success">new</Text>}
                {file.isGenerated && <Text dimColor>generated</Text>}
                <Text color="success">+{file.added}</Text>
                <Text color="error">−{file.removed}</Text>
                <Box flexGrow={1} />
                <Box flexShrink={0}>
                  <Button
                    key={`ask-${i}`}
                    plain
                    dimColor
                    label="Ask Claude"
                    onPress={() =>
                      void $.prompt.submit({
                        text:
                          `Review the changes to \`${file.path}\` in ${view.title} (branch \`${view.branch}\`, compared to \`${base}\`). ` +
                          'Explain what changed, and point out bugs, risks or anything unclear.',
                        asUser: true,
                      })
                    }
                  />
                </Box>
              </Box>
              {!isOpen ? null : file.isBinary ? (
                <Text dimColor>binary file</Text>
              ) : file.isTooLarge || !fits ? (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>
                    {file.isTooLarge ? 'too large to show here' : 'collapse other files to show this one'}
                  </Text>
                  {view.url && <Link href={`${view.url}/files`} label="open on GitHub" />}
                </Box>
              ) : file.isNew ? (
                file.hunks && <Code source={file.hunks} language={languageOf(file.path)} path={file.path} startLine={1} />
              ) : (
                file.hunks && <Code source={file.hunks} format="diff" language={languageOf(file.path)} path={file.path} />
              )}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || (await read($, isHidden)) || (!s.rows.length && !s.issue)) return next(e)

    if (e.surface !== 'desktop') return next(e)
    const elements = $.ui.resolve(e)
    if (!('Svg' in elements)) return next(e)
    const { Box, Text, Button, Link, Svg, Select } = elements

    const links = await read($, linkTarget)
    const behind = new Set(s.rows.filter(row => row.needsRestack).map(row => row.branch))
    const prUrl = (pr: PrInfo) => (links === 'graphite' ? graphiteUrl(pr) : pr.url)
    const prs = s.rows.filter(row => row.pr)
    const failing = prs.filter(row => row.pr?.ci === 'fail').length
    const diffChars = Math.max(
      0,
      ...s.rows.map(row => (row.diff ? diffText(row.diff).join(' ').length : 0)),
    )
    const layout = metaLayout(prs.flatMap(row => (row.pr ? [row.pr] : [])))
    const summary = [
      `${prs.length} PR${prs.length === 1 ? '' : 's'}`,
      failing ? `${failing} failing` : '',
      s.isLoading ? 'refreshing…' : '',

    ].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column">
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
          <Button
            key="sync"
            plain
            dimColor
            label="Sync with main"
            onPress={() =>
              void $.prompt.submit({
                text:
                  'Bring my Graphite stack up to date with the latest origin/main: run `gt sync` (accept updating trunk and ' +
                  'deleting merged branches), then `gt restack` to rebase every branch of the stack onto it, resolving any ' +
                  "conflicts. Switch back to the branch I was on afterwards, don't push anything, and tell me what changed.",
                asUser: true,
              })
            }
          />
          <Button key="refresh" plain dimColor hotkey="r" label="Refresh" onPress={() => void refresh($, 'force')} />
          <Button key="hide" plain dimColor hotkey="h" label="Hide" onPress={() => void update($, isHidden, () => true)} />
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
          const lane = laneSvg(row.lane, s.columns, row.branch, pr ? prDot(pr) : undefined, owner => behind.has(owner))
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
                ) : (
                  <Text dimColor italic={!row.isTrunk} wrap="truncate-end">{row.branch}</Text>
                )}
              </Box>
              {row.needsRestack && (
                <Box flexShrink={0}>
                  <Button
                    key={`restack-${row.branch}`}
                    plain
                    label="↻ restack"
                    onPress={() =>
                      void $.prompt.submit({
                        text:
                          `Restack the Graphite branch \`${row.branch}\` onto the latest origin/main: run \`gt sync\` first ` +
                          '(accept updating trunk and deleting merged branches), then check the branch out, run `gt restack` and ' +
                          'resolve any conflicts. Switch back to the branch I was on afterwards, and don\'t push anything.',
                        asUser: true,
                      })
                    }
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
                      <Button key={`open-diff-${row.branch}`} plain label="View diff" onPress={() => void openDiff($, row)} />
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
