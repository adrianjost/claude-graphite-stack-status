import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { emit } from './tree'
import { clone, STACK, start } from './setup'
import type { World } from './world'

type Row = { branch: string; isTrunk?: boolean; isCurrent?: boolean; push?: string; dirty?: boolean; needsRestack?: boolean; lane: string; pr?: { number: number; threads: unknown[] } }
type State = { source?: string; untracked?: boolean; current: string; trunk: string; rows: Row[]; replies: Record<string, { status?: string; text?: string }> }

// The review page's world: the stack with one unpushed branch, one rewritten, and uncommitted changes.
export const REVIEW_STACK = (): World => {
  const world = clone(STACK)
  world.dirty = true
  world.branches[0]!.unpushed = 'ahead'
  world.branches[2]!.needsRestack = true
  delete world.prs!['adrian/parents-questions']
  return world
}

async function open($: Engine, on: On, world: World) {
  const s = await start($, on, world, { review: true })
  await s.clock.advance(2_000)
  const last = () => s.rec.reviewStates.at(-1) as unknown as State
  // a page action, as the page posts it, answered on the plugin's next poll
  const act = async (action: Record<string, unknown>) => {
    const before = Object.keys(s.rec.actionResults).length
    s.rec.pageActions.push(action)
    await s.clock.advance(10_500)
    const results = Object.values(s.rec.actionResults) as { ok: boolean; message?: string }[]
    return results.slice(before)[0]
  }
  return { ...s, last, act }
}

describe('state sent to the review page', () => {
  test('a Graphite stack with PRs, threads, push and commit state', async ($, on) => {
    const { last, rec } = await open($, on, REVIEW_STACK())
    const state = last()
    emit('review', 'graphite', state)

    expect(rec.unknown).toEqual([])
    expect(state.source).toBe('graphite')
    expect(state.current).toBe('adrian/parents-gate')
    expect(state.trunk).toBe('main')
    expect(state.rows.map(r => r.branch)).toEqual(['adrian/parents-questions', 'adrian/parents-gate', 'adrian/shared-story-intro', 'main'])
    const row = (b: string) => state.rows.find(r => r.branch === b)!
    expect(row('adrian/shared-story-intro').push).toBe('ahead')
    expect(row('adrian/parents-gate').dirty).toBe(true)
    expect(row('adrian/parents-questions').needsRestack).toBe(true)
    expect(row('adrian/parents-gate').pr?.threads).toHaveLength(3)
    for (const r of state.rows) expect(r.lane).toStartWith('<svg')
  })

  test('a GitHub stack', async ($, on) => {
    const { last } = await open($, on, { ...REVIEW_STACK(), kind: 'gh-stack' })
    emit('review', 'gh-stack', last())
    expect(last().source).toBe('gh-stack')
  })

  test('plain git branches', async ($, on) => {
    const world: World = { kind: 'untracked', current: 'adrian/quick-fix', branches: [{ name: 'adrian/quick-fix', parent: 'main', added: 4, removed: 1 }] }
    const { last } = await open($, on, world)
    emit('review', 'untracked', last())
    expect(last().untracked).toBe(true)
  })

  test('changes after a Bash command reach the page', async ($, on) => {
    const world = REVIEW_STACK()
    const { last, clock } = await open($, on, world)
    world.branches[1]!.unpushed = 'ahead'
    await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })
    await clock.advance(16_000)
    expect(last().rows.find(r => r.branch === 'adrian/parents-gate')?.push).toBe('ahead')
  })
})

describe('page actions', () => {
  test('push hands Claude a push prompt for that branch', async ($, on) => {
    const { act, eng } = await open($, on, REVIEW_STACK())
    expect(await act({ type: 'push-branch', branch: 'adrian/shared-story-intro' })).toMatchObject({ ok: true })
    expect(eng.prompts.at(-1)).toContain('Push the local commits on `adrian/shared-story-intro`')
  })

  test('push on a branch with nothing to push is refused', async ($, on) => {
    const { act, eng } = await open($, on, REVIEW_STACK())
    const before = eng.prompts.length
    expect(await act({ type: 'push-branch', branch: 'adrian/parents-gate' })).toMatchObject({ ok: false, message: 'Nothing to do on that branch.' })
    expect(eng.prompts).toHaveLength(before)
  })

  test('commit hands Claude a commit prompt', async ($, on) => {
    const { act, eng } = await open($, on, REVIEW_STACK())
    expect(await act({ type: 'commit-branch', branch: 'adrian/parents-gate' })).toMatchObject({ ok: true })
    expect(eng.prompts.at(-1)).toContain('Commit my uncommitted changes on `adrian/parents-gate`')
  })

  for (const [kind, expected] of [
    ['graphite', '`gt submit` for that branch'],
    ['gh-stack', '`gh stack submit`'],
  ] as const) {
    test(`submit as draft on a ${kind} stack`, async ($, on) => {
      const { act, eng } = await open($, on, { ...REVIEW_STACK(), kind })
      expect(await act({ type: 'submit-branch', branch: 'adrian/parents-questions' })).toMatchObject({ ok: true })
      expect(eng.prompts.at(-1)).toContain(expected)
    })
  }

  test('open a draft PR for a plain git branch', async ($, on) => {
    const world: World = { kind: 'untracked', current: 'adrian/quick-fix', branches: [{ name: 'adrian/quick-fix', parent: 'main', added: 4, removed: 1 }] }
    const { act, eng } = await open($, on, world)
    expect(await act({ type: 'submit-branch', branch: 'adrian/quick-fix' })).toMatchObject({ ok: true })
    expect(eng.prompts.at(-1)).toContain('gh pr create --draft')
  })

  test('ready for review runs gh pr ready', async ($, on) => {
    const { act, rec } = await open($, on, REVIEW_STACK())
    expect(await act({ type: 'pr-ready', number: 31188, ready: true })).toMatchObject({ ok: true })
    expect(rec.calls.map(c => c.join(' '))).toContain('gh pr ready 31188')
    await act({ type: 'pr-ready', number: 31188, ready: false })
    expect(rec.calls.map(c => c.join(' '))).toContain('gh pr ready 31188 --undo')
  })

  test('a review becomes one prompt with refs, and Claude’s answer reaches the page', async ($, on) => {
    const { act, eng, last, clock } = await open($, on, REVIEW_STACK())
    await act({
      type: 'review',
      branch: 'adrian/parents-gate',
      summary: 'Looks good, two nits.',
      comments: [
        { id: 'a', path: 'src/feature.ts', line: 3, side: 'new', text: 'Rename this', code: 'const x = 1' },
        { id: 'b', path: 'src/feature.ts', start: 5, line: 7, side: 'old', text: 'Why was this removed?' },
      ],
    })
    const prompt = eng.prompts.at(-1) ?? ''
    expect(prompt).toContain('Review feedback on PR #31188 (stack layer 2/3)')
    expect(prompt).toContain('[c1] `src/feature.ts:3`: Rename this')
    expect(prompt).toContain('   > const x = 1')
    expect(prompt).toContain('[c2] `src/feature.ts:5-7` (removed lines): Why was this removed?')
    expect(prompt).toContain('mcp__graphite-stack__review_reply')

    await $.tool.call({ tool: 'mcp__graphite-stack__review_reply', fixed: ['c1'], replies: [{ ref: 'c2', text: 'It was unused.' }] } as never)
    await clock.advance(1_000)
    expect(last().replies).toMatchObject({ a: { status: 'fixed' }, b: { status: 'replied', text: 'It was unused.' } })
  })

  test('a GitHub thread sent from the page asks Claude to resolve it', async ($, on) => {
    const { act, eng } = await open($, on, REVIEW_STACK())
    await act({
      type: 'review',
      branch: 'adrian/parents-gate',
      comments: [{ kind: 'thread', thread: { id: 'T31188-0', url: 'https://github.com/acme/app/pull/31188#discussion_r0' }, path: 'src/feature.ts', line: 2, text: 'Could this be simpler? (1)' }],
    })
    expect(eng.prompts.at(-1)).toContain('thread id `T31188-0`')
    expect(eng.prompts.at(-1)).toContain('resolveReviewThread')
  })
})
