import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { CiState, Lane, PrInfo, StackRow, StackSnapshot } from '../types'

const POLL_MS = 60_000
const EMPTY: StackSnapshot = { branch: '', rows: [], columns: 1, updatedAt: 0, isLoading: false }
const snapshot = atom({ plugin: 'graphite-stack', key: 'snapshot' } as const, EMPTY)
const isHidden = atom({ plugin: 'graphite-stack', key: 'isHidden' } as const, false)

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

type GhPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string
  labels: { name: string; color: string }[]
  statusCheckRollup: GhCheck[]
  reviewRequests: unknown[]
  latestReviews: unknown[]
}

let isRefreshing = false
let isQueued = false

async function run($: Engine, cwd: string, argv: string[]) {
  const result = await $.process.run(argv, { cwd, timeoutMs: 30_000 })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
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

async function countOpenThreads($: Engine, cwd: string, url: string, number: number) {
  const [, owner, repo] = url.match(/github\.com\/([^/]+)\/([^/]+)\//) ?? []
  if (!owner || !repo) return 0
  const out = await run($, cwd, [
    'gh', 'api', 'graphql',
    '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `number=${number}`,
    '-f', 'query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}',
  ])
  if (!out) return 0
  const data = JSON.parse(out) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes: { isResolved: boolean }[] } } } }
  }
  return data.data?.repository?.pullRequest?.reviewThreads?.nodes.filter(t => !t.isResolved).length ?? 0
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

async function loadPr($: Engine, cwd: string, branch: string): Promise<PrInfo | undefined> {
  const out = await run($, cwd, [
    'gh', 'pr', 'view', branch,
    '--json', 'number,title,url,state,isDraft,reviewDecision,labels,statusCheckRollup,reviewRequests,latestReviews',
  ])
  if (!out) return undefined
  const pr = JSON.parse(out) as GhPr
  const openThreads = await countOpenThreads($, cwd, pr.url, pr.number)
  const ciCounts = { pass: 0, fail: 0, pending: 0 }
  const failing: PrInfo['failing'] = []
  for (const check of latestChecks(pr.statusCheckRollup ?? [])) {
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
    labels: (pr.labels ?? []).map(l => ({ name: l.name, color: l.color })),
    ci,
    ciCounts,
    failing,
    openThreads,
    hasReviewers: (pr.reviewRequests ?? []).length + (pr.latestReviews ?? []).length > 0,
  }
}

async function buildRows($: Engine, cwd: string, branch: string): Promise<{ rows: StackRow[]; columns: number } | string> {
  const gitDir = await run($, cwd, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir) return 'Not a git repository.'
  const out = await run($, cwd, [
    'sqlite3', '-json', `${gitDir}/.graphite_metadata.db`,
    'select branch_name, parent_branch_name, children from branch_metadata',
  ])
  if (out === undefined) return 'No Graphite metadata in this repository.'
  const meta = new Map<string, MetaRow>()
  for (const row of JSON.parse(out || '[]') as MetaRow[]) meta.set(row.branch_name, row)

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

async function refresh($: Engine) {
  if (isRefreshing) {
    isQueued = true
    return
  }
  isRefreshing = true
  try {
    const cwd = await $.session.cwd()
    const branch = (await run($, cwd, ['git', 'branch', '--show-current'])) ?? ''
    await update($, snapshot, s => ({ ...s, isLoading: true }))
    const built = branch ? await buildRows($, cwd, branch) : 'Detached HEAD.'
    if (typeof built === 'string') {
      await update($, snapshot, () => ({ branch, rows: [], columns: 1, error: built, updatedAt: Date.now(), isLoading: false }))
      return
    }

    const rows = await Promise.all(
      built.rows.map(async row => {
        if (row.isTrunk) return row
        const parent = row.parent
        const [pr, isAncestor, diff] = await Promise.all([
          loadPr($, cwd, row.branch).catch(() => undefined),
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

    await update($, snapshot, () => ({ branch, rows, columns: built.columns, updatedAt: Date.now(), isLoading: false }))
    const failing = rows.filter(r => r.pr?.ci === 'fail').length
    $.ui.status(failing ? `stack: ${failing} PR${failing > 1 ? 's' : ''} failing CI` : undefined)
  } catch (error) {
    await update($, snapshot, s => ({ ...s, error: String(error), isLoading: false }))
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

function metaSvg(layout: MetaLayout, pr?: PrInfo) {
  const cy = ROW / 2
  const numberX = layout.hasCi ? CI_ICON + 6 : 0
  const reviewX = numberX + Math.ceil(layout.numberChars * NUMBER_CHAR) + 7
  const width = reviewX + ICON + (layout.threadDigits ? 3 + Math.ceil(layout.threadDigits * 6.5) : 0)
  const parts: string[] = []
  const alt: string[] = []
  if (pr) {
    alt.push(`#${pr.number}`)
    if (pr.ci === 'fail') {
      alt.push('CI failing')
      parts.push(
        `<g transform="translate(0 ${cy - CI_ICON / 2})"><circle cx="7" cy="7" r="6.2" fill="${DOT.closed}"/>` +
          `<path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></g>`,
      )
    }
    parts.push(
      `<text x="${numberX}" y="${cy}" dy="0.35em" font-size="${NUMBER_FONT}" font-family="${MONO}" fill="${LINE}">#${pr.number}</text>`,
    )
    const review = reviewStatus(pr)
    if (review.alt) alt.push(review.alt)
    parts.push(`<g transform="translate(${reviewX} ${cy - ICON / 2})">${review.body}</g>`)
    const threads = pr.state === 'OPEN' ? pr.openThreads : 0
    if (threads) {
      alt.push(`${threads} open conversation${threads === 1 ? '' : 's'}`)
      parts.push(
        `<text x="${reviewX + ICON + 2.5}" y="${cy}" dy="0.35em" font-size="10.5" font-weight="600" ` +
          `font-family="system-ui, -apple-system, sans-serif" fill="${LINE}">${threads}</text>`,
      )
    }
  }
  return {
    alt: alt.join(', ') || 'no pull request',
    width,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${parts.join('')}</svg>`,
  }
}

const DIFF_FONT = 11
const DIFF_CHAR = DIFF_FONT * 0.6

const diffText = (diff: { added: number; removed: number }) => [`+${diff.added}`, `−${diff.removed}`] as const

function diffSvg(diff: { added: number; removed: number } | undefined, chars: number) {
  const width = Math.ceil(chars * DIFF_CHAR) + 2
  const body = diff
    ? `<text x="${width}" y="${ROW / 2}" dy="0.35em" text-anchor="end" font-size="${DIFF_FONT}" font-family="${MONO}">` +
      `<tspan fill="${DOT.open}">${diffText(diff)[0]}</tspan><tspan fill="${DOT.closed}" dx="${DIFF_CHAR}">${diffText(diff)[1]}</tspan></text>`
    : ''
  return {
    width,
    alt: diff ? `${diff.added} lines added, ${diff.removed} removed` : 'no changes',
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${body}</svg>`,
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
  const parts: string[] = []
  let x = 0
  for (const label of shown) {
    const pill = pillParts(label.name, `#${label.color}`, labelInk(label.color), x, y)
    parts.push(pill.body)
    x += pill.width + PILL_GAP
  }
  if (hidden) {
    const pill = pillParts(`+${hidden}`, LINE, LINE, x, y, 0.22)
    parts.push(pill.body)
    x += pill.width + PILL_GAP
  }
  const width = Math.max(0, x - PILL_GAP)
  return {
    width,
    hidden,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 0 ${width} ${ROW}">${parts.join('')}</svg>`,
  }
}

function graphiteUrl(pr: PrInfo) {
  const [, owner, repo] = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\//) ?? []
  return owner && repo ? `https://app.graphite.com/github/pr/${owner}/${repo}/${pr.number}` : pr.url
}

export const register: Register = (on, options) => {
  const prUrl = (pr: PrInfo) => (options.prLinks === 'graphite' ? graphiteUrl(pr) : pr.url)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'stack',
      description: 'Show or hide the Graphite stack above the prompt',
    })
    $.clock.every(POLL_MS, () => void refresh($))
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
    if (/\b(gt|gh|git)\s/.test(e.command)) void refresh($)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || (await read($, isHidden)) || !s.rows.length) return next(e)

    if (e.surface !== 'desktop') return next(e)
    const elements = $.ui.resolve(e)
    if (!('Svg' in elements)) return next(e)
    const { Box, Text, Button, Link, Svg } = elements

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
          <Button key="refresh" plain dimColor hotkey="r" label="Refresh" onPress={() => void refresh($)} />
          <Button key="hide" plain dimColor hotkey="h" label="Hide" onPress={() => void update($, isHidden, () => true)} />
        </Box>
        {s.rows.map(row => {
          const pr = row.pr
          const lane = laneSvg(row.lane, s.columns, pr ? prDot(pr) : undefined)
          const meta = metaSvg(layout, pr)

          return (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Svg source={lane.source} alt={row.parent ? `${row.branch} on ${row.parent}` : row.branch} width={lane.width} height={ROW} />
              <Box key={`meta-${row.branch}`} flexShrink={0}>
                <Svg source={meta.source} alt={meta.alt} width={meta.width} height={ROW} />
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
              {pr && pr.labels.length > 0 && (() => {
                const labels = labelsSvg(pr.labels)
                return (
                  <Box key={`labels-${row.branch}`} flexShrink={0}>
                    <Svg source={labels.source} alt={pr.labels.map(l => l.name).join(', ')} width={labels.width} height={ROW} />
                    {labels.hidden > 0 && (
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
                          const pill = pillSvg(label)
                          return <Svg source={pill.source} alt={label.name} width={pill.width} height={pill.height} />
                        })}
                      </Box>
                    )}
                  </Box>
                )
              })()}
              {diffChars > 0 && (() => {
                const stat = diffSvg(row.isTrunk ? undefined : row.diff, diffChars)
                return (
                  <Box flexShrink={0}>
                    <Svg source={stat.source} alt={stat.alt} width={stat.width} height={ROW} />
                  </Box>
                )
              })()}
            </Box>
          )
        })}
        {s.error && <Text color="warning">{s.error}</Text>}
      </Box>
    )
  })
}
