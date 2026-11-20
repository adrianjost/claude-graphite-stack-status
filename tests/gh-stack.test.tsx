import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('GitHub stacks', () => {
  const GH: World = { ...clone(STACK), kind: 'gh-stack' }

  test('are named GitHub stack and have no per-branch restack button', async ($, on) => {
    const world = clone(GH)
    world.branches[1]!.needsRestack = true
    const { draw, rec } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'gh-stack', tree)

    expect(rec.unknown).toEqual([])
    expect(text(kids0(tree))).toContain('GitHub stack')
    expect(labels(tree).some(l => l.includes('restack'))).toBe(false)
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('Sync with main runs gh stack sync, never gt', async ($, on) => {
    const { draw, rec } = await start($, on, clone(GH))
    const { ui } = await draw()
    rec.calls.length = 0
    await ui.press({ key: 'sync' })
    const ran = rec.calls.map(c => c.join(' '))
    expect(ran).toContain('gh stack sync')
    expect(ran.some(c => c.startsWith('gt '))).toBe(false)
    await ui.unmount()
  })

  test('a failing gh stack sync hands the conflict to Claude with rebase and push', async ($, on) => {
    const world = clone(GH)
    world.override = argv => (argv.join(' ') === 'gh stack sync' ? { exitCode: 1, stdout: '', stderr: 'rebase conflict on adrian/parents-gate' } : undefined)
    const { draw, eng } = await start($, on, world)
    const { ui } = await draw()
    await ui.press({ key: 'sync' })
    expect(eng.prompts.at(-1)).toContain('`gh stack rebase`')
    expect(eng.prompts.at(-1)).toContain('`gh stack push`')
    expect(eng.prompts.at(-1)).not.toContain("don't push")
    await ui.unmount()
  })
})
