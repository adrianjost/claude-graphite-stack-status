import type { On } from 'claude-code'

// A fake repository and GitHub: every git, gt, gh and sqlite3 call the plugin makes is answered from here.
// An argv nothing here knows is recorded in `unknown` and fails with exit 127, so a test can assert it stays empty.

export type FakeBranch = {
  name: string
  parent: string
  added?: number
  removed?: number
  files?: string[]
  needsRestack?: boolean
  // local commits that are not on the PR yet: new ones on top, or a rewritten history
  unpushed?: 'ahead' | 'rewritten'
  // what GitHub has for the branch, when it isn't `sha-<branch>`: after a push, the local `new-<branch>`
  remoteHead?: string
}

export type FakePr = {
  number: number
  title: string
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft?: boolean
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviewers?: string[]
  approvedBy?: string[]
  labels?: { name: string; color: string; description?: string }[]
  ci?: 'pass' | 'fail' | 'pending' | 'none'
  openThreads?: number
}

export type World = {
  kind: 'graphite' | 'gh-stack' | 'untracked'
  trunk?: string
  current: string
  branches: FakeBranch[]
  dirty?: boolean
  prs?: Record<string, FakePr>
  githubDown?: boolean
  // answers one call differently: a result, or 'missing' for a tool that can't start
  // what the app's get_status reports as already linked to the session
  bound?: { number: number; repo: string; state: string; head?: string }[]
  override?: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } | 'missing' | undefined
}

export const CWD = '/repo'
const GIT_DIR = `${CWD}/.git`

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = (stderr = '', exitCode = 1) => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })
// GitHub has `sha-<branch>`; a branch with unpushed commits is at `new-<branch>` locally.
const sha = (name: string) => `sha-${name}`
const prHead = (b: FakeBranch) => b.remoteHead ?? sha(b.name)

function prNode(world: World, branch: string) {
  const pr = world.prs?.[branch]
  if (!pr) return []
  const b = world.branches.find(x => x.name === branch)
  const ci = pr.ci ?? 'pass'
  const checks =
    ci === 'none'
      ? []
      : [
          { __typename: 'CheckRun', name: 'build', status: ci === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: ci === 'fail' ? 'FAILURE' : ci === 'pass' ? 'SUCCESS' : null, detailsUrl: 'https://example.test/build', startedAt: '2026-01-01T00:00:00Z', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.test/lint', startedAt: '2026-01-01T00:00:00Z', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
        ]
  const threads = threadNodes(pr)
  return [
    {
      number: pr.number,
      title: pr.title,
      url: `https://github.com/acme/app/pull/${pr.number}`,
      state: pr.state ?? 'OPEN',
      isDraft: pr.isDraft ?? false,
      headRefOid: b ? prHead(b) : sha(branch),
      reviewDecision: pr.reviewDecision ?? null,
      bodyHTML: `<p>${pr.title}</p>`,
      labels: { nodes: (pr.labels ?? []).map(l => ({ ...l, description: l.description ?? null })) },
      reviewRequests: { totalCount: (pr.reviewers ?? []).length, nodes: (pr.reviewers ?? []).map(login => ({ requestedReviewer: { login } })) },
      latestReviews: { totalCount: (pr.approvedBy ?? []).length, nodes: (pr.approvedBy ?? []).map(login => ({ state: 'APPROVED', author: { login } })) },
      reviewThreads: { nodes: threads },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
    },
  ]
}

// Open review threads on a PR, each one comment by albert on src/feature.ts.
function threadNodes(pr?: FakePr) {
  return Array.from({ length: pr?.openThreads ?? 0 }, (_, i) => ({
    id: `T${pr!.number}-${i}`,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    path: 'src/feature.ts',
    line: 2 + i,
    startLine: null,
    originalLine: 2 + i,
    subjectType: 'LINE',
    diffSide: 'RIGHT',
    comments: {
      totalCount: 1,
      nodes: [
        {
          id: `C${pr!.number}-${i}`,
          updatedAt: '2026-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          url: `https://github.com/acme/app/pull/${pr!.number}#discussion_r${i}`,
          body: `Could this be simpler? (${i + 1})`,
          bodyHTML: `<p>Could this be simpler? (${i + 1})</p>`,
          author: { login: 'albert', avatarUrl: '' },
        },
      ],
    },
  }))
}

function graphql(world: World, query: string) {
  const repository: Record<string, unknown> = {}
  for (const m of query.matchAll(/b(\d+):pullRequests\(headRefName:("(?:[^"\\]|\\.)*")/g)) {
    repository[`b${m[1]}`] = { nodes: prNode(world, JSON.parse(m[2] ?? '""') as string) }
  }
  for (const m of query.matchAll(/p(\d+):pullRequest\(number:(\d+)\)/g)) {
    const number = Number(m[2])
    const [branch, pr] = Object.entries(world.prs ?? {}).find(([, p]) => p.number === number) ?? []
    repository[`p${m[1]}`] = { reviewThreads: { nodes: threadNodes(pr) }, headRefName: branch ?? '' }
  }
  return ok(JSON.stringify({ data: { repository } }))
}

function metadata(world: World) {
  const trunk = world.trunk ?? 'main'
  return [
    { branch_name: trunk, parent_branch_name: null, children: JSON.stringify(world.branches.filter(b => b.parent === trunk).map(b => b.name)), validation_result: 'TRUNK' },
    ...world.branches.map(b => ({
      branch_name: b.name,
      parent_branch_name: b.parent,
      children: JSON.stringify(world.branches.filter(c => c.parent === b.name).map(c => c.name)),
      validation_result: 'VALID',
    })),
  ]
}

export function answer(world: World, argv: readonly string[]) {
  const trunk = world.trunk ?? 'main'
  const [cmd, ...rest] = argv
  const args = rest.join(' ')
  const branch = (name?: string) => world.branches.find(b => b.name === name)
  const numstat = (b?: FakeBranch) =>
    b && (b.added || b.removed)
      ? (b.files ?? ['src/feature.ts']).map((file, i, all) => `${i ? 0 : b.added ?? 0}\t${i ? 0 : b.removed ?? 0}\t${file}${all.length > 1 && i ? '' : ''}`).join('\n')
      : ''

  if (cmd === 'uname') return ok('Darwin\n')
  if (cmd === 'sh') return ok('updated')
  if (cmd === 'open' || cmd === 'xdg-open') return ok()
  if (cmd === 'test') return world.kind === 'graphite' && rest[1] === `${GIT_DIR}/.graphite_metadata.db` ? ok() : fail()
  if (cmd === 'sqlite3') return ok(JSON.stringify(metadata(world)))
  if (cmd === 'cat') {
    if (rest[0] === `${GIT_DIR}/gh-stack` && world.kind === 'gh-stack') {
      return ok(JSON.stringify({ stacks: [{ trunk: { branch: trunk }, branches: world.branches.map(b => ({ branch: b.name, base: b.parent })) }] }))
    }
    return fail('No such file')
  }
  if (cmd === 'gt') return args === '--version' ? ok('1.7.0') : ok()
  if (cmd === 'gh') {
    if (rest[0] === 'api' && rest[1] === 'graphql') {
      if (world.githubDown) return fail('error connecting to api.github.com')
      return graphql(world, rest.find(a => a.startsWith('query='))?.slice(6) ?? '')
    }
    if (rest[0] === 'api') return fail('not found', 1)
    return ok()
  }
  if (cmd !== 'git') return fail(`${cmd}: not found`, 127)

  if (args === 'branch --show-current') return ok(`${world.current}\n`)
  if (args === 'rev-parse --path-format=absolute --git-common-dir') return ok(`${GIT_DIR}\n`)
  if (args.startsWith('for-each-ref refs/branch-metadata')) return ok()
  if (args === 'remote get-url origin') return ok('git@github.com:acme/app.git\n')
  if (args === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok(`origin/${trunk}\n`)
  if (args.startsWith('status --porcelain')) return ok(world.dirty ? ' M src/feature.ts\n' : '')
  if (args === 'ls-files --others --exclude-standard -z') return ok()
  if (rest[0] === 'rev-parse' && rest[1] === '--verify') {
    const ref = (rest[3] ?? '').replace(/^refs\/heads\//, '').replace(/\^\{commit\}$/, '')
    return ref === trunk || branch(ref) ? ok(`${sha(ref)}\n`) : fail()
  }
  if (rest[0] === 'rev-parse' && rest.length === 2) {
    const b = branch(rest[1])
    if (b) return ok(`${b.unpushed ? `new-${b.name}` : sha(b.name)}\n`)
    return rest[1] === trunk ? ok(`${sha(trunk)}\n`) : fail()
  }
  if (rest[0] === 'cat-file') return ok()
  if (rest[0] === 'merge-base' && rest[1] === '--is-ancestor') {
    const [a = '', b = ''] = rest.slice(2)
    const child = branch(b)
    if (child && child.parent === a) return child.needsRestack ? fail() : ok()
    const pushed = world.branches.find(x => a === prHead(x))
    if (pushed?.unpushed === 'ahead' && b === `new-${pushed.name}`) return ok()
    return fail()
  }
  if (rest[0] === 'merge-base') return ok(`${sha(`base-${rest[1]}-${rest[2]}`)}\n`)
  if (rest[0] === 'rev-list' && rest[1] === '--count') {
    const name = rest[2]?.split('..')[1]
    return ok(branch(name) ? '1\n' : '0\n')
  }
  if (rest[0] === 'diff' && rest[2] === '--numstat') {
    const range = rest[3] ?? ''
    if (range.includes('...')) return ok(numstat(branch(range.split('...')[1])))
    return ok(numstat(branch(world.current)))
  }
  return fail(`unknown git call: ${args}`, 127)
}

export type Recorder = {
  calls: string[][]
  unknown: string[][]
  graphql: number
  reviewStates: Record<string, unknown>[]
  // actions the review page sends, handed to the plugin on its next poll
  pageActions: Record<string, unknown>[]
  actionResults: Record<string, unknown>
  // calls to the desktop app's tools ($.mcp.call), e.g. ccd_pr bind_pr
  mcp: { server: string; tool: string; args: Record<string, unknown> }[]
}

// Wires the fake world beneath the plugin. Returns a recorder of every call.
export function useWorld(on: On, world: () => World, options: { review?: boolean; release?: string; sleep?: (ms: number) => Promise<void> } = {}): Recorder {
  const rec: Recorder = { calls: [], unknown: [], graphql: 0, reviewStates: [], pageActions: [], actionResults: {}, mcp: [] }
  let actionId = 0
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    rec.calls.push(argv)
    if (argv[0] === 'gh' && argv.includes('graphql')) rec.graphql++
    const special = world().override?.(argv)
    if (special === 'missing') throw new Error(`spawn ${argv[0]} ENOENT`)
    const result = special ? { ...special, isStdoutTruncated: false, isStderrTruncated: false } : answer(world(), argv)
    if (result.exitCode === 127) rec.unknown.push(argv)
    return { value: result }
  })
  // The review page's Node server: a fake that takes the state the plugin pushes and hands out page actions.
  on('process.spawn', async function* () {
    if (!options.review) {
      yield { stream: 'stderr' as const, text: 'no review server in this test' }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout' as const, text: `TOKEN ${'a'.repeat(64)}\nPORT 4321\n` }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const respond = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (url.hostname === 'api.github.com' && options.release) {
      return respond({ tag_name: `v${options.release}`, html_url: `https://github.com/adrianjost/claude-graphite-stack-status/releases/tag/v${options.release}` })
    }
    if (!options.review || url.hostname !== '127.0.0.1') return { deny: 'no network in tests' }
    if (url.pathname === '/state' && e.init?.method === 'POST') {
      rec.reviewStates.push(JSON.parse(String(e.init.body)) as Record<string, unknown>)
      return respond({ version: rec.reviewStates.length })
    }
    if (url.pathname === '/actions' && e.init?.method === 'POST') {
      Object.assign(rec.actionResults, (JSON.parse(String(e.init.body)) as { results: Record<string, unknown> }).results)
      return respond({ ok: true })
    }
    if (url.pathname === '/actions') {
      // long-polls like the real server, on the test's clock
      if (!rec.pageActions.length) await options.sleep?.(10_000)
      return respond(rec.pageActions.splice(0).map(a => ({ id: ++actionId, ...a })))
    }
    return { deny: `unexpected review call ${url.pathname}` }
  })
  const binds = new Map<number, NonNullable<World['bound']>[number] | undefined>()
  on('mcp.call', (_, e) => {
    rec.mcp.push({ server: e.server, tool: e.tool, args: e.args })
    const w = world()
    // binds made during the test, kept apart from the shared fixtures
    const number = Number(/\/pull\/(\d+)/.exec(String((e.args as { url?: string })?.url))?.[1])
    if (e.tool === 'bind_pr' && number) {
      const head = Object.entries(w.prs ?? {}).find(([, pr]) => pr.number === number)?.[0]
      binds.set(number, { number, repo: 'acme/app', state: 'open', head })
    }
    if (e.tool === 'unbind_pr' && number) binds.set(number, undefined)
    const listed = [...(w.bound ?? []).filter(pr => !binds.has(pr.number)), ...[...binds.values()].filter(pr => !!pr)]
    const bound = w.bound || binds.size ? listed : undefined
    if (e.tool === 'get_status' && bound) return { value: { content: [{ type: 'text', text: JSON.stringify({ otherBoundPrs: bound }) }] } } as never
    return { value: { isError: true, content: [] } }
  })
  on('fs.read', (_, e) => (e.path.endsWith('plugin.json') ? { value: JSON.stringify({ version: '3.0.0' }) } : { deny: 'no files in tests' }))
  return rec
}

export type EngineRecorder = { prompts: string[]; toasts: string[]; logs: string[] }

// The engine calls the plugin makes besides processes: each answered and recorded.
export function useEngine(on: On): EngineRecorder {
  const rec: EngineRecorder = { prompts: [], toasts: [], logs: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: { command: 'stack' } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.log', (_, e) => {
    rec.logs.push(String(e.text))
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    rec.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    rec.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return rec
}
