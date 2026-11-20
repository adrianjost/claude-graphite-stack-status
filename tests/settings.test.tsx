import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('settings', () => {
  const testsOnly = () => {
    const world = clone(STACK)
    world.branches[0]!.files = ['src/story.test.ts']
    return world
  }
  const introStat = (tree: Node) => all(rowOf(tree, 'adrian/shared-story-intro')!, n => n.type === 'Svg').map(n => String(n.props?.alt))

  test('test files count by default', async ($, on) => {
    const { draw } = await start($, on, testsOnly())
    const { ui, tree } = await draw()
    expect(introStat(tree)).toContain('13 lines added, 15 removed')
    await ui.unmount()
  })

  test('excludeTests leaves test files out of the line counts', { options: { excludeTests: true } }, async ($, on) => {
    const { draw } = await start($, on, testsOnly())
    const { ui, tree } = await draw()
    expect(introStat(tree).some(alt => alt.includes('lines added'))).toBe(false)
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('a GitHub Enterprise host is passed to gh api', { options: { githubHost: 'github.acme.test' } }, async ($, on) => {
    const world = clone(STACK)
    world.override = argv => (argv.join(' ') === 'git remote get-url origin' ? { exitCode: 0, stdout: 'git@github.acme.test:acme/app.git\n', stderr: '' } : undefined)
    const { rec } = await start($, on, world)
    const graphql = rec.calls.filter(c => c[0] === 'gh' && c.includes('graphql'))
    expect(graphql.length).toBeGreaterThan(0)
    for (const call of graphql) expect(call.slice(0, 4)).toEqual(['gh', 'api', '--hostname', 'github.acme.test'])
  })

  test('showGraphite and showGithub off remove the icon links', { options: { showGraphite: false, showGithub: false } }, async ($, on) => {
    const { draw } = await start($, on, clone(STACK))
    const { ui, tree } = await draw()
    expect(all(tree, n => n.type === 'Link' && (n.props?.label === '📚' || n.props?.label === '🐙'))).toHaveLength(0)
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })
  test('with only GitHub links on, the links column holds one icon', { options: { showGraphite: false } }, async ($, on) => {
    const { draw } = await start($, on, clone(STACK))
    const { ui, tree } = await draw()
    emit('band', 'github-links-only', tree)
    const boxes = all(tree, n => n.type === 'Box' && String(n.props?.key ?? '').startsWith('links-'))
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) expect(box.props?.width).toBe(3)
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })
})
