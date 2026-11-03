const token = new URLSearchParams(location.search).get('t') ?? ''
const $ = selector => document.querySelector(selector)
const esc = text =>
  String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const ICONS = {
  chevron: '<svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M12.78 5.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 0 1 1.06-1.06L8 8.94l3.72-3.72a.75.75 0 0 1 1.06 0Z"/></svg>',
  unfold: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="m8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z"/></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.177 14.323a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 11H7.25V7.75a.75.75 0 0 1 1.5 0V11h2.146a.25.25 0 0 1 .177.427ZM2.25 5a.75.75 0 0 1 0-1.5h11.5a.75.75 0 0 1 0 1.5Z"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>',
  up: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L9 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z"/></svg>',
  downArrow: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.03 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.47 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l2.97 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.97-2.97a.75.75 0 0 1 1.06 0Z"/></svg>',
}

const LANGUAGES = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  vue: 'xml', svelte: 'xml', html: 'xml', svg: 'xml', xml: 'xml',
  json: 'json', css: 'css', scss: 'scss', less: 'less', md: 'markdown', yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', go: 'go', rs: 'rust', rb: 'ruby',
  java: 'java', kt: 'kotlin', swift: 'swift', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  php: 'php', c: 'c', h: 'c', cpp: 'cpp', toml: 'ini', ini: 'ini',
}

const stored = (key, fallback) => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
const store = (key, value) => {
  try {
    if (value === undefined || value === false) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const prefs = {
  format: stored('format', 'unified'),
  whitespace: stored('whitespace', false),
  compare: stored('compare', 'parent'),
  uncommitted: { true: 'all', false: 'committed' }[stored('uncommitted', 'all')] ?? stored('uncommitted', 'all'),
}
if (prefs.format !== 'unified' && prefs.format !== 'split') prefs.format = 'unified'

let state = { version: -1, rows: [] }
let selected = decodeURIComponent(location.hash.replace(/^#branch=/, '')) || ''
let lastFocus = null
let current = null
let renderedKey = ''
let files = []
let comments = []
let composer = null
let shownHeavy = new Set()
let collapsed = new Set()
let expansions = new Map()
let pending = new Map()

const api = (path, init) =>
  fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, init).then(res => {
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  })

const stackRows = () => state.rows.filter(row => !row.isTrunk)
const selectedRow = () => state.rows.find(row => row.branch === selected)
const viewedKey = file => `viewed:${selected}:${file.path}:${file.hash}`
const isViewed = file => stored(viewedKey(file), false)
const cardOf = path => [...document.querySelectorAll('.file')].find(card => card.dataset.file === path)

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function select(branch) {
  if (!branch || branch === selected) return
  selected = branch
  history.replaceState(null, '', `${location.search}#branch=${encodeURIComponent(branch)}`)
  shownHeavy = new Set()
  collapsed = new Set()
  expansions = new Map()
  composer = null
  comments = stored(`comments:${branch}`, [])
  renderStack()
  loadDiff(true)
  window.scrollTo(0, 0)
}

/* parsing */

function parseFiles(diff) {
  const generated = state.generated ? new RegExp(state.generated) : null
  return diff
    .split(/^(?=diff --git )/m)
    .filter(chunk => chunk.startsWith('diff --git '))
    .map(chunk => {
      const lines = chunk.replace(/\n$/, '').split('\n')
      const head = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0]) ?? []
      const file = { oldPath: head[1], newPath: head[2], status: 'modified', binary: false, hunks: [], added: 0, removed: 0 }
      let i = 1
      for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
        const line = lines[i]
        if (line.startsWith('new file mode')) file.status = 'added'
        else if (line.startsWith('deleted file mode')) file.status = 'deleted'
        else if (line.startsWith('rename from ')) {
          file.oldPath = line.slice(12)
          file.status = 'renamed'
        } else if (line.startsWith('rename to ')) file.newPath = line.slice(10)
        else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true
        else if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = line.slice(4).replace(/^a\//, '')
        else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.newPath = line.slice(4).replace(/^b\//, '')
      }
      let hunk
      for (; i < lines.length; i++) {
        const line = lines[i]
        const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
        if (h) {
          hunk = {
            oldStart: +h[1],
            oldLines: h[2] === undefined ? 1 : +h[2],
            newStart: +h[3],
            newLines: h[4] === undefined ? 1 : +h[4],
            heading: h[5],
            lines: [],
          }
          file.hunks.push(hunk)
          continue
        }
        if (!hunk || line.startsWith('\\')) continue
        const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
        if (type === 'add') file.added++
        if (type === 'del') file.removed++
        hunk.lines.push({ type, text: line.slice(1) })
      }
      file.path = file.status === 'deleted' ? file.oldPath : file.newPath
      file.hash = hash(chunk)
      file.isGenerated = generated?.test(file.path) ?? false
      file.isHeavy = file.isGenerated || file.added + file.removed > 1500 || chunk.length > 400_000
      file.language = LANGUAGES[file.path.split('.').pop()?.toLowerCase() ?? '']
      return file
    })
}

/* highlighting */

function splitHtmlLines(html) {
  const out = []
  const stack = []
  let line = ''
  const re = /(<span[^>]*>)|(<\/span>)|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[1]) {
      stack.push(m[1])
      line += m[1]
    } else if (m[2]) {
      stack.pop()
      line += m[2]
    } else {
      const parts = m[3].split('\n')
      line += parts[0]
      for (let i = 1; i < parts.length; i++) {
        out.push(line + '</span>'.repeat(stack.length))
        line = stack.join('') + parts[i]
      }
    }
  }
  out.push(line)
  return out
}

function highlight(texts, language) {
  if (!texts.length) return []
  try {
    if (language && window.hljs?.getLanguage(language)) {
      const lines = splitHtmlLines(hljs.highlight(texts.join('\n'), { language, ignoreIllegals: true }).value)
      if (lines.length === texts.length) return lines
    }
  } catch {}
  return texts.map(esc)
}

function markHtml(html, ranges, kind) {
  if (!ranges?.length) return html
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  let offset = 0
  for (const node of nodes) {
    const start = offset
    const end = offset + node.data.length
    offset = end
    const hits = ranges.filter(([a, b]) => a < end && b > start)
    if (!hits.length) continue
    const fragment = document.createDocumentFragment()
    let pos = 0
    for (const [a, b] of hits) {
      const from = Math.max(a - start, 0)
      const to = Math.min(b - start, node.data.length)
      if (from > pos) fragment.append(node.data.slice(pos, from))
      const mark = document.createElement('span')
      mark.className = `word ${kind}`
      mark.textContent = node.data.slice(from, to)
      fragment.append(mark)
      pos = to
    }
    if (pos < node.data.length) fragment.append(node.data.slice(pos))
    node.replaceWith(fragment)
  }
  return template.innerHTML
}

function similarity(before, after) {
  if (!window.Diff || before.length + after.length > 2000) return 0
  const parts = Diff.diffWordsWithSpace(before, after)
  let common = 0
  for (const part of parts) if (!part.added && !part.removed) common += part.value.trim().length
  return common / Math.max(before.trim().length, after.trim().length, 1)
}

function wordRanges(before, after) {
  const parts = Diff.diffWordsWithSpace(before, after)
  const oldRanges = []
  const newRanges = []
  let o = 0
  let n = 0
  for (const part of parts) {
    const length = part.value.length
    if (part.added) {
      if (part.value.trim()) newRanges.push([n, n + length])
      n += length
    } else if (part.removed) {
      if (part.value.trim()) oldRanges.push([o, o + length])
      o += length
    } else {
      o += length
      n += length
    }
  }
  return [oldRanges, newRanges]
}

function alignRun(dels, adds) {
  const rows = []
  let a = 0
  for (const del of dels) {
    let best = -1
    let score = 0.45
    if (dels.length * adds.length <= 2500) {
      for (let k = a; k < adds.length; k++) {
        const value = similarity(del.text, adds[k].text)
        if (value > score) {
          score = value
          best = k
        }
      }
    }
    if (best < 0) {
      rows.push([del, null])
      continue
    }
    while (a < best) rows.push([null, adds[a++]])
    rows.push([del, adds[a++]])
  }
  while (a < adds.length) rows.push([null, adds[a++]])
  return rows
}

function prepareLines(lines, language) {
  const oldSide = lines.filter(line => line.type !== 'add')
  const newSide = lines.filter(line => line.type !== 'del')
  highlight(oldSide.map(line => line.text), language).forEach((html, i) => (oldSide[i].html = html))
  highlight(newSide.map(line => line.text), language).forEach((html, i) => {
    if (newSide[i].type === 'add') newSide[i].html = html
  })
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type !== 'del') {
      i++
      continue
    }
    const dels = []
    while (lines[i]?.type === 'del') dels.push(lines[i++])
    const adds = []
    while (lines[i]?.type === 'add') adds.push(lines[i++])
    const aligned = alignRun(dels, adds)
    dels[0].aligned = aligned
    for (const [del, add] of aligned) {
      if (!del || !add) continue
      const [oldRanges, newRanges] = wordRanges(del.text, add.text)
      del.html = markHtml(del.html, oldRanges, 'del')
      add.html = markHtml(add.html, newRanges, 'add')
    }
  }
  return lines
}

function numberLines(hunk) {
  let o = hunk.oldStart
  let n = hunk.newStart
  return hunk.lines.map(line => ({
    ...line,
    old: line.type === 'add' ? undefined : o++,
    new: line.type === 'del' ? undefined : n++,
  }))
}

function contextLines(text, from, to, offset) {
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  const out = []
  for (let n = from; n <= Math.min(to, all.length); n++) out.push({ type: 'ctx', text: all[n - 1] ?? '', old: n + offset, new: n })
  return out
}

/* rendering */

function targetOf(line) {
  return line.type === 'del' ? { side: 'old', line: line.old } : { side: 'new', line: line.new }
}

const sameTarget = (a, b) => !!a && !!b && a.path === b.path && a.side === b.side && a.line === b.line

function lnCell(path, line, number, extra = '', column = 'new') {
  if (number === undefined) return `<td class="ln ${extra}"></td>`
  const target = targetOf(line)
  const commented = comments.some(c => sameTarget(c, { path, ...target }))
  const isPending = column === 'new' && line.type !== 'del' && pending.get(path)?.has(line.new)
  return `<td class="ln ${extra}${commented ? ' commented' : ''}${isPending ? ' pending' : ''}"${isPending ? ' title="Uncommitted change"' : ''} data-path="${esc(path)}" data-side="${target.side}" data-line="${target.line}">${number}<button class="add-comment" tabindex="-1" title="Comment on this line">+</button></td>`
}

function threadRows(path, targets, colspan) {
  let html = ''
  for (const target of targets) {
    const at = { path, ...target }
    for (const comment of comments.filter(c => sameTarget(c, at))) {
      if (composer && sameTarget(composer, at)) continue
      const index = comments.indexOf(comment)
      html += `<tr class="thread"><td colspan="${colspan}"><div class="comment">
        <div class="comment-head"><strong>You</strong><span class="badge">Pending</span><span class="spacer"></span>
          <button class="btn invisible" data-edit="${index}">Edit</button>
          <button class="btn invisible" data-remove="${index}">Delete</button></div>
        <div class="comment-body">${esc(comment.text)}</div></div></td></tr>`
    }
    if (composer && sameTarget(composer, at)) {
      html += `<tr class="thread"><td colspan="${colspan}"><div class="composer">
        <textarea placeholder="Leave a comment for Claude…">${esc(composer.text ?? '')}</textarea>
        <div class="actions"><span class="muted hint">⌘↵ to save · Esc to cancel</span>
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn primary" data-act="save">${composer.text ? 'Update comment' : 'Add comment'}</button></div>
        </div></td></tr>`
    }
  }
  return html
}

const isHalf = file => prefs.format === 'split' && (file.status === 'added' || file.status === 'deleted')

function lineRows(file, lines, split) {
  let html = ''
  if (isHalf(file)) {
    for (const line of lines) {
      html += `<tr class="${line.type}">${lnCell(file.path, line, line.new ?? line.old, '', line.new === undefined ? 'old' : 'new')}<td class="code">${line.html ?? ''}</td></tr>`
      html += threadRows(file.path, [targetOf(line)], 2)
    }
    return html
  }
  if (!split) {
    for (const line of lines) {
      html += `<tr class="${line.type}">${lnCell(file.path, line, line.old, '', 'old')}${lnCell(file.path, line, line.new)}<td class="code">${line.html ?? ''}</td></tr>`
      html += threadRows(file.path, [targetOf(line)], 3)
    }
    return html
  }
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]
    if (line.type === 'ctx') {
      html += `<tr>${lnCell(file.path, line, line.old, '', 'old')}<td class="code old">${line.html}</td>${lnCell(file.path, line, line.new)}<td class="code">${line.html}</td></tr>`
      html += threadRows(file.path, [targetOf(line)], 4)
      i++
      continue
    }
    const dels = []
    while (lines[i]?.type === 'del') dels.push(lines[i++])
    const adds = []
    while (lines[i]?.type === 'add') adds.push(lines[i++])
    const aligned = dels[0]?.aligned ?? adds.map(add => [null, add])
    for (const [del, add] of aligned) {
      const left = del
        ? `${lnCell(file.path, del, del.old, 'del', 'old')}<td class="code old del">${del.html}</td>`
        : '<td class="ln empty"></td><td class="code old empty"></td>'
      const right = add
        ? `${lnCell(file.path, add, add.new, 'add')}<td class="code add">${add.html}</td>`
        : '<td class="ln empty"></td><td class="code empty"></td>'
      html += `<tr>${left}${right}</tr>`
      html += threadRows(file.path, [del && targetOf(del), add && targetOf(add)].filter(Boolean), 4)
    }
  }
  return html
}

function hunkRow(split, expand, label, half = false) {
  const numbers = split || half ? 1 : 2
  const expandCell = expand
    ? `<td class="expand" colspan="${numbers}" data-expand="${expand.key}" title="${esc(expand.title)}">${expand.icon}</td>`
    : `<td colspan="${numbers}"></td>`
  return `<tr class="hunk">${expandCell}<td class="heading" colspan="${split ? 3 : 1}">${esc(label)}</td></tr>`
}

function fileBody(file) {
  if (file.binary) return '<div class="placeholder">Binary file not shown</div>'
  if (file.isHeavy && !shownHeavy.has(file.path)) {
    return `<div class="placeholder">${file.isGenerated ? 'Generated file' : 'Large diff'} not rendered by default.
      <button class="btn" data-show="${esc(file.path)}">Load diff</button></div>`
  }
  if (!file.hunks.length) {
    return `<div class="placeholder">${file.status === 'renamed' ? 'File renamed without changes' : 'No content changes'}</div>`
  }
  const split = prefs.format === 'split' && file.status !== 'added' && file.status !== 'deleted'
  const expanded = expansions.get(file.path) ?? { gaps: new Set(), end: false }
  const hasText = expanded.text !== undefined
  const canExpand = file.status !== 'added' && file.status !== 'deleted'
  let rows = ''
  let previousEnd = 1
  let offset = 0
  file.hunks.forEach((hunk, k) => {
    const gapFrom = previousEnd
    const gapTo = hunk.newStart - 1
    const gap = gapTo - gapFrom + 1
    offset = hunk.oldStart - hunk.newStart
    if (canExpand && gap > 0 && expanded.gaps.has(k) && hasText) {
      rows += lineRows(file, prepareLines(contextLines(expanded.text, gapFrom, gapTo, offset), file.language), split)
    } else {
      rows += hunkRow(
        split,
        canExpand && gap > 0 ? { key: k, icon: ICONS.unfold, title: `Expand ${gap} hidden line${gap === 1 ? '' : 's'}` } : null,
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.heading}`,
        isHalf(file),
      )
    }
    rows += lineRows(file, prepareLines(numberLines(hunk), file.language), split)
    previousEnd = hunk.newStart + hunk.newLines
    offset = hunk.oldStart + hunk.oldLines - previousEnd
  })
  if (canExpand) {
    const rest = hasText ? contextLines(expanded.text, previousEnd, Infinity, offset) : null
    if (expanded.end && rest) rows += lineRows(file, prepareLines(rest, file.language), split)
    else if (!rest || rest.length) {
      rows += hunkRow(split, { key: 'end', icon: ICONS.down, title: 'Expand the rest of the file' }, rest ? `${rest.length} more line${rest.length === 1 ? '' : 's'}` : '')
    }
  }
  const cols = split
    ? '<col class="num"><col><col class="num"><col>'
    : isHalf(file)
      ? '<col class="num"><col>'
      : '<col class="num"><col class="num"><col>'
  return `<table class="diff ${split ? 'split' : 'unified'}"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table>`
}

function bars(file) {
  const total = file.added + file.removed
  const filled = total ? Math.min(5, Math.max(1, Math.round(Math.log2(total + 1)))) : 0
  const adds = total ? Math.round((filled * file.added) / total) : 0
  return `<span class="bars">${Array.from({ length: 5 }, (_, i) => `<i class="${i < adds ? 'add' : i < filled ? 'del' : ''}"></i>`).join('')}</span>`
}

function pathHtml(path) {
  const at = path.lastIndexOf('/')
  return at < 0 ? esc(path) : `<span class="dir">${esc(path.slice(0, at + 1))}</span>${esc(path.slice(at + 1))}`
}

function isCollapsed(file) {
  if (collapsed.has(file.path)) return true
  return isViewed(file) && !collapsed.has(`open:${file.path}`)
}

function fileCard(file) {
  const viewed = isViewed(file)
  const closed = isCollapsed(file)
  const status = { added: 'Added', deleted: 'Deleted', renamed: 'Renamed' }[file.status]
  const name = file.status === 'renamed' ? `${pathHtml(file.oldPath)} → ${pathHtml(file.newPath)}` : pathHtml(file.path)
  const count = comments.filter(c => c.path === file.path).length
  const side = isHalf(file) ? (file.status === 'added' ? ' half new-side' : ' half old-side') : ''
  return `<section class="file${closed ? ' collapsed' : ''}${side}" data-file="${esc(file.path)}">
    <div class="file-head">
      <button class="btn icon invisible" data-collapse="${esc(file.path)}" title="${closed ? 'Expand' : 'Collapse'} file">${ICONS.chevron}</button>
      <span class="path" title="${esc(file.path)}">${name}</span>
      <button class="btn icon invisible" data-copy="${esc(file.path)}" title="Copy path">${ICONS.copy}</button>
      ${status ? `<span class="badge">${status}</span>` : ''}
      <span class="stat"><span class="add">+${file.added}</span> <span class="del">−${file.removed}</span>${bars(file)}</span>
      <span class="spacer"></span>
      ${pending.has(file.path) ? '<span class="badge pending" title="Has uncommitted changes">Uncommitted</span>' : ''}
      ${count ? `<span class="badge pending">${count} comment${count === 1 ? '' : 's'}</span>` : ''}
      <label class="viewed-toggle"><input type="checkbox" data-viewed="${esc(file.path)}" ${viewed ? 'checked' : ''}>Viewed</label>
    </div>
    <div class="file-body">${closed ? '' : fileBody(file)}</div>
  </section>`
}

function renderStack() {
  $('#stack').innerHTML = state.rows
    .map(row => {
      const pr = row.pr
      const stat = row.diff
        ? `<span class="stat"><span class="add">+${row.diff.added}</span> <span class="del">−${row.diff.removed}</span></span>`
        : ''
      const title = pr
        ? `<span class="num">#${pr.number}</span><span class="title">${esc(pr.title)}</span>`
        : `<span class="title ${row.isTrunk ? '' : 'branch'}">${esc(row.branch)}</span>`
      const classes = ['row', row.isTrunk ? 'trunk' : '', row.branch === selected ? 'selected' : ''].join(' ')
      return `<div class="${classes}" data-branch="${esc(row.branch)}" title="${esc(row.branch)}">${row.lane}${title}${
        row.needsRestack ? '<span class="restack" title="Needs a restack">↻</span>' : ''
      }${stat}</div>`
    })
    .join('')
}

function renderSidebar() {
  const viewedCount = files.filter(isViewed).length
  $('#files-progress').textContent = files.length ? `${viewedCount} / ${files.length} viewed` : ''
  $('#files-section').hidden = !files.length
  $('#files').innerHTML = files
    .map(file => {
      const at = file.path.lastIndexOf('/')
      const viewed = isViewed(file)
      return `<div class="file-item${viewed ? ' viewed' : ''}" data-goto="${esc(file.path)}" title="${esc(file.path)}">
        <span class="check">${viewed ? '✓' : pending.has(file.path) ? '<i class="dot" title="Uncommitted changes"></i>' : ''}</span>
        <span class="name"><span>${at < 0 ? '' : `<span class="muted">${esc(file.path.slice(0, at + 1))}</span>`}${esc(file.path.slice(at + 1))}</span></span>
        <span class="stat"><span class="add">+${file.added}</span> <span class="del">−${file.removed}</span></span></div>`
    })
    .join('')
  const commits = current?.commits ?? []
  $('#commits-section').hidden = !commits.length
  $('#commits').innerHTML = commits
    .map(c => `<div class="commit" title="${esc(`${c.subject}\n${c.author}, ${c.when}`)}"><code>${esc(c.sha)}</code><span>${esc(c.subject)}</span></div>`)
    .join('')
}

function renderHeader() {
  const row = selectedRow()
  if (!row) {
    $('#header').innerHTML = '<h1>Pick a branch</h1>'
    return
  }
  const pr = row.pr
  const title = pr
    ? `<a href="${esc(pr.url)}" target="_blank" rel="noreferrer">${esc(pr.title)} <span class="num">#${pr.number}</span></a>`
    : esc(row.branch)
  const base = current?.parent ?? (prefs.compare === 'trunk' ? state.trunk : row.parent)
  const totals = files.reduce((sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }), { added: 0, removed: 0 })
  const order = stackRows()
  const index = order.findIndex(r => r.branch === selected)
  const pressed = on => `aria-pressed="${on}"`
  const allClosed = files.length > 0 && files.every(isCollapsed)
  $('#header').innerHTML = `
    <h1>${title}</h1>
    <div class="meta">
      ${
        current?.mode === 'uncommitted'
          ? `<span class="chip">working copy</span><span>→</span><span class="chip">${esc(row.branch)}</span>`
          : `<span class="chip">${esc(row.branch)}</span><span>→</span><span class="chip">${esc(base)}</span>`
      }
      <span>${files.length} file${files.length === 1 ? '' : 's'}</span>
      <span class="stat"><span class="add">+${totals.added}</span> <span class="del">−${totals.removed}</span></span>
      ${row.needsRestack ? '<span class="badge pending">Needs restack</span>' : ''}
      ${current?.mode === 'all' ? '<span class="badge pending">Includes uncommitted changes</span>' : ''}
      ${current?.mode === 'uncommitted' ? '<span class="badge pending">Uncommitted changes only</span>' : ''}
      ${pr?.graphiteUrl ? `<a href="${esc(pr.graphiteUrl)}" target="_blank" rel="noreferrer">Graphite ↗</a>` : ''}
    </div>
    <div class="toolbar">
      <span class="segmented">
        <button data-format="unified" ${pressed(prefs.format === 'unified')}>Unified</button>
        <button data-format="split" ${pressed(prefs.format === 'split')}>Split</button>
      </span>
      <span class="segmented"${current?.mode === 'uncommitted' ? ' hidden' : ''}>
        <button data-compare="parent" ${pressed(prefs.compare === 'parent')}>vs parent</button>
        <button data-compare="trunk" ${pressed(prefs.compare === 'trunk')}>vs ${esc(state.trunk ?? 'trunk')}</button>
      </span>
      ${
        current?.isCurrent && current?.dirty
          ? `<span class="segmented" title="The checked-out branch has uncommitted changes">
              <button data-uncommitted="all" ${pressed(current.mode === 'all')}>All changes</button>
              <button data-uncommitted="committed" ${pressed(current.mode === 'committed')}>Committed</button>
              <button data-uncommitted="only" ${pressed(current.mode === 'uncommitted')}>Uncommitted</button>
            </span>`
          : ''
      }
      <label class="switch"><input type="checkbox" data-toggle="whitespace" ${prefs.whitespace ? '' : 'checked'}>Hide whitespace</label>
      <span class="spacer"></span>
      <button class="btn icon" data-nav="-1" ${index >= order.length - 1 ? 'disabled' : ''} title="Parent branch ( [ )">${ICONS.downArrow}</button>
      <button class="btn icon" data-nav="1" ${index <= 0 ? 'disabled' : ''} title="Child branch ( ] )">${ICONS.up}</button>
      <button class="btn" data-act="collapse-all">${allClosed ? 'Expand all' : 'Collapse all'}</button>
      <button class="btn primary" data-act="review">Review${comments.length ? ` <span class="count">${comments.length}</span>` : ''}</button>
    </div>`
  document.documentElement.style.setProperty('--header-height', `${$('#header').offsetHeight}px`)
}

function renderDiff() {
  $('#notice').textContent = current?.error ?? ''
  $('#diff').innerHTML = files.length
    ? files.map(fileCard).join('')
    : current?.error
      ? ''
      : '<div class="empty-state">No changes on this branch.</div>'
}

function renderAll() {
  const scroll = window.scrollY
  renderHeader()
  renderSidebar()
  renderDiff()
  window.scrollTo(0, scroll)
}

function rerenderFile(path) {
  const file = files.find(f => f.path === path)
  const card = cardOf(path)
  if (file && card) card.outerHTML = fileCard(file)
}

/* data */

async function loadDiff(force = false) {
  if (!selected) return
  const params = new URLSearchParams({
    branch: selected,
    compare: prefs.compare,
    ws: prefs.whitespace ? '1' : '0',
    uncommitted: { all: '1', committed: '0', only: 'only' }[prefs.uncommitted] ?? '1',
  })
  let result
  try {
    result = await api(`/diff?${params}`)
  } catch {
    return
  }
  if (result.branch && result.branch !== selected) return
  const key = JSON.stringify([result.diff, result.pending, result.error, result.base])
  current = result
  if (!force && key === renderedKey) {
    renderHeader()
    renderSidebar()
    return
  }
  renderedKey = key
  files = result.error ? [] : parseFiles(result.diff ?? '')
  pending = new Map(
    parseFiles(result.pending ?? '').map(file => [
      file.path,
      new Set(file.hunks.flatMap(hunk => numberLines(hunk).filter(line => line.type === 'add').map(line => line.new))),
    ]),
  )
  const reopen = [...expansions.keys()]
  for (const path of reopen) expansions.set(path, { ...expansions.get(path), text: undefined })
  renderAll()
  for (const path of reopen) expand(path, null)
}

async function expand(path, key) {
  if (!files.some(f => f.path === path)) return
  const expansion = expansions.get(path) ?? { gaps: new Set(), end: false }
  if (key === 'end') expansion.end = true
  else if (key !== null) expansion.gaps.add(Number(key))
  expansions.set(path, expansion)
  if (expansion.text === undefined) {
    const params = new URLSearchParams({ branch: selected, path, worktree: current?.includeWorktree ? '1' : '0' })
    const result = await api(`/file?${params}`).catch(() => ({}))
    if (result.text === undefined) return
    expansion.text = result.text
  }
  rerenderFile(path)
}

function persistComments() {
  store(`comments:${selected}`, comments.length ? comments : undefined)
}

function openComposer(target) {
  const existing = comments.find(c => sameTarget(c, target))
  const previous = composer?.path
  composer = { path: target.path, side: target.side, line: target.line, text: existing?.text ?? '' }
  if (previous && previous !== target.path) rerenderFile(previous)
  rerenderFile(target.path)
  const area = document.querySelector('.composer textarea')
  area?.focus()
  area?.setSelectionRange(area.value.length, area.value.length)
}

function codeAt(target) {
  const file = files.find(f => f.path === target.path)
  for (const hunk of file?.hunks ?? []) {
    const line = numberLines(hunk).find(l => sameTarget({ path: target.path, ...targetOf(l) }, target))
    if (line) return line.text
  }
  const text = expansions.get(target.path)?.text
  return target.side === 'new' && text ? (text.split('\n')[target.line - 1] ?? '') : ''
}

function saveComposer() {
  if (!composer) return
  const text = document.querySelector('.composer textarea')?.value.trim() ?? ''
  const target = { path: composer.path, side: composer.side, line: composer.line }
  comments = comments.filter(c => !sameTarget(c, target))
  if (text) comments.push({ ...target, text, code: codeAt(target) })
  comments.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  composer = null
  persistComments()
  rerenderFile(target.path)
  renderHeader()
}

function closeComposer() {
  if (!composer) return
  const path = composer.path
  composer = null
  rerenderFile(path)
}

function clearComments() {
  const paths = new Set(comments.map(c => c.path))
  comments = []
  persistComments()
  paths.forEach(rerenderFile)
  renderHeader()
}

async function sendReview() {
  const button = document.querySelector('#submit [data-act="send"]')
  const summary = $('#summary').value.trim()
  if (!comments.length && !summary) {
    $('#summary').focus()
    return
  }
  button.disabled = true
  button.textContent = 'Sending…'
  try {
    await api('/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'review',
        branch: selected,
        compareTo: current?.parent,
        includesUncommitted: !!current?.includeWorktree,
        summary,
        comments,
      }),
    })
    $('#summary').value = ''
    clearComments()
    button.textContent = 'Sent to Claude ✓'
    setTimeout(() => ($('#submit').hidden = true), 900)
  } catch {
    button.textContent = 'Failed, retry'
  } finally {
    setTimeout(() => {
      button.disabled = false
      button.textContent = 'Send to Claude'
    }, 1200)
  }
}

function navigate(step) {
  const order = stackRows()
  const next = order[order.findIndex(r => r.branch === selected) - step]
  if (next) select(next.branch)
}

function setPref(key, value) {
  prefs[key] = value
  store(key, value)
  if (key === 'format') {
    renderAll()
    return
  }
  expansions = new Map()
  loadDiff(true)
}

function scrollToFile(path) {
  const card = cardOf(path)
  if (card) window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - $('#header').offsetHeight - 8 })
}

/* events */

document.addEventListener('click', event => {
  const t = event.target
  const ln = t.closest('td.ln[data-line]')
  if (ln) {
    openComposer({ path: ln.dataset.path, side: ln.dataset.side, line: Number(ln.dataset.line) })
    return
  }
  const el = t.closest('[data-uncommitted],[data-branch],[data-nav],[data-format],[data-compare],[data-act],[data-show],[data-expand],[data-collapse],[data-copy],[data-goto],[data-edit],[data-remove]')
  if (!t.closest('#submit') && !t.closest('[data-act="review"]')) $('#submit').hidden = true
  if (!el) return
  const d = el.dataset
  if (d.branch !== undefined && !el.classList.contains('trunk')) select(d.branch)
  if (d.nav) navigate(Number(d.nav))
  if (d.format) setPref('format', d.format)
  if (d.compare) setPref('compare', d.compare)
  if (d.uncommitted) setPref('uncommitted', d.uncommitted)
  if (d.show) {
    shownHeavy.add(d.show)
    rerenderFile(d.show)
  }
  if (d.expand !== undefined) expand(el.closest('.file').dataset.file, d.expand)
  if (d.collapse) {
    const file = files.find(f => f.path === d.collapse)
    if (!file) return
    const wasClosed = isCollapsed(file)
    collapsed.delete(file.path)
    collapsed.delete(`open:${file.path}`)
    if (!wasClosed) collapsed.add(file.path)
    else if (isViewed(file)) collapsed.add(`open:${file.path}`)
    rerenderFile(file.path)
    if (!wasClosed && cardOf(file.path).getBoundingClientRect().top < 0) scrollToFile(file.path)
    renderHeader()
  }
  if (d.copy) {
    navigator.clipboard?.writeText(d.copy)
    el.title = 'Copied'
  }
  if (d.goto) {
    const file = files.find(f => f.path === d.goto)
    if (file && isCollapsed(file)) {
      collapsed.delete(file.path)
      if (isViewed(file)) collapsed.add(`open:${file.path}`)
      rerenderFile(file.path)
    }
    scrollToFile(d.goto)
  }
  if (d.edit) {
    const comment = comments[Number(d.edit)]
    if (comment) openComposer(comment)
  }
  if (d.remove) {
    const [comment] = comments.splice(Number(d.remove), 1)
    persistComments()
    if (comment) rerenderFile(comment.path)
    renderHeader()
  }
  if (d.act === 'save') saveComposer()
  if (d.act === 'cancel') closeComposer()
  if (d.act === 'collapse-all') {
    const allClosed = files.every(isCollapsed)
    collapsed = new Set(allClosed ? files.filter(isViewed).map(f => `open:${f.path}`) : files.map(f => f.path))
    renderAll()
  }
  if (d.act === 'review') {
    $('#submit').hidden = !$('#submit').hidden
    if (!$('#submit').hidden) $('#summary').focus()
  }
  if (d.act === 'send') sendReview()
  if (d.act === 'discard') {
    clearComments()
    $('#submit').hidden = true
  }
})

document.addEventListener('change', event => {
  const t = event.target
  if (t.dataset.viewed) {
    const file = files.find(f => f.path === t.dataset.viewed)
    if (!file) return
    store(viewedKey(file), t.checked)
    collapsed.delete(file.path)
    collapsed.delete(`open:${file.path}`)
    rerenderFile(file.path)
    renderSidebar()
    renderHeader()
    if (t.checked && cardOf(file.path).getBoundingClientRect().top < $('#header').offsetHeight) scrollToFile(file.path)
  }
  if (t.dataset.toggle === 'whitespace') setPref('whitespace', !t.checked)
})

document.addEventListener('keydown', event => {
  if (event.target.closest('.composer textarea')) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveComposer()
    if (event.key === 'Escape') closeComposer()
    return
  }
  if (event.target.closest('textarea, input')) {
    if (event.target.id === 'summary' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendReview()
    if (event.key === 'Escape') $('#submit').hidden = true
    return
  }
  if (event.key === 'Escape') $('#submit').hidden = true
  if (event.key === '[') navigate(-1)
  if (event.key === ']') navigate(1)
})

window.addEventListener('resize', () => document.documentElement.style.setProperty('--header-height', `${$('#header').offsetHeight}px`))

async function poll() {
  for (;;) {
    try {
      const next = await api(`/state?v=${state.version}`)
      $('#connection').className = 'connection'
      $('#connection').title = 'Live'
      if (next.version === state.version) continue
      const restarted = next.version < state.version
      state = { ...next, rows: next.rows ?? [] }
      document.title = `Review · ${state.repo ?? 'stack'}`
      if (state.focus && state.focus.seq !== lastFocus) {
        if (lastFocus !== null || !selected) select(state.focus.branch)
        lastFocus = state.focus.seq
      }
      if (!state.rows.some(r => r.branch === selected && !r.isTrunk)) {
        const fallback = state.rows.find(r => r.isCurrent && !r.isTrunk) ?? stackRows()[0]
        selected = ''
        if (fallback) select(fallback.branch)
      }
      renderStack()
      if (!composer) loadDiff(restarted)
    } catch {
      $('#connection').className = 'connection offline'
      $('#connection').title = 'Disconnected: waiting for Claude Code'
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
}

comments = stored(`comments:${selected}`, [])
poll()
