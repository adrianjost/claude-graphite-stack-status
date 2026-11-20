import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { all, ownPart, stackRows, text, type Node } from './tree'
import { CWD, useEngine, useWorld, type World } from './world'

export const BAND = { plugin: 'graphite-stack', component: 'AbovePrompt', surface: 'desktop' } as const
export const PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40 } as never

// A stack of three with every kind of PR state the band draws.
export const STACK: World = {
  kind: 'graphite',
  current: 'adrian/parents-gate',
  branches: [
    { name: 'adrian/shared-story-intro', parent: 'main', added: 13, removed: 15 },
    { name: 'adrian/parents-gate', parent: 'adrian/shared-story-intro', added: 366, removed: 16 },
    { name: 'adrian/parents-questions', parent: 'adrian/parents-gate', added: 250, removed: 26 },
  ],
  prs: {
    'adrian/shared-story-intro': {
      number: 31182,
      title: '✨ Ask the shared story intro',
      reviewDecision: 'APPROVED',
      approvedBy: ['finn'],
      labels: [{ name: 'ready', color: '0e8a16', description: 'Ready to merge' }],
    },
    'adrian/parents-gate': {
      number: 31188,
      title: '✨ Gate the parents chapter',
      ci: 'fail',
      openThreads: 3,
      reviewers: ['albert'],
    },
    'adrian/parents-questions': { number: 31201, title: '✨ Ask the „Über die Eltern“ questions', isDraft: true, ci: 'pending' },
  },
}

export type Options = { review?: boolean; release?: string; store?: Record<string, unknown> }

export async function start($: Engine, on: On, world: World, opts: Options = {}) {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const rec = useWorld(on, () => world, { ...opts, sleep: ms => clock.sleep(ms) })
  const eng = useEngine(on)
  mock.store(on, opts.store)
  on('tool.call', () => ({ result: {} }))
  // Waits until the plugin went quiet: no new git or gh call for a few rounds, the mocked clock moving on in small steps.
  const idle = async (step = 200) => {
    for (let quiet = 0, round = 0; quiet < 3 && round < 200; round++) {
      const before = rec.calls.length
      await clock.advance(step)
      quiet = rec.calls.length === before ? quiet + 1 : 0
    }
  }
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  await idle()
  const draw = async () => {
    const mounted = await $.ui.mount({ ...BAND, props: PROPS })
    // Lets background work (review server retries, queued refreshes) finish before the plugin unloads.
    const drawn = async () => ownPart((await mounted.drawn()) as unknown as Node)
    const ui = { ...mounted, drawn, unmount: async () => (await clock.advance(5_000), mounted.unmount()) }
    const tree = await drawn()
    return { ui, tree }
  }
  return { rec, eng, clock, draw, idle }
}

// One stack row by its branch: the row whose lane graph is labelled with it.
export const rowOf = (tree: Node, branch: string) =>
  stackRows(tree).find(r => {
    const alt = String((r.children?.[0] as Node).props?.alt ?? '')
    return alt === branch || alt.startsWith(`${branch} on `)
  })

export const clone = (world: World): World => JSON.parse(JSON.stringify(world)) as World


export function kids0(tree: Node): Node {
  // the header row: the first row Box that holds the stack's name
  return all(tree, n => n.type === 'Box' && (n.children ?? []).some(c => typeof c === 'object' && c.type === 'Text' && /stack$/.test(text(c))))[0]!
}
