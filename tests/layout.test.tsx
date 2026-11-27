import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, ownPart, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('band layout', () => {
  test('a Graphite stack with PRs: titles, PR meta, labels, diff counts and links all line up', async ($, on) => {
    const { draw, rec } = await start($, on, STACK)
    const { ui, tree } = await draw()
    emit('band', 'graphite-prs', tree)

    expect(rec.unknown).toEqual([])
    expect(alignmentProblems(tree)).toEqual([])
    expect(text(kids0(tree))).toContain('Code changes')
    expect(text(kids0(tree))).toContain('3 PRs · 1 failing')
    expect(stackRows(tree)).toHaveLength(4)
    // top of the stack first, trunk last
    expect(stackRows(tree).map(r => labels(r)[0])).toEqual([
      '✨ Ask the „Über die Eltern“ questions',
      '✨ Gate the parents chapter',
      '✨ Ask the shared story intro',
      'main',
    ])
    const gate = rowOf(tree, 'adrian/parents-gate')!
    expect(all(gate, n => n.type === 'Svg').map(n => String(n.props?.alt))).toContain('#31188, CI failing')
    expect(text(gate)).toContain('CI failing')
    // the failing check, the checks page (both in the CI hover), then the icon links
    expect(all(gate, n => n.type === 'Link').map(n => n.props?.label)).toEqual(['build', 'All checks on GitHub →', '📚', '🐙'])
    const intro = rowOf(tree, 'adrian/shared-story-intro')!
    expect(all(intro, n => n.type === 'Svg').map(n => String(n.props?.alt))).toContain('ready')
    await ui.unmount()
  })

  test('without any PR the PR columns collapse and every title still lines up with main', async ($, on) => {
    const world = clone(STACK)
    world.prs = {}
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-no-prs', tree)

    expect(alignmentProblems(tree)).toEqual([])
    for (const row of stackRows(tree)) expect(columns(row).meta).toBeUndefined()
    for (const row of stackRows(tree)) expect(columns(row).links).toBeUndefined()
    expect(text(kids0(tree))).toContain('0 PRs')
    await ui.unmount()
  })

  test('one PR keeps the PR columns on every row', async ($, on) => {
    const world = clone(STACK)
    world.prs = { 'adrian/parents-gate': { number: 7, title: '✨ Only one' } }
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-one-pr', tree)

    expect(alignmentProblems(tree)).toEqual([])
    for (const row of stackRows(tree)) expect(columns(row).meta).toBeDefined()
    await ui.unmount()
  })

  test('a branch with siblings draws a second lane and stays aligned', async ($, on) => {
    const world: World = {
      kind: 'graphite',
      current: 'review-demo-copy-feedback',
      branches: [
        { name: 'review-demo-clipboard', parent: 'main', added: 25, removed: 1 },
        { name: 'review-demo-date', parent: 'review-demo-clipboard', added: 3, removed: 0 },
        { name: 'review-demo-copy-feedback', parent: 'review-demo-clipboard', added: 45, removed: 3 },
      ],
    }
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-branches', tree)

    expect(alignmentProblems(tree)).toEqual([])
    expect(columns(stackRows(tree)[0]!).lane).toBe(28)
    await ui.unmount()
  })

  test('long titles and big diff counts keep the diff column one width', async ($, on) => {
    const world = clone(STACK)
    world.branches[0]!.added = 12345
    world.branches[0]!.removed = 6789
    world.prs!['adrian/parents-gate']!.title = `✨ ${'A very long pull request title that does not fit '.repeat(3)}`
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-long', tree)

    expect(alignmentProblems(tree)).toEqual([])
    expect(all(tree, n => n.type === 'Svg').map(n => String(n.props?.alt))).toContain('12345 lines added, 6789 removed')
    await ui.unmount()
  })

  test('another Graphite stack whose PR is linked to this session gets its own lane off main', async ($, on) => {
    const world = clone(STACK)
    world.branches.push({ name: 'adrian/side-fix', parent: 'main', added: 3, removed: 1 })
    world.prs!['adrian/side-fix'] = { number: 31200, title: '🐛 Fix the side thing' }
    world.bound = [{ number: 31200, repo: 'acme/app', state: 'open', head: 'adrian/side-fix' }]
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-two-stacks', tree)
    expect(stackRows(tree).map(r => String((r.children?.[0] as Node).props?.alt ?? ''))).toEqual([
      'adrian/parents-questions on adrian/parents-gate',
      'adrian/parents-gate on adrian/shared-story-intro',
      'adrian/shared-story-intro on main',
      'adrian/side-fix on main',
      'main',
    ])
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('a stack whose PR gets unlinked from the session leaves the band', async ($, on) => {
    const world = clone(STACK)
    world.branches.push({ name: 'adrian/side-fix', parent: 'main', added: 3, removed: 1 })
    world.prs!['adrian/side-fix'] = { number: 31200, title: '🐛 Fix the side thing' }
    world.bound = [{ number: 31200, repo: 'acme/app', state: 'open', head: 'adrian/side-fix' }]
    const { draw, idle, clock } = await start($, on, world)
    const alts = (tree: Node) => stackRows(tree).map(r => String((r.children?.[0] as Node).props?.alt ?? ''))
    const { ui, tree } = await draw()
    expect(alts(tree)).toContain('adrian/side-fix on main')
    world.bound = []
    await ui.press({ key: 'refresh' })
    await clock.advance(3_000)
    await idle()
    expect(alts((await draw()).tree)).not.toContain('adrian/side-fix on main')
    await ui.unmount()
  })

  test('+ adds a branch the session never checked out, and links its PR', async ($, on) => {
    const world = clone(STACK)
    world.branches.push({ name: 'adrian/side-fix', parent: 'main', added: 3, removed: 1 })
    world.prs!['adrian/side-fix'] = { number: 31200, title: '🐛 Fix the side thing' }
    let asked: { question?: string; options?: { label: string }[] } | undefined
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      asked = (e as unknown as { questions: typeof asked[] }).questions[0]
      return { result: { questions: [], answers: { [asked?.question ?? '']: 'adrian/side-fix' } } } as never
    })
    world.override = argv => {
      const cmd = argv.join(' ')
      if (cmd.startsWith('git for-each-ref')) return { exitCode: 0, stdout: 'adrian/parents-gate\nadrian/side-fix\nadrian/old-idea\n', stderr: '' }
      if (cmd.startsWith('gh pr list --head adrian/side-fix')) return { exitCode: 0, stdout: '[{"url":"https://github.com/acme/app/pull/31200"}]', stderr: '' }
      return undefined
    }
    const { draw, idle, rec, clock } = await start($, on, world)
    const { ui } = await draw()
    await ui.press({ key: 'add' })
    await clock.advance(3_000)
    await idle()
    expect(asked?.options?.map(o => o.label)).toEqual(['adrian/side-fix', 'adrian/old-idea'])
    expect(rec.mcp.filter(c => c.tool === 'bind_pr').map(c => c.args)).toContainEqual({ url: 'https://github.com/acme/app/pull/31200' })
    const tree = ownPart((await ui.drawn()) as unknown as Node)
    expect(stackRows(tree).map(r => String((r.children?.[0] as Node).props?.alt ?? ''))).toContain('adrian/side-fix on main')
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  // gt restack checks out other stacks for a moment; binding what the band showed then kept them for good
  test('the band never links the PRs it only shows', async ($, on) => {
    const { draw, idle, rec, clock } = await start($, on, STACK)
    const { ui } = await draw()
    await clock.advance(3_000)
    await idle()
    expect(rec.mcp.filter(c => c.tool === 'bind_pr')).toEqual([])
    await ui.unmount()
  })

  test('merged and closed PRs linked to the session are unlinked, once', async ($, on) => {
    const world = clone(STACK)
    world.bound = [
      { number: 1, repo: 'acme/app', state: 'merged' },
      { number: 2, repo: 'acme/app', state: 'closed' },
      { number: 3, repo: 'acme/app', state: 'open', head: 'adrian/parents-gate' },
    ]
    const { draw, idle, rec, clock } = await start($, on, world)
    const { ui } = await draw()
    await ui.press({ key: 'refresh' })
    await clock.advance(3_000)
    await idle()
    expect(rec.mcp.filter(c => c.tool === 'unbind_pr').map(c => c.args)).toEqual([
      { url: 'https://github.com/acme/app/pull/1' },
      { url: 'https://github.com/acme/app/pull/2' },
    ])
    await ui.unmount()
  })

  test('the header has review, sync, refresh and hide', async ($, on) => {
    const { draw } = await start($, on, STACK)
    const { ui, tree } = await draw()
    expect(labels(kids0(tree))).toEqual(['Review code', 'Sync with main', '+', '↻', '✕'])
    await ui.unmount()
  })
})
