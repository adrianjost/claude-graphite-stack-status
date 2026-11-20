declare const console: { log: (...data: unknown[]) => void }

// Helpers to read a drawn tree as plain data: { type, props, children }.

export type Node = { type: string; props?: Record<string, unknown>; children?: (Node | string)[]; part?: { plugin: string } }

export const kids = (node: Node) => (node.children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null)

export function walk(node: Node, visit: (n: Node) => void) {
  visit(node)
  for (const child of kids(node)) walk(child, visit)
}

export function all(node: Node, match: (n: Node) => boolean) {
  const found: Node[] = []
  walk(node, n => {
    if (match(n)) found.push(n)
  })
  return found
}

export const labels = (node: Node, type = 'Button') => all(node, n => n.type === type).map(n => String(n.props?.label ?? text(n)))

export function text(node: Node | string): string {
  if (typeof node === 'string') return node
  return [String(node.props?.label ?? ''), ...(node.children ?? []).map(text)].join('')
}

// The band's stack rows: the row Boxes that start with the lane graph.
export function stackRows(tree: Node) {
  return kids(tree).filter(n => n.type === 'Box' && kids(n)[0]?.type === 'Svg')
}

const svgWidth = (n?: Node) => (n?.type === 'Svg' ? Number(n.props?.width) : undefined)

// What sits in each column of a stack row, as widths and kinds, so rows can be compared.
export function columns(row: Node) {
  const [lane, ...rest] = kids(row)
  const title = rest.find(n => n.props?.flexGrow === 1)
  const meta = rest.find(n => kids(n).some(k => String(k.props?.key ?? '').startsWith('meta-')))
  const diff = rest.find(n => String(n.props?.key ?? '').startsWith('diff-')) ?? rest.find(n => n.type === 'Svg')
  const links = rest.find(n => String(n.props?.key ?? '').startsWith('links-'))
  return {
    lane: svgWidth(lane),
    meta: meta ? kids(meta).map(k => svgWidth(kids(k)[0])) : undefined,
    titleKinds: title ? kids(title).map(k => `${k.type}${k.props?.plain ? ':plain' : ''}`) : [],
    diff: diff ? (svgWidth(diff) ?? svgWidth(kids(diff)[0])) : undefined,
    links: links ? links.props?.width : undefined,
    order: rest.map(n => (n === title ? 'title' : n === meta ? 'meta' : n === diff ? 'diff' : n === links ? 'links' : n.type)),
  }
}

// Everything that must line up between rows: the same column widths and the same title element.
export function alignmentProblems(tree: Node) {
  const rows = stackRows(tree).map(columns)
  const problems: string[] = []
  const same = (name: string, pick: (c: ReturnType<typeof columns>) => unknown) => {
    const values = rows.map(c => JSON.stringify(pick(c)))
    if (new Set(values).size > 1) problems.push(`${name} differs between rows: ${values.join(' | ')}`)
  }
  same('lane width', c => c.lane)
  same('meta columns', c => c.meta)
  same('title element', c => c.titleKinds)
  same('diff width', c => c.diff)
  same('links width', c => c.links)
  for (const c of rows) if (c.titleKinds.length !== 1 || c.titleKinds[0] !== 'Button:plain') problems.push(`title is ${c.titleKinds.join(',')}`)
  return problems
}

// Hands a drawn band or a review-page state to scripts/test.mjs, which renders and screenshots it.
export function emit(kind: 'band' | 'review', name: string, data: unknown) {
  console.log(`@@${kind} ${name} ${JSON.stringify(data)}`)
}

// Newer Claude Code draws the band as parts, one per plugin plus the engine's own: keep the plugin's part.
export function ownPart(tree: Node, plugin = 'graphite-stack') {
  const parts = all(tree, n => !!n.part)
  if (!parts.length) return tree
  return parts.find(p => p.part?.plugin === plugin) ?? parts[0]!
}
