import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('Graphite actions', () => {
  test('a branch that needs a restack shows a restack button that runs gt sync and gt restack', async ($, on) => {
    const world = clone(STACK)
    world.branches[1]!.needsRestack = true
    const { draw, rec, eng } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'graphite-restack', tree)

    expect(labels(rowOf(tree, 'adrian/parents-gate')!)).toContain('↻ restack')
    expect(alignmentProblems(tree)).toEqual([])
    rec.calls.length = 0
    await ui.press({ key: 'restack-adrian/parents-gate' })
    const ran = rec.calls.map(c => c.join(' '))
    expect(ran).toContain('gt sync --force --no-interactive')
    expect(ran).toContain('gt restack --no-interactive --branch adrian/parents-gate')
    expect(eng.toasts).toContain('Restacked adrian/parents-gate')
    await ui.unmount()
  })

  test('uncommitted changes make sync hand off to Claude instead of running gt', async ($, on) => {
    const world = { ...clone(STACK), dirty: true }
    const { draw, rec, eng } = await start($, on, world)
    const { ui } = await draw()
    rec.calls.length = 0
    await ui.press({ key: 'sync' })
    expect(rec.calls.some(c => c[0] === 'gt')).toBe(false)
    expect(eng.prompts.at(-1)).toContain('uncommitted changes')
    await ui.unmount()
  })
})
