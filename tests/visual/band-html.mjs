// Turns a band tree the plugin drew (Box, Text, Button, Link, Svg) into HTML close to how the desktop app paints it:
// flex boxes with one unit = 8px, plain buttons with the desktop's native padding, SVGs as images.
// shortcut: an approximation of the desktop app's paint, not its real CSS; good for catching layout changes between runs.

const UNIT = 8
const COLORS = { warning: 'var(--warning)', error: 'var(--error)', suggestion: 'var(--accent)', success: 'var(--success)' }

const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const px = value => (typeof value === 'number' ? `${value * UNIT}px` : value)

function boxStyle(p) {
  const s = [`display:${p.display === 'none' ? 'none' : 'flex'}`, `flex-direction:${p.flexDirection ?? 'row'}`]
  if (p.alignItems) s.push(`align-items:${p.alignItems}`)
  if (p.justifyContent) s.push(`justify-content:${p.justifyContent}`)
  if (p.gap !== undefined) s.push(`gap:${px(p.gap)}`)
  if (p.flexGrow !== undefined) s.push(`flex-grow:${p.flexGrow}`)
  if (p.flexShrink !== undefined) s.push(`flex-shrink:${p.flexShrink}`)
  if (p.minWidth !== undefined) s.push(`min-width:${px(p.minWidth)}`)
  if (p.width !== undefined) s.push(`width:${px(p.width)}`)
  if (p.overflow) s.push(`overflow:${p.overflow}`)
  if (p.marginBottom !== undefined) s.push(`margin-bottom:${px(p.marginBottom)}`)
  if (p.paddingX !== undefined) s.push(`padding-left:${px(p.paddingX)};padding-right:${px(p.paddingX)}`)
  if (p.position === 'absolute') s.push('position:absolute')
  return s.join(';')
}

function textStyle(p) {
  const s = []
  if (p.bold) s.push('font-weight:600')
  if (p.italic) s.push('font-style:italic')
  if (p.dimColor) s.push('color:var(--dim)')
  if (p.color) s.push(`color:${COLORS[p.color] ?? p.color}`)
  if (p.wrap?.startsWith('truncate')) s.push('white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0')
  return s.join(';')
}

function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  const p = node.props ?? {}
  const inner = (node.children ?? []).map(render).join('')
  switch (node.type) {
    case 'Box':
      return `<div style="${boxStyle(p)}">${inner}</div>`
    case 'Text':
      return `<span style="${textStyle(p)}">${inner}</span>`
    case 'Button':
      return `<button class="${p.plain ? 'plain' : 'native'}${p.dimColor ? ' dim' : ''}">${esc(p.label ?? '')}${inner}</button>`
    case 'Link':
      return `<a href="#">${esc(p.label ?? p.href)}</a>`
    case 'Svg':
      return `<img alt="${esc(p.alt ?? '')}" width="${p.width}" height="${p.height}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.source)}">`
    default:
      return `<span data-unknown="${esc(node.type)}">${inner}</span>`
  }
}

export function bandHtml(tree) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --bg: #f3f3f3; --fg: #1f1f1f; --dim: #6e6e6e; --accent: #c96442; --warning: #b35900; --error: #cf222e; --success: #2da44e; }
@media (prefers-color-scheme: dark) { :root { --bg: #2a2a28; --fg: #ececec; --dim: #9a9a96; } }
body { margin: 0; padding: 16px; background: #fff; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #1f1f1e; } }
#band { width: 760px; padding: 12px 16px; border-radius: 12px; background: var(--bg); color: var(--fg); }
button { font: inherit; color: inherit; border: 0; cursor: pointer; white-space: nowrap; }
button.plain { background: none; padding: 2px 8px; border-radius: 6px; }
button.native { background: #fff; border: 1px solid #ccc; padding: 2px 10px; border-radius: 6px; }
button.dim { color: var(--dim); }
a { color: inherit; text-decoration: none; }
img { display: block; }
</style></head><body><div id="band">${render(tree)}</div></body></html>`
}
