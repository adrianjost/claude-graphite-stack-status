import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('push and commit', () => {
  const pushWorld = (kind: World['kind']) => {
    const world = { ...clone(STACK), kind }
    world.branches[0]!.unpushed = 'ahead'
    world.branches[1]!.unpushed = 'rewritten'
    return world
  }

  test('unpushed branches get push buttons and the header a Push all button', async ($, on) => {
    const { draw } = await start($, on, pushWorld('graphite'))
    const { ui, tree } = await draw()
    emit('band', 'graphite-unpushed', tree)

    expect(labels(rowOf(tree, 'adrian/shared-story-intro')!)).toContain('↑ push')
    expect(labels(rowOf(tree, 'adrian/parents-gate')!)).toContain('⇅ force push')
    expect(labels(rowOf(tree, 'adrian/parents-questions')!).some(l => l.includes('push'))).toBe(false)
    expect(labels(kids0(tree))).toContain('Push ↑2')
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('a single unpushed branch has no Push all button', async ($, on) => {
    const world = clone(STACK)
    world.branches[0]!.unpushed = 'ahead'
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    expect(labels(kids0(tree)).some(l => l.startsWith('Push'))).toBe(false)
    await ui.unmount()
  })

  test('push asks Claude to push with gt submit --update-only on Graphite stacks', async ($, on) => {
    const { draw, eng } = await start($, on, pushWorld('graphite'))
    const { ui } = await draw()
    await ui.press({ key: 'push-adrian/shared-story-intro' })
    expect(eng.prompts.at(-1)).toContain('`adrian/shared-story-intro`')
    expect(eng.prompts.at(-1)).toContain('gt submit --update-only --no-edit')
    await ui.press({ key: 'push-all' })
    expect(eng.prompts.at(-1)).toContain('`adrian/parents-gate`, `adrian/shared-story-intro`')
    await ui.unmount()
  })

  test('push asks Claude to use gh stack push on GitHub stacks', async ($, on) => {
    const { draw, eng } = await start($, on, pushWorld('gh-stack'))
    const { ui } = await draw()
    await ui.press({ key: 'push-adrian/parents-gate' })
    expect(eng.prompts.at(-1)).toContain('`gh stack push`')
    await ui.unmount()
  })

  test('a merged or closed PR never offers a push', async ($, on) => {
    const world = pushWorld('graphite')
    world.prs!['adrian/shared-story-intro']!.state = 'MERGED'
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    expect(labels(rowOf(tree, 'adrian/shared-story-intro')!).some(l => l.includes('push'))).toBe(false)
    await ui.unmount()
  })

  test('uncommitted changes on the checked-out branch get a commit button', async ($, on) => {
    const world = { ...clone(STACK), dirty: true }
    const { draw, eng } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-dirty', tree)

    expect(labels(rowOf(tree, 'adrian/parents-gate')!)).toContain('+ commit')
    expect(all(tree, n => n.type === 'Button' && n.props?.label === '+ commit')).toHaveLength(1)
    expect(alignmentProblems(tree)).toEqual([])
    await ui.press({ key: 'commit-adrian/parents-gate' })
    expect(eng.prompts.at(-1)).toContain('Commit my uncommitted changes on `adrian/parents-gate`')
    expect(eng.prompts.at(-1)).toContain('gt modify')
    await ui.unmount()
  })
})
