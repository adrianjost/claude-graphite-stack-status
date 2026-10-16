import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { CiState, DiffView, Issue, Lane, LinkTarget, PrInfo, StackRow, StackSnapshot } from '../types'

const POLL_MS = 60_000
const MIN_GAP_MS = 15_000
const EMPTY: StackSnapshot = { branch: '', rows: [], columns: 1, updatedAt: 0, isLoading: false }
const snapshot = atom({ plugin: 'graphite-stack', key: 'snapshot' } as const, EMPTY)
const isHidden = atom({ plugin: 'graphite-stack', key: 'isHidden' } as const, false)
const DIFF_PANE = 'graphite-stack-diff'
const DIFF_MAX_CHARS = 90_000
const diffView = atom({ plugin: 'graphite-stack', key: 'diffView' } as const, null as DiffView | null)
const linkTarget = atom({ plugin: 'graphite-stack', key: 'linkTarget' } as const, 'github' as LinkTarget)

type MetaRow = { branch_name: string; parent_branch_name: string | null; children: string | null }

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
let isQueued = false
let lastRefreshAt = 0
let scheduled: Timer | undefined

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

async function loadPrs($: Engine, cwd: string, branches: string[]) {
  const prs = new Map<string, PrInfo | undefined>()
  if (!branches.length) return prs
  const repo = await githubRepo($, cwd)
  if (!repo) throw new GitHubError('origin is not a GitHub repository')
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
  branches.forEach((branch, i) => {
    const pr = found[`b${i}`]?.nodes[0]
    prs.set(branch, pr ? toPrInfo(pr) : undefined)
  })
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

function parseDiff(out: string): DiffView['files'] {
  const files: DiffView['files'] = []
  let budget = DIFF_MAX_CHARS
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
    const isTooLarge = body.length > budget
    if (!isTooLarge) budget -= body.length
    files.push({ path, added, removed, hunks: isTooLarge ? '' : body, isTooLarge, isBinary: start < 0, isNew })
  }
  return files
}

async function openDiff($: Engine, row: StackRow) {
  if (!row.parent) return
  const title = row.pr ? `#${row.pr.number} ${row.pr.title}` : row.branch
  await update($, diffView, () => ({ title, url: row.pr?.url, files: [], isLoading: true }))
  void $.ui.open({ id: DIFF_PANE, title: row.pr ? `#${row.pr.number} changes` : 'Branch changes' })
  const cwd = await $.session.cwd()
  const out = await run($, cwd, ['git', 'diff', '-w', '--no-color', '--no-ext-diff', `${row.parent}...${row.branch}`])
  await update($, diffView, () =>
    out === undefined
      ? { title, url: row.pr?.url, files: [], isLoading: false, error: `git diff ${row.parent}...${row.branch} failed` }
      : { title, url: row.pr?.url, files: parseDiff(out), isLoading: false },
  )
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
  const result = await exec($, cwd, ['sqlite3', '-json', db, 'select branch_name, parent_branch_name, children from branch_metadata'])
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

async function buildRows($: Engine, cwd: string, branch: string): Promise<{ rows: StackRow[]; columns: number } | string> {
  const gitDir = await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir) return 'Not a git repository.'
  const metadata = await readMetadata($, cwd, gitDir)
  if (!metadata) return 'No Graphite metadata in this repository.'
  const meta = new Map<string, MetaRow>()
  for (const row of metadata) meta.set(row.branch_name, row)

  const current = meta.get(branch)
  if (!current || (!current.parent_branch_name && !current.children?.length)) {
    return `${branch} is not tracked by Graphite.`
  }

  let root = branch
  const seen = new Set([root])
  for (let parent = current.parent_branch_name; parent; parent = meta.get(parent)?.parent_branch_name ?? null) {
    if (seen.has(parent) || !meta.get(parent)?.parent_branch_name) break
    seen.add(parent)
    root = parent
  }
  const trunk = meta.get(root)?.parent_branch_name

  const childrenOf = (name: string) => JSON.parse(meta.get(name)?.children ?? '[]') as string[]
  const rows: StackRow[] = []
  let columns = 1
  const layout = (name: string, col: number, open: number[], parent?: string) => {
    const children = childrenOf(name)
    children.forEach((child, i) => {
      layout(child, col + i, [...open, ...children.slice(0, i).map((_, k) => col + k)], name)
    })
    const corners = children.slice(1).map((_, i) => col + i + 1)
    columns = Math.max(columns, col + 1, ...corners.map(c => c + 1))
    rows.push({
      branch: name,
      parent,
      lane: { col, up: children.length > 0, down: true, pipes: open, corners },
      isCurrent: name === branch,
      isTrunk: false,
      needsRestack: false,
    })
  }
  layout(root, 0, [], trunk ?? undefined)
  if (trunk) {
    rows.push({
      branch: trunk,
      lane: { col: 0, up: true, down: false, pipes: [], corners: [] },
      isCurrent: false,
      isTrunk: true,
      needsRestack: false,
    })
  } else {
    const last = rows.at(-1)
    if (last) last.lane.down = false
  }

  return { rows, columns }
}

function requestRefresh($: Engine) {
  if (scheduled) return
  const wait = lastRefreshAt + MIN_GAP_MS - Date.now()
  if (wait <= 0) return void refresh($)
  scheduled = $.clock.after(wait, () => {
    scheduled = undefined
    void refresh($)
  })
}

async function refresh($: Engine) {
  if (isRefreshing) {
    isQueued = true
    return
  }
  isRefreshing = true
  lastRefreshAt = Date.now()
  try {
    const cwd = await $.session.cwd()
    const branch = (await run($, cwd, ['git', 'branch', '--show-current'])) ?? ''
    await update($, snapshot, s => ({ ...s, isLoading: true }))
    const built = branch ? await buildRows($, cwd, branch) : 'Detached HEAD.'
    if (typeof built === 'string') {
      await update($, snapshot, () => ({ branch, rows: [], columns: 1, updatedAt: Date.now(), isLoading: false }))
      return
    }

    const previous = new Map((await read($, snapshot)).rows.map(row => [row.branch, row.pr]))
    const lastUpdate = (await read($, snapshot)).updatedAt
    let issue: Issue | undefined
    const prs = await loadPrs(
      $,
      cwd,
      built.rows.filter(row => !row.isTrunk).map(row => row.branch),
    ).catch(error => {
      issue = githubIssue(error, lastUpdate)
      return undefined
    })
    const isStale = !prs
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
      updatedAt: isStale ? s.updatedAt : Date.now(),
      isStale,
      issue,
      isLoading: false,
    }))
    const failing = rows.filter(r => r.pr?.ci === 'fail').length
    $.ui.status(failing ? `stack: ${failing} PR${failing > 1 ? 's' : ''} failing CI` : undefined)
  } catch (error) {
    const issue: Issue =
      error instanceof Problem ? error.issue : { message: 'The Graphite stack couldn\'t be refreshed', detail: String(error) }
    await update($, snapshot, s => ({ ...s, rows: error instanceof Problem ? [] : s.rows, issue, isLoading: false }))
  } finally {
    isRefreshing = false
    if (isQueued) {
      isQueued = false
      void refresh($)
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

function laneSvg(lane: Lane, columns: number, color?: string) {
  const x = (c: number) => COL / 2 + c * COL
  const cy = ROW / 2
  const stroke = `stroke="${LINE}" stroke-width="${STROKE}" stroke-opacity="0.7" fill="none" stroke-linecap="round"`
  const parts: string[] = []
  for (const c of lane.pipes) parts.push(`<line x1="${x(c)}" y1="0" x2="${x(c)}" y2="${ROW}" ${stroke}/>`)
  if (lane.up) parts.push(`<line x1="${x(lane.col)}" y1="0" x2="${x(lane.col)}" y2="${cy - R - GAP}" ${stroke}/>`)
  if (lane.down) parts.push(`<line x1="${x(lane.col)}" y1="${cy + R + GAP}" x2="${x(lane.col)}" y2="${ROW}" ${stroke}/>`)
  const far = Math.max(...lane.corners, -1)
  if (far >= 0) {
    parts.push(`<line x1="${x(lane.col) + R + GAP}" y1="${cy}" x2="${x(far) - CURVE}" y2="${cy}" ${stroke}/>`)
    for (const c of lane.corners) {
      parts.push(`<path d="M${x(c)} 0 V${cy - CURVE} Q${x(c)} ${cy} ${x(c) - CURVE} ${cy}" ${stroke}/>`)
    }
  }
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
    $.clock.every(POLL_MS, () => {
      void read($, isHidden).then(hidden => {
        if (!hidden) requestRefresh($)
      })
    })
    void refresh($)

    return started
  })

  on('command.run', { command: 'stack' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    if (!hidden) void refresh($)

    return { text: hidden ? 'Graphite stack hidden.' : 'Graphite stack shown.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\b(gt|gh|git)\s/.test(e.command)) requestRefresh($)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Text, Link, Code } = $.ui.resolve(e)
    const view = await read($, diffView)
    if (!view) return <Text dimColor>Click a branch's line counts to see its changes.</Text>
    const added = view.files.reduce((sum, file) => sum + file.added, 0)
    const removed = view.files.reduce((sum, file) => sum + file.removed, 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{view.title}</Text>
          <Text dimColor>
            {view.isLoading
              ? 'loading…'
              : `${view.files.length} file${view.files.length === 1 ? '' : 's'} · +${added} −${removed} · whitespace ignored`}
          </Text>
        </Box>
        {view.error && <Text color="error">{view.error}</Text>}
        {view.files.map(file => (
          <Box key={`file-${file.path}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold wrap="truncate-start">{file.path}</Text>
              {file.isNew && <Text color="success">new</Text>}
              <Text color="success">+{file.added}</Text>
              <Text color="error">−{file.removed}</Text>
            </Box>
            {file.isBinary ? (
              <Text dimColor>binary file</Text>
            ) : file.isTooLarge ? (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>too large to show here</Text>
                {view.url && <Link href={`${view.url}/files`} label="open on GitHub" />}
              </Box>
            ) : file.isNew ? (
              file.hunks && <Code source={file.hunks} language={languageOf(file.path)} path={file.path} startLine={1} />
            ) : (
              file.hunks && <Code source={file.hunks} format="diff" language={languageOf(file.path)} path={file.path} />
            )}
          </Box>
        ))}
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
          <Button key="refresh" plain dimColor hotkey="r" label="Refresh" onPress={() => void refresh($)} />
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
          const lane = laneSvg(row.lane, s.columns, pr ? prDot(pr) : undefined)
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
                          `Restack the Graphite branch \`${row.branch}\` onto its parent \`${row.parent ?? 'trunk'}\` ` +
                          '(check it out, run `gt restack`, resolve any conflicts), then switch back to the branch I was on.',
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
