import hljs from 'highlight.js/lib/common'
import { diffWordsWithSpace } from 'diff'
import DOMPurify from 'dompurify'

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
  github: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>',
  graphite: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.2 13.9 4.6v6.8L8 14.8 2.1 11.4V4.6Z"/><path d="M8 4.6 10.95 6.3v3.4L8 11.4 5.05 9.7V6.3Z" fill="currentColor" stroke="none"/></svg>',
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

const session = {
  get(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? 'null')
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
}

function saveDraft() {
  if (!selected) return
  const summary = $('#summary')?.value ?? ''
  const draft = { summary, composers, describing, threadNotes }
  session.set(`draft:${selected}`, summary || composers.length || describing || threadNotes.length ? draft : null)
}

function restoreDraft() {
  const draft = session.get(`draft:${selected}`)
  $('#summary').value = draft?.summary ?? ''
  composers = draft?.composers ?? (draft?.composer ? [draft.composer] : [])
  describing = draft?.describing ?? null
  threadNotes = draft?.threadNotes ?? []
}

const prefs = {
  format: stored('format', 'split'),
  whitespace: stored('whitespace', false),
  compare: stored('compare', 'parent'),
  showSent: stored('showSent', true),
  uncommitted: { true: 'all', false: 'committed' }[stored('uncommitted', 'all')] ?? stored('uncommitted', 'all'),
}
if (prefs.format !== 'unified' && prefs.format !== 'split') prefs.format = 'split'

let state = { version: -1, rows: [] }
let selected = decodeURIComponent(location.hash.replace(/^#branch=/, '')) || ''
let current = null
let renderedKey = ''
let files = []
let comments = []
let sent = []
let jumps = []
let pendingJump = null
let composers = []
let threadNotes = []
const noteAt = id => threadNotes.find(n => n.id === id)
const composerAt = target => composers.find(c => sameTarget(c, target))
const composerFor = el => composers.find(c => targetKey(c) === el?.closest?.('.composer')?.dataset.box)
let shownHeavy = new Set()
let collapsed = new Set()
let expansions = new Map()
let pending = new Map()

const api = (path, init) =>
  fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`, init).then(res => {
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  })

const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36)
const ensureIds = list => list.forEach(c => (c.id ??= newId()))

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
  descriptionOpen = false
  comments = stored(`comments:${branch}`, [])
  sent = stored(`sent:${branch}`, [])
  restoreDraft()
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
    if (language && hljs.getLanguage(language)) {
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
  if (before.length + after.length > 2000) return 0
  const parts = diffWordsWithSpace(before, after)
  let common = 0
  for (const part of parts) if (!part.added && !part.removed) common += part.value.trim().length
  return common / Math.max(before.trim().length, after.trim().length, 1)
}

function wordRanges(before, after) {
  const parts = diffWordsWithSpace(before, after)
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

const covers = (range, path, target) =>
  !!range && range.path === path && range.side === target.side && (range.start ?? range.line) <= target.line && target.line <= range.line

const rangeLabel = c => (c.start && c.start !== c.line ? `lines ${c.start}–${c.line}` : `line ${c.line}`)

function lnCell(path, line, number, extra = '', column = 'new') {
  if (number === undefined) return `<td class="ln ${extra}"></td>`
  const target = targetOf(line)
  const commented = comments.some(c => c.kind !== 'thread' && covers(c, path, target))
  if (composers.some(c => covers(c, path, target))) extra += ' in-range'
  const isPending = column === 'new' && line.type !== 'del' && pending.get(path)?.has(line.new)
  return `<td class="ln ${extra}${commented ? ' commented' : ''}${isPending ? ' pending' : ''}"${isPending ? ' title="Uncommitted change"' : ''} data-path="${esc(path)}" data-side="${target.side}" data-line="${target.line}">${number}<button class="add-comment" tabindex="-1" title="Comment on this line">+</button></td>`
}

let renderedTargets = new Set()
const targetKey = t => `${t.path}|${t.side}|${t.line}`

function pendingCard(comment, index, note = '') {
  return `<div class="comment">
    <div class="comment-head"><strong>You</strong><span class="badge">Pending</span><span>on ${rangeLabel(comment)}</span>${note}<span class="spacer"></span>
      <button class="btn invisible" data-send-now="${index}" title="Send just this comment to Claude now">Send now</button>
      <button class="btn invisible" data-edit="${index}">Edit</button>
      <button class="btn invisible" data-remove="${index}">Delete</button></div>
    <div class="comment-body">${esc(comment.text)}</div></div>`
}

function composerBox(composer) {
  return `<div class="composer" data-box="${esc(targetKey(composer))}">
    <textarea placeholder="Leave a comment for Claude on ${rangeLabel(composer)}…">${esc(composer.text ?? '')}</textarea>
    <div class="actions">${composer.side === 'new' ? '<button class="btn invisible" data-act="suggest" title="Suggest a replacement for the selected lines">± Suggest change</button>' : ''}<span class="muted hint">⌘↵ to save · Esc to cancel</span>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn" data-act="send-now" title="Send just this comment to Claude now, without the rest of the review">Send to Claude now</button>
      <button class="btn primary" data-act="save">${composer.existing ? 'Update comment' : 'Add comment'}</button></div>
    </div>`
}

function strandedComments(path, isRendered) {
  const stranded = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => !comment.kind && comment.path === path && !isRendered(comment))
  const composerStranded = composers.filter(c => c.path === path && !isRendered(c))
  if (!stranded.length && !composerStranded.length) return ''
  let html = `<div class="stranded"><div class="stranded-head">Comments on lines that are no longer in this diff</div>`
  for (const { comment, index } of stranded) {
    if (composerAt(comment)) continue
    html += pendingCard(comment, index)
  }
  for (const box of composerStranded) html += composerBox(box)
  return `${html}</div>`
}

const openChanges = new Set()
const changeViews = new Map()
const changesKey = c => `${c.answer.from}..${c.answer.to}|${c.kind ? '' : c.path}|${prefs.whitespace ? 1 : 0}`

const sentClass = c => `comment sent${c.answer ? ' answered' : ''}`

function answerBadge(c) {
  const status = c.answer?.status
  return status ? `<span class="badge answered">${status === 'fixed' ? 'Addressed' : 'Reply'}</span>` : ''
}

function changesHtml(diff) {
  const list = parseFiles(diff)
  if (!list.length) return '<div class="placeholder">No file changes.</div>'
  return list
    .slice(0, 20)
    .map(file => {
      const head = `<div class="changes-file"><span class="path">${pathHtml(file.path)}</span><span class="stat"><span class="add">+${file.added}</span> <span class="del">−${file.removed}</span></span></div>`
      if (file.binary) return `${head}<div class="placeholder">Binary file not shown</div>`
      if (file.isHeavy) return `${head}<div class="placeholder">Large diff not shown</div>`
      const rows = file.hunks
        .map(
          hunk =>
            hunkRow(false, null, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.heading}`) +
            prepareLines(numberLines(hunk), file.language)
              .map(line => `<tr class="${line.type}"><td class="ln">${line.old ?? ''}</td><td class="ln">${line.new ?? ''}</td><td class="code">${line.html ?? ''}</td></tr>`)
              .join(''),
        )
        .join('')
      return `${head}<table class="diff unified"><colgroup><col class="num"><col class="num"><col></colgroup><tbody>${rows}</tbody></table>`
    })
    .join('')
}

function answerBlock(c) {
  const a = c.answer
  if (!a) return ''
  const id = String(c.id)
  const open = openChanges.has(id)
  return `${a.text ? `<div class="claude-reply"><strong>Claude</strong><div>${esc(a.text)}</div></div>` : ''}${
    a.from && a.to
      ? `<div class="changes${open ? ' open' : ''}"><button class="changes-toggle" data-changes="${esc(id)}">${ICONS.chevron}Changes</button>${
          open ? `<div class="changes-body">${changeViews.get(changesKey(c)) ?? '<div class="placeholder">Loading…</div>'}</div>` : ''
        }</div>`
      : ''
  }`
}

function refreshAnswer(comment) {
  if (comment.kind === 'description') renderDescriptionThreads()
  else rerenderFile(comment.path)
}

async function toggleChanges(id) {
  const comment = sent.find(c => String(c.id) === id)
  if (!comment?.answer?.from || !comment.answer.to) return
  if (!openChanges.delete(id)) openChanges.add(id)
  refreshAnswer(comment)
  const key = changesKey(comment)
  if (!openChanges.has(id) || changeViews.has(key)) return
  const params = new URLSearchParams({ from: comment.answer.from, to: comment.answer.to, ws: prefs.whitespace ? '1' : '0' })
  if (!comment.kind) params.set('path', comment.path)
  const result = await api(`/changes?${params}`).catch(() => ({ error: 'unreachable' }))
  changeViews.set(key, result.error ? '<div class="placeholder">These changes are no longer available.</div>' : changesHtml(result.diff ?? ''))
  refreshAnswer(comment)
}

function applyReplies() {
  const replies = state.replies ?? {}
  let changed = false
  for (const row of stackRows()) {
    const list = row.branch === selected ? sent : stored(`sent:${row.branch}`, [])
    let dirty = false
    for (const c of list) {
      const next = c.id === undefined ? undefined : replies[String(c.id)]
      if (next && JSON.stringify(next) !== JSON.stringify(c.answer)) {
        c.answer = next
        dirty = true
      }
    }
    if (dirty) store(`sent:${row.branch}`, list)
    changed ||= dirty
  }
  return changed
}

const threadList = () => selectedRow()?.pr?.threads ?? []
const openResolved = new Set()
const threadErrors = new Map()
let renderedThreads = new Set()
const threadLine = t => t.line ?? t.originalLine ?? 1
const isPlaced = t => !t.outdated && !!t.line

function threadCard(thread) {
  const first = thread.comments[0]
  const inReview = comments.some(c => c.thread?.id === thread.id)
  const wasSent = sent.some(c => c.thread?.id === thread.id)
  const answered = sent.findLast(c => c.thread?.id === thread.id && c.answer)
  const shown = !thread.resolved || openResolved.has(thread.id)
  const error = threadErrors.get(thread.id)
  const id = `data-thread="${esc(thread.id)}"`
  const buttons = thread.resolved
    ? `<button class="btn invisible" data-thread-act="toggle" ${id}>${shown ? 'Hide' : 'Show'}</button>` +
      (thread.canToggle ? `<button class="btn invisible" data-thread-act="resolve" ${id}>Unresolve</button>` : '')
    : (inReview
        ? `<button class="btn invisible" data-thread-act="remove" ${id} title="Take this thread out of the pending review">Remove from review</button><button class="btn invisible" data-thread-act="add" ${id}>Edit note</button>`
        : `<button class="btn invisible" data-thread-act="add" ${id} title="Add this thread to the pending review">Add to review</button>`) +
      `<button class="btn invisible" data-thread-act="fix" ${id} title="Send just this thread to Claude to fix and resolve now">Fix now</button>` +
      (thread.canToggle ? `<button class="btn invisible" data-thread-act="resolve" ${id}>Resolve</button>` : '')
  const replies = thread.comments
    .map(
      (c, i) =>
        `<div class="gh-comment">${
          i ? `<div class="gh-reply-head">${avatar({ avatarUrl: c.avatar })}<strong>${esc(c.author)}</strong><span>${esc(timeAgo(Date.parse(c.createdAt)))}</span></div>` : ''
        }<div class="markdown">${cleanHtml(c.bodyHtml)}</div></div>`,
    )
    .join('')
  return `<div class="comment gh${thread.resolved ? ' resolved' : ''}" ${id}>
    <div class="comment-head">${avatar({ avatarUrl: first?.avatar })}<strong>${esc(first?.author ?? '')}</strong><span class="badge gh">GitHub</span>${
      thread.outdated ? '<span class="badge">Outdated</span>' : ''
    }${thread.resolved ? '<span class="badge sent">Resolved</span>' : ''}${!thread.resolved && wasSent && !inReview ? '<span class="badge sent">Sent to Claude</span>' : ''}${answered ? answerBadge(answered) : ''}${
      inReview ? '<span class="badge pending">In review</span>' : ''
    }<span>${esc(timeAgo(Date.parse(first?.createdAt)))}</span><span>on ${rangeLabel({ start: thread.start, line: threadLine(thread) })}</span><span class="spacer"></span>${buttons}</div>
    ${shown ? `<div class="gh-thread">${replies}</div>` : ''}
    ${noteBox(thread, inReview)}
    ${answered ? answerBlock(answered) : ''}
    ${error ? `<div class="thread-error">${esc(error)}</div>` : ''}</div>`
}

function noteBox(thread, inReview) {
  const note = noteAt(thread.id)
  const saved = comments.find(c => c.thread?.id === thread.id)?.note
  if (!note) return saved && !thread.resolved ? `<div class="comment-body"><strong>You:</strong> ${esc(saved)}</div>` : ''
  const id = `data-thread="${esc(thread.id)}"`
  return `<div class="composer thread-note" ${id}>
    <textarea placeholder="Add guidance for Claude (optional)…">${esc(note.text)}</textarea>
    <div class="actions"><span class="muted hint">⌘↵ to add · Esc to cancel</span>
      <button class="btn" data-thread-act="note-cancel" ${id}>Cancel</button>
      <button class="btn" data-thread-act="note-fix" ${id} title="Send just this thread to Claude to fix and resolve now">Fix now</button>
      <button class="btn primary" data-thread-act="note-add" ${id}>${inReview ? 'Update' : 'Add to review'}</button></div>
    </div>`
}

function strandedThreads(path, isRendered, openOnly = false) {
  const stranded = threadList().filter(t => t.path === path && !isRendered(t) && !(openOnly && t.resolved))
  if (!stranded.length) return ''
  return `<div class="stranded"><div class="stranded-head">GitHub threads on lines that are not in this diff</div>${stranded.map(threadCard).join('')}</div>`
}

function threadRows(path, targets, colspan) {
  let html = ''
  const row = (content, side) =>
    colspan === 4
      ? side === 'old'
        ? `<tr class="thread"><td colspan="2">${content}</td><td colspan="2" class="thread-gap"></td></tr>`
        : `<tr class="thread"><td colspan="2" class="thread-gap"></td><td colspan="2">${content}</td></tr>`
      : `<tr class="thread"><td colspan="${colspan}">${content}</td></tr>`
  for (const target of targets) {
    const at = { path, ...target }
    renderedTargets.add(targetKey(at))
    for (const thread of threadList().filter(t => isPlaced(t) && t.path === path && t.side === at.side && t.line === at.line)) {
      renderedThreads.add(thread.id)
      html += row(threadCard(thread), target.side)
    }
    for (const comment of comments.filter(c => c.kind !== 'thread' && sameTarget(c, at))) {
      if (composerAt(at)) continue
      html += row(pendingCard(comment, comments.indexOf(comment)), target.side)
    }
    if (prefs.showSent) {
      for (const comment of sent.filter(c => c.kind !== 'thread' && sameTarget(c, at))) {
        const index = sent.indexOf(comment)
        const outdated = codeAt(comment) !== (comment.code ?? '')
        html += row(
          `<div class="${sentClass(comment)}">
          <div class="comment-head"><strong>You</strong><span class="badge sent">Sent to Claude</span>${answerBadge(comment)}${outdated ? '<span class="badge">Outdated</span>' : ''}<span>${esc(timeAgo(comment.sentAt))}</span><span class="spacer"></span>
            <button class="btn invisible" data-dismiss="${index}">Dismiss</button></div>
          <div class="comment-body">${esc(comment.text)}</div>${answerBlock(comment)}</div>`,
          target.side,
        )
      }
    }
    const box = composerAt(at)
    if (box) html += row(composerBox(box), target.side)
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
  renderedTargets = new Set()
  renderedThreads = new Set()
  const body = fileBodyInner(file)
  return strandedComments(file.path, c => renderedTargets.has(targetKey(c))) + strandedThreads(file.path, t => renderedThreads.has(t.id)) + body
}

function fileBodyInner(file) {
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
  const openThreadCount = threadList().filter(t => t.path === file.path && !t.resolved).length
  const side = isHalf(file) ? (file.status === 'added' ? ' half new-side' : ' half old-side') : ''
  return `<section class="file${closed ? ' collapsed' : ''}${side}" data-file="${esc(file.path)}">
    <div class="file-head">
      <button class="btn icon invisible" data-collapse="${esc(file.path)}" title="${closed ? 'Expand' : 'Collapse'} file">${ICONS.chevron}</button>
      <span class="path" title="${esc(file.path)}">${name}</span>
      <button class="btn icon invisible" data-copy="${esc(file.path)}" title="Copy path">${ICONS.copy}</button>
      ${status ? `<span class="badge">${status}</span>` : ''}
      <span class="spacer"></span>
      <span class="stat"><span class="add">+${file.added}</span> <span class="del">−${file.removed}</span>${bars(file)}</span>
      ${pending.has(file.path) ? '<span class="badge pending" title="Has uncommitted changes">Uncommitted</span>' : ''}
      ${openThreadCount ? `<span class="badge gh" title="Unresolved GitHub review threads">${openThreadCount} open thread${openThreadCount === 1 ? '' : 's'}</span>` : ''}
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

const MEDIA_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)\//i

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
  if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'SOURCE') {
    const src = node.getAttribute('src') ?? ''
    if (src && !MEDIA_HOSTS.test(src)) node.removeAttribute('src')
    node.removeAttribute('srcset')
  }
})

const cleanHtml = html =>
  DOMPurify.sanitize(html.replace(/\sstyle=("[^"]*"|'[^']*')/gi, ''), {
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  })

let descriptionHtml = null
let descriptionOpen = false

function renderDescription() {
  const section = $('#description')
  const pr = selectedRow()?.pr
  const draftBody = !pr && current?.branch === selected ? (current?.draft?.body ?? '') : ''
  const body = pr ? (pr.bodyHtml?.trim() ?? '') : draftBody
  const showDraft = !pr && !!current?.draft
  section.hidden = !body && !showDraft
  section.classList.toggle('draft', !pr)
  if (section.hidden) {
    descriptionHtml = null
    return
  }
  const key = `${pr ? 'html' : 'text'}:${body}`
  if (key !== descriptionHtml) {
    descriptionHtml = key
    const target = section.querySelector('.description-body')
    if (pr) {
      target.innerHTML = cleanHtml(body)
    } else {
      target.innerHTML = `<p class="draft-note">Preview from the first commit's message, which becomes the PR title and description.</p>${
        body ? `<div class="commit-body">${esc(body)}</div>` : '<p class="muted">The commit message has no body.</p>'
      }`
    }
  }
  sizeDescription()
  requestAnimationFrame(sizeDescription)
  renderDescriptionThreads()
}

function sizeDescription() {
  const section = $('#description')
  if (section.hidden) return
  const inner = section.querySelector('.description-body')
  section.classList.toggle('open', descriptionOpen)
  const overflows = inner.scrollHeight > 220
  section.classList.toggle('capped', overflows && !descriptionOpen)
  const toggle = section.querySelector('.description-toggle')
  toggle.hidden = !overflows
  toggle.textContent = descriptionOpen ? 'Show less' : 'Show all'
}

let describing = null

function renderDescriptionThreads() {
  const box = $('#description .description-threads')
  if (!box) return
  const quote = q => (q ? `<blockquote>${esc(q)}</blockquote>` : '')
  let html = ''
  comments.forEach((c, index) => {
    if (c.kind !== 'description' || describing?.index === index) return
    html += `<div class="comment"><div class="comment-head"><strong>You</strong><span class="badge">Pending</span><span>on the description</span><span class="spacer"></span>
      <button class="btn invisible" data-describe-edit="${index}">Edit</button><button class="btn invisible" data-remove="${index}">Delete</button></div>
      <div class="comment-body">${quote(c.quote)}${esc(c.text)}</div></div>`
  })
  if (prefs.showSent) {
    sent.forEach((c, index) => {
      if (c.kind !== 'description') return
      html += `<div class="${sentClass(c)}"><div class="comment-head"><strong>You</strong><span class="badge sent">Sent to Claude</span>${answerBadge(c)}<span>${esc(timeAgo(c.sentAt))}</span><span class="spacer"></span>
        <button class="btn invisible" data-dismiss="${index}">Dismiss</button></div>
        <div class="comment-body">${quote(c.quote)}${esc(c.text)}</div>${answerBlock(c)}</div>`
    })
  }
  if (describing) {
    html += `<div class="composer">${describing.quote ? `<blockquote>${esc(describing.quote)}</blockquote>` : ''}
      <textarea placeholder="Feedback on the PR description for Claude…">${esc(describing.text ?? '')}</textarea>
      <div class="actions"><span class="muted hint">⌘↵ to save · Esc to cancel</span>
        <button class="btn" data-act="describe-cancel">Cancel</button>
        <button class="btn primary" data-act="describe-save">${describing.index === undefined ? 'Add comment' : 'Update comment'}</button></div></div>`
  }
  box.innerHTML = html
  box.hidden = !html
}

function openDescribe(quote, index) {
  const existing = index === undefined ? undefined : comments[index]
  describing = { quote: existing?.quote ?? quote, text: existing?.text ?? '', index }
  renderDescriptionThreads()
  const area = $('#description .composer textarea')
  area?.focus()
  saveDraft()
}

function saveDescribe() {
  if (!describing) return
  const text = $('#description .composer textarea')?.value.trim() ?? ''
  const { quote, index } = describing
  describing = null
  if (index !== undefined) comments.splice(index, 1)
  if (text) {
    comments.push({ kind: 'description', path: 'PR description', side: 'new', line: 0, id: Date.now(), quote, text, base: current?.parent })
  }
  persistComments()
  renderHeader()
  renderCommentViews()
  saveDraft()
}

function descriptionSelection() {
  const selection = window.getSelection()
  const body = $('#description .description-body')
  if (!selection || selection.isCollapsed || !body.contains(selection.anchorNode)) return ''
  return selection.toString().trim().slice(0, 1000)
}

const REVIEW_STATES = {
  APPROVED: ['approved', 'Approved', '✓'],
  CHANGES_REQUESTED: ['changes', 'Requested changes', '±'],
  COMMENTED: ['commented', 'Commented', '💬'],
  DISMISSED: ['dismissed', 'Review dismissed', '–'],
  PENDING: ['requested', 'Review pending', '…'],
  REQUESTED: ['requested', 'Review requested', '○'],
}

function labelInk(color) {
  const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(color.slice(i, i + 2), 16))
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1f2328' : '#ffffff'
}

function prInfo(pr) {
  const status = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open'
  const reviewers = (pr.reviewers ?? [])
    .map(r => {
      const [kind, label, mark] = REVIEW_STATES[r.state] ?? REVIEW_STATES.REQUESTED
      return `<span class="reviewer ${kind}" title="${esc(`${r.name}: ${label}`)}"><i>${mark}</i>${esc(r.name)}</span>`
    })
    .join('')
  const labels = (pr.labels ?? [])
    .map(l => {
      const color = /^[0-9a-f]{6}$/i.test(l.color) ? l.color : '8b949e'
      return `<span class="label" data-color="${color}" title="${esc(l.description ?? l.name)}">${esc(l.name)}</span>`
    })
    .join('')
  return `<div class="pr-info">
    <span class="state ${status}">${status[0].toUpperCase()}${status.slice(1)}</span>
    ${
      pr.state === 'OPEN'
        ? `<button class="btn" data-act="pr-ready" data-number="${pr.number}" data-ready="${pr.isDraft}">${pr.isDraft ? 'Ready for review' : 'Convert to draft'}</button>`
        : ''
    }
    <span class="reviewers"><span class="muted">${reviewers ? 'Reviewers' : 'No reviewers'}</span>${reviewers}${
      pr.state === 'OPEN'
        ? `<button class="btn small" data-act="reviewers" data-number="${pr.number}">${reviewers ? 'Edit reviewers' : '+ Request reviewers'}</button>`
        : ''
    }</span>
    ${labels ? `<span class="labels">${labels}</span>` : ''}
  </div>`
}

function paintLabels() {
  for (const el of document.querySelectorAll('.label[data-color]')) {
    const color = el.dataset.color
    el.style.setProperty('--label', `#${color}`)
    el.style.setProperty('--label-ink', labelInk(color))
  }
}

const shortBranch = branch => (branch ?? '').replace(/^[^/]+\//, '')

function updateIdentity() {
  const root = stackRows().at(-1)?.branch ?? selected
  const name = shortBranch(root) || 'stack'
  const hue = Number.parseInt(hash(root || 'stack'), 36) % 360
  const letter = esc((name.match(/[a-z0-9]/i)?.[0] ?? 'S').toUpperCase())
  const icon =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="hsl(${hue} 62% 44%)"/>` +
    `<text x="16" y="22.5" font-size="19" font-weight="700" font-family="system-ui,-apple-system,sans-serif" fill="#fff" text-anchor="middle">${letter}</text></svg>`
  const link = $('#favicon')
  const href = `data:image/svg+xml,${encodeURIComponent(icon)}`
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
  const row = selectedRow()
  const draftTitle = current?.branch === selected ? current?.draft?.title : undefined
  const label = row?.pr ? `#${row.pr.number} ${row.pr.title}` : draftTitle || shortBranch(selected) || 'Review'
  const pendingCountNow = pendingCount()
  document.title = `${pendingCountNow ? `(${pendingCountNow}) ` : ''}${label} · ${name}`
}

const branchChip = name =>
  `<span class="chip">${esc(name)}<button class="chip-copy" data-copy="${esc(name)}" title="Copy branch name">${ICONS.copy}</button></span>`

function renderHeader() {
  const row = selectedRow()
  if (!row) {
    $('#header').innerHTML = '<h1>Pick a branch</h1>'
    renderDescription()
    return
  }
  const pr = row.pr
  const title = pr
    ? `${esc(pr.title)} <span class="num">#${pr.number}</span>
      <span class="pr-links">
        <a class="btn icon invisible" href="${esc(pr.url)}" target="_blank" rel="noreferrer" title="Open on GitHub">${ICONS.github}</a>
        ${pr.graphiteUrl ? `<a class="btn icon invisible" href="${esc(pr.graphiteUrl)}" target="_blank" rel="noreferrer" title="Open on Graphite">${ICONS.graphite}</a>` : ''}
      </span>`
    : current?.draft?.title && current.branch === row.branch
      ? `${esc(current.draft.title)} <span class="num">no PR yet</span>`
      : esc(row.branch)
  const base = current?.parent ?? (prefs.compare === 'trunk' ? state.trunk : row.parent)
  const totals = files.reduce((sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }), { added: 0, removed: 0 })
  const order = stackRows()
  const index = order.findIndex(r => r.branch === selected)
  const pressed = on => `aria-pressed="${on}"`
  const allClosed = files.length > 0 && files.every(isCollapsed)
  $('#header').innerHTML = `
    ${
      pr
        ? prInfo(pr)
        : `<div class="pr-info"><span class="state none">No PR yet</span>
            <button class="btn small" data-act="submit-branch">Submit as draft PR</button></div>`
    }
    <h1>${title}</h1>
    <div class="meta">
      ${
        current?.mode === 'uncommitted'
          ? `${branchChip(row.branch)}<span title="receives">←</span><span class="chip">working copy</span>`
          : `${branchChip(base)}<span title="receives">←</span>${branchChip(row.branch)}`
      }
      <span>${files.length} file${files.length === 1 ? '' : 's'}</span>
      <span class="stat"><span class="add">+${totals.added}</span> <span class="del">−${totals.removed}</span></span>
      ${row.needsRestack ? '<span class="badge pending">Needs restack</span>' : ''}
      ${current?.mode === 'all' ? '<span class="badge pending">Includes uncommitted changes</span>' : ''}
      ${current?.mode === 'uncommitted' ? '<span class="badge pending">Uncommitted changes only</span>' : ''}
    </div>
    <div class="toolbar">
      <span class="segmented">
        <button data-format="split" ${pressed(prefs.format === 'split')}>Split</button>
        <button data-format="unified" ${pressed(prefs.format === 'unified')}>Unified</button>
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
      <button class="btn" data-act="comments" title="All comments">Comments</button>
      <button class="btn primary" data-act="review">Review${pendingCount() ? ` <span class="count">${pendingCount()}</span>` : ''}</button>
    </div>`
  paintLabels()
  document.documentElement.style.setProperty('--header-height', `${$('#header').offsetHeight}px`)
  updateIdentity()
  renderDescription()
}

function renderDiff() {
  $('#notice').textContent = current?.error ?? ''
  const paths = new Set(files.map(f => f.path))
  const gone = [
    ...new Set([
      ...comments.filter(c => !c.kind && !paths.has(c.path)).map(c => c.path),
      ...threadList().filter(t => !t.resolved && !paths.has(t.path)).map(t => t.path),
    ]),
  ]
  const orphans = gone
    .map(path => `<section class="file" data-file="${esc(path)}"><div class="file-head"><span class="path">${pathHtml(path)}</span><span class="badge">No longer changed</span></div>
      <div class="file-body">${strandedComments(path, () => false)}${strandedThreads(path, () => false, true)}</div></section>`)
    .join('')
  $('#diff').innerHTML = orphans + (files.length
    ? files.map(fileCard).join('')
    : current?.error
      ? ''
      : '<div class="empty-state">No changes on this branch.</div>')
}

function renderAll() {
  const scroll = window.scrollY
  renderHeader()
  renderSidebar()
  renderDiff()
  renderCommentViews()
  window.scrollTo(0, scroll)
}

function rerenderFile(path) {
  const file = files.find(f => f.path === path)
  const card = cardOf(path)
  if (file && card) card.outerHTML = fileCard(file)
  else if (!file) renderDiff()
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
  applyJump()
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

const pendingCount = () => comments.length

function persistComments() {
  store(`comments:${selected}`, comments.length ? comments : undefined)
}

function timeAgo(at) {
  const minutes = Math.round((Date.now() - (at ?? 0)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString()
}

function collect(kind) {
  return stackRows().flatMap(row => {
    const list = row.branch === selected ? (kind === 'comments' ? comments : sent) : stored(`${kind}:${row.branch}`, [])
    return list.map((comment, index) => ({ ...comment, branch: row.branch, index }))
  })
}

function commentItems(list, kind) {
  if (!list.length) return ''
  const groups = new Map()
  for (const comment of list) groups.set(comment.branch, [...(groups.get(comment.branch) ?? []), comment])
  let html = ''
  for (const [branch, items] of groups) {
    html += `<div class="group-head">${esc(branch)}</div>`
    for (const comment of items) {
      jumps.push(comment)
      html += `<div class="comment-item${kind === 'sent' ? ' sent' : ''}" data-jump="${jumps.length - 1}">
        <div class="where">${comment.kind === 'thread' ? '<span class="badge gh">GitHub</span>' : ''}<code>${
          comment.kind === 'description'
            ? 'PR description'
            : `${esc(comment.path)}:${comment.start && comment.start !== comment.line ? `${comment.start}–${comment.line}` : comment.line}`
        }</code>
          ${
            kind === 'sent'
              ? `${answerBadge(comment)}<span class="muted">${esc(timeAgo(comment.sentAt))}</span>`
              : `<button class="btn invisible delete-item" data-remove-at="${jumps.length - 1}" title="Delete this comment">Delete</button>`
          }</div>
        <div class="text">${esc(comment.text)}</div>${comment.note ? `<div class="text"><strong>You:</strong> ${esc(comment.note)}</div>` : ''}</div>`
    }
  }
  return html
}

function renderCommentViews() {
  jumps = []
  const pendingAll = collect('comments')
  const sentAll = collect('sent')
  const layer = pendingAll.filter(c => c.branch === selected)
  $('#submit-list').innerHTML = layer.length
    ? `<div class="list-head">${layer.length} pending comment${layer.length === 1 ? '' : 's'} on this layer</div>${commentItems(layer, 'pending')}`
    : '<div class="list-head muted">No line comments on this layer yet: drag over line numbers to add some.</div>'
  const elsewhere = pendingAll.length - layer.length
  if (elsewhere) {
    $('#submit-list').innerHTML += `<div class="empty-note">${elsewhere} more pending on other layers; open them to review them.</div>`
  }
  $('#comments-list').innerHTML =
    `<div class="list-head">Pending (${pendingAll.length})</div>${commentItems(pendingAll, 'pending') || '<div class="empty-note">Nothing pending.</div>'}` +
    `<div class="list-head">Sent to Claude (${sentAll.length})${sentAll.length ? '<button class="btn invisible" data-act="clear-sent">Clear</button>' : ''}</div>${commentItems(sentAll, 'sent') || '<div class="empty-note">Comments you send stay here as a history.</div>'}`
  const toggle = document.querySelector('[data-toggle="show-sent"]')
  if (toggle) toggle.checked = prefs.showSent
}

function applyJump() {
  const target = pendingJump
  if (!target || target.branch !== selected) return
  if (target.kind === 'description') {
    pendingJump = null
    $('#description').scrollIntoView({ block: 'start' })
    return
  }
  if (!files.length) return
  pendingJump = null
  const file = files.find(f => f.path === target.path)
  if (!file) return
  if (isCollapsed(file)) {
    collapsed.delete(file.path)
    if (isViewed(file)) collapsed.add(`open:${file.path}`)
    rerenderFile(file.path)
  }
  const cell = [...document.querySelectorAll('#diff td.ln[data-line]')].find(
    c => c.dataset.path === target.path && c.dataset.side === target.side && Number(c.dataset.line) === target.line,
  )
  if (!cell) {
    scrollToFile(target.path)
    return
  }
  const top = cell.getBoundingClientRect().top + window.scrollY - $('#header').offsetHeight - 120
  window.scrollTo({ top })
  cell.closest('tr').classList.add('flash')
  setTimeout(() => cell.closest('tr')?.classList.remove('flash'), 1600)
}

function jumpTo(target) {
  pendingJump = target
  if (target.branch === selected) applyJump()
  else select(target.branch)
}

function openComposer(target) {
  const existing = comments.find(c => c.kind !== 'thread' && sameTarget(c, target))
  const start = target.start ?? existing?.start ?? target.line
  const touched = new Set([target.path])
  composers = composers.filter(c => {
    const keep = (c.text ?? '').trim() && !sameTarget(c, target)
    if (!keep) touched.add(c.path)
    return keep
  })
  const box = { path: target.path, side: target.side, start, line: target.line, text: target.text ?? existing?.text ?? '', existing: !!existing }
  composers.push(box)
  touched.forEach(rerenderFile)
  const area = document.querySelector(`.composer[data-box="${CSS.escape(targetKey(box))}"] textarea`)
  area?.focus()
  area?.setSelectionRange(area.value.length, area.value.length)
  saveDraft()
}

function codeAt(range) {
  const file = files.find(f => f.path === range.path)
  const found = new Map()
  for (const hunk of file?.hunks ?? []) {
    for (const line of numberLines(hunk)) {
      if (covers(range, range.path, targetOf(line))) found.set(targetOf(line).line, line.text)
    }
  }
  const text = expansions.get(range.path)?.text?.split('\n')
  const out = []
  for (let n = range.start ?? range.line; n <= range.line; n++) {
    const line = found.get(n) ?? (range.side === 'new' ? text?.[n - 1] : undefined)
    if (line !== undefined) out.push(line)
  }
  return out.join('\n')
}

function saveComposer(composer) {
  if (!composer) return
  const text = document.querySelector(`.composer[data-box="${CSS.escape(targetKey(composer))}"] textarea`)?.value.trim() ?? composer.text?.trim() ?? ''
  const target = { path: composer.path, side: composer.side, line: composer.line }
  const range = composer.start !== composer.line ? { ...target, start: composer.start } : target
  comments = comments.filter(c => c.kind === 'thread' || !sameTarget(c, target))
  if (text) comments.push({ ...range, text, code: codeAt(range), base: current?.parent })
  comments.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  composers = composers.filter(c => c !== composer)
  persistComments()
  rerenderFile(target.path)
  renderHeader()
  renderCommentViews()
  saveDraft()
}

async function deliver(list) {
  ensureIds(list)
  const { id } = await api('/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'review',
      branch: selected,
      compareTo: current?.parent,
      includesUncommitted: !!current?.includeWorktree,
      summary: '',
      comments: list.map(c => ({ ...c, branch: selected })),
    }),
  })
  const result = await waitForDelivery(id, 30)
  if (result) return result
  const cancel = await api('/action-cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => null)
  return cancel?.delivered ? { ok: true } : null
}

async function sendNow(comment, button) {
  button.disabled = true
  button.textContent = 'Sending…'
  const result = await deliver([comment]).catch(() => null)
  if (!result) {
    button.disabled = false
    button.textContent = 'Retry sending'
    showTip(button, "Claude Code isn't reachable: the comment is kept")
    return false
  }
  sent = [...sent, { ...comment, sentAt: Date.now() }]
  store(`sent:${selected}`, sent)
  comments = comments.filter(c => c.kind === 'thread' || !sameTarget(c, comment))
  persistComments()
  rerenderFile(comment.path)
  renderHeader()
  renderCommentViews()
  showTip(document.querySelector('[data-act="review"]') ?? button, result.data?.queued ? 'Queued for Claude ✓' : 'Sent to Claude ✓')
  return true
}

async function sendComposerNow(button, composer) {
  if (!composer) return
  const text = button.closest('.composer')?.querySelector('textarea')?.value.trim() ?? ''
  if (!text) return
  const target = { path: composer.path, side: composer.side, line: composer.line }
  saveComposer(composer)
  const index = comments.findIndex(c => c.kind !== 'thread' && sameTarget(c, target))
  if (index < 0) return
  await sendNow(comments[index], document.querySelector(`[data-send-now="${index}"]`) ?? button)
}

function threadComment(thread, note = '') {
  const range = { path: thread.path, side: thread.side, ...(thread.start ? { start: thread.start } : {}), line: threadLine(thread) }
  return {
    kind: 'thread',
    ...range,
    text: thread.comments.map(c => `@${c.author}: ${c.body.trim().slice(0, 2000)}`).join('\n\n'),
    ...(note ? { note } : {}),
    code: thread.outdated ? '' : codeAt(range),
    base: current?.parent,
    thread: { id: thread.id, url: thread.comments[0]?.url ?? '' },
  }
}

function refreshThread(thread) {
  rerenderFile(thread.path)
  renderHeader()
  renderCommentViews()
}

async function fixThread(thread, button, note = '') {
  const comment = threadComment(thread, note)
  button.disabled = true
  button.textContent = 'Sending…'
  const result = await deliver([comment]).catch(() => null)
  if (!result) {
    button.disabled = false
    button.textContent = 'Retry'
    showTip(button, "Claude Code isn't reachable")
    return
  }
  comments = comments.filter(c => c.thread?.id !== thread.id)
  threadNotes = threadNotes.filter(n => n.id !== thread.id)
  persistComments()
  saveDraft()
  sent = [...sent, { ...comment, sentAt: Date.now() }]
  store(`sent:${selected}`, sent)
  refreshThread(thread)
  showTip(document.querySelector('[data-act="review"]') ?? button, result.data?.queued ? 'Queued for Claude ✓' : 'Sent to Claude ✓')
}

async function resolveThread(thread, button) {
  const resolve = !thread.resolved
  button.disabled = true
  button.textContent = resolve ? 'Resolving…' : 'Reopening…'
  threadErrors.delete(thread.id)
  const result = await runAction({ type: 'thread-resolve', threadId: thread.id, resolve, branch: selected }).catch(() => null)
  if (result?.ok) {
    thread.resolved = resolve
    openResolved.delete(thread.id)
  } else threadErrors.set(thread.id, result ? (result.message ?? 'GitHub refused the change') : 'Claude Code did not answer')
  refreshThread(thread)
}

function threadAct(button) {
  const thread = threadList().find(t => t.id === button.dataset.thread)
  const act = button.dataset.threadAct
  if (!thread) return
  if (act === 'toggle') {
    if (!openResolved.delete(thread.id)) openResolved.add(thread.id)
    refreshThread(thread)
  }
  if (act === 'add' || act === 'fix') {
    if (!noteAt(thread.id)) threadNotes.push({ id: thread.id, path: thread.path, text: comments.find(c => c.thread?.id === thread.id)?.note ?? '' })
    refreshThread(thread)
    saveDraft()
    const area = document.querySelector(`.thread-note[data-thread="${CSS.escape(thread.id)}"] textarea`)
    area?.focus()
    area?.setSelectionRange(area.value.length, area.value.length)
    return
  }
  if (act === 'note-add') {
    const note = noteAt(thread.id)?.text.trim() ?? ''
    comments = [...comments.filter(c => c.thread?.id !== thread.id), threadComment(thread, note)].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    threadNotes = threadNotes.filter(n => n.id !== thread.id)
    persistComments()
    refreshThread(thread)
    saveDraft()
  }
  if (act === 'note-cancel') {
    threadNotes = threadNotes.filter(n => n.id !== thread.id)
    refreshThread(thread)
    saveDraft()
  }
  if (act === 'note-fix') fixThread(thread, button, noteAt(thread.id)?.text.trim() ?? '')
  if (act === 'remove') {
    comments = comments.filter(c => c.thread?.id !== thread.id)
    persistComments()
    refreshThread(thread)
  }
  if (act === 'resolve') resolveThread(thread, button)
}

function insertSuggestion(composer, area) {
  if (!composer || !area) return
  const before = area.value.slice(0, area.selectionStart)
  const block = `${before && !before.endsWith('\n') ? '\n' : ''}\`\`\`suggestion\n${codeAt(composer)}\n\`\`\`\n`
  area.setRangeText(block, area.selectionStart, area.selectionEnd, 'end')
  area.focus()
  composer.text = area.value
  saveDraft()
}

function closeComposer(composer) {
  if (!composer) return
  composers = composers.filter(c => c !== composer)
  rerenderFile(composer.path)
  saveDraft()
}

function clearComments() {
  comments = []
  persistComments()
  renderAll()
}

async function waitForDelivery(id, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    const status = await api(`/action?id=${id}`).catch(() => null)
    if (status?.delivered) return status.result ?? { ok: true }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return null
}

async function submitBranch(button) {
  button.disabled = true
  button.textContent = 'Asking Claude…'
  const result = await runAction({ type: 'submit-branch', branch: selected }).catch(() => null)
  button.textContent = !result?.ok
    ? 'Claude Code did not answer'
    : result.data?.queued
      ? 'Queued for Claude ✓'
      : 'Claude is submitting it ✓'
  setTimeout(() => {
    if (!button.isConnected) return
    button.disabled = false
    button.textContent = 'Submit as draft PR'
  }, 5000)
}

async function setReady(button) {
  const ready = button.dataset.ready === 'true'
  const original = button.textContent
  button.disabled = true
  button.textContent = ready ? 'Marking ready…' : 'Converting…'
  try {
    const { id } = await api('/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'pr-ready', number: Number(button.dataset.number), ready }),
    })
    const result = await waitForDelivery(id)
    if (!result) button.textContent = 'Waiting for Claude Code…'
    else if (!result.ok) {
      button.textContent = 'Failed'
      button.title = result.message ?? ''
      $('#notice').textContent = `GitHub refused the change: ${result.message ?? 'unknown error'}`
    } else button.textContent = ready ? 'Ready ✓' : 'Draft ✓'
  } catch {
    button.textContent = 'Failed'
  }
  setTimeout(() => {
    if (!button.isConnected) return
    button.disabled = false
    button.textContent = original
  }, 4000)
}

function finishReview(pendingAll) {
  const sentAt = Date.now()
  sent = [...sent, ...pendingAll.map(({ branch, ...c }) => ({ ...c, sentAt }))]
  store(`sent:${selected}`, sent)
  $('#summary').value = ''
  saveDraft()
  clearComments()
}

async function sendReview() {
  const button = document.querySelector('#submit [data-act="send"]')
  const summary = $('#summary').value.trim()
  const pendingAll = collect('comments')
    .filter(c => c.branch === selected)
    .map(({ index, ...comment }) => comment)
  if (!pendingAll.length && !summary) {
    $('#summary').focus()
    return
  }
  const reset = (text, ms) =>
    setTimeout(() => {
      button.disabled = false
      button.textContent = 'Send to Claude'
    }, ms) && (button.textContent = text)
  button.disabled = true
  button.textContent = 'Sending…'
  ensureIds(pendingAll)
  let id
  try {
    ;({ id } = await api('/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'review',
        branch: selected,
        compareTo: current?.parent,
        includesUncommitted: !!current?.includeWorktree,
        summary,
        comments: pendingAll,
      }),
    }))
  } catch {
    reset("Couldn't send: retry", 2500)
    return
  }
  button.textContent = 'Waiting for Claude Code…'
  const result = await waitForDelivery(id, 30)
  if (result) {
    finishReview(pendingAll)
    const queued = result.data?.queued
    button.textContent = queued ? 'Queued: Claude reads it after its current task ✓' : 'Delivered to Claude ✓'
    setTimeout(() => {
      $('#submit').hidden = true
      button.disabled = false
      button.textContent = 'Send to Claude'
    }, queued ? 2500 : 1200)
    return
  }
  const cancel = await api('/action-cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => null)
  if (cancel?.delivered) {
    finishReview(pendingAll)
    reset('Delivered to Claude ✓', 1200)
    return
  }
  reset("Claude Code isn't reachable: your comments are kept, retry", 4000)
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {}
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.className = 'offscreen'
  document.body.append(field)
  field.select()
  const ok = document.execCommand('copy')
  field.remove()
  if (!ok) throw new Error('copy refused')
}

function showTip(anchor, text) {
  const rect = anchor.getBoundingClientRect()
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.textContent = text
  document.body.append(tip)
  tip.style.setProperty('--x', `${rect.left + rect.width / 2}px`)
  tip.style.setProperty('--y', `${rect.bottom + 6}px`)
  anchor.classList.add('copied')
  setTimeout(() => {
    tip.remove()
    anchor.classList.remove('copied')
  }, 1400)
}

/* reviewer picker */

let picker = null

async function runAction(body) {
  const { id } = await api('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return waitForDelivery(id)
}

function avatar(person) {
  const url = typeof person.avatarUrl === 'string' && MEDIA_HOSTS.test(person.avatarUrl) ? person.avatarUrl : ''
  return url ? `<img class="avatar" src="${esc(url)}" alt="">` : '<span class="avatar"></span>'
}

function renderPicker() {
  const box = $('#picker')
  if (!picker) {
    box.hidden = true
    return
  }
  const list = box.querySelector('.picker-list')
  const foot = box.querySelector('.picker-foot')
  if (picker.error) {
    list.innerHTML = `<div class="empty-note">${esc(picker.error)}</div>`
    return
  }
  if (!picker.data) {
    list.innerHTML = '<div class="empty-note">Loading people from GitHub…</div>'
    return
  }
  const query = picker.query.toLowerCase()
  const matches = p => !query || p.login.toLowerCase().includes(query) || (p.name ?? '').toLowerCase().includes(query)
  const reviewed = new Map(picker.data.reviewed.map(r => [r.login, r.state]))
  const seen = new Set()
  const take = people =>
    people.filter(p => {
      if (seen.has(p.login) || !matches(p)) return false
      seen.add(p.login)
      return true
    })
  const sections = [
    ['Suggestions', take(picker.data.suggestions)],
    ['Requested', take(picker.data.requested)],
    ['Everyone else', take([...picker.data.users, ...picker.extra])],
  ]
  const row = p => {
    const state = reviewed.get(p.login)
    return `<div class="person${picker.selected.has(p.login) ? ' selected' : ''}" data-person="${esc(p.login)}">
      <span class="check">${picker.selected.has(p.login) ? '✓' : ''}</span>${avatar(p)}
      <span><strong>${esc(p.login)}</strong> <span class="muted">${esc(p.name ?? '')}</span>
      ${state ? `<br><span class="muted small">${esc((REVIEW_STATES[state] ?? REVIEW_STATES.COMMENTED)[1])}: select to re-request</span>` : ''}</span></div>`
  }
  list.innerHTML =
    sections
      .filter(([, people]) => people.length)
      .map(([title, people]) => `<div class="picker-section">${title}</div>${people.map(row).join('')}`)
      .join('') || `<div class="empty-note">${picker.searching ? 'Searching…' : 'Nobody found.'}</div>`
  const added = [...picker.selected].filter(l => !picker.initial.has(l)).length
  const removed = [...picker.initial].filter(l => !picker.selected.has(l)).length
  foot.textContent = added || removed ? `${added} to add, ${removed} to remove: applied when you close this` : 'Close to apply'
}

async function openPicker(button) {
  const rect = button.getBoundingClientRect()
  const box = $('#picker')
  box.hidden = false
  box.style.setProperty('--top', `${rect.bottom + 6}px`)
  box.style.setProperty('--left', `${Math.max(8, Math.min(rect.left, window.innerWidth - 380))}px`)
  picker = { number: Number(button.dataset.number), query: '', selected: new Set(), initial: new Set(), extra: [], data: null }
  box.querySelector('input').value = ''
  box.querySelector('input').focus()
  renderPicker()
  const result = await runAction({ type: 'reviewers-load', number: picker.number }).catch(() => null)
  if (!picker) return
  if (!result?.ok) {
    picker.error = result?.message ?? 'Claude Code did not answer.'
  } else {
    picker.data = result.data
    picker.initial = new Set(result.data.requested.map(p => p.login))
    picker.selected = new Set(picker.initial)
  }
  renderPicker()
}

let searchTimer

function searchPicker(query) {
  picker.query = query
  renderPicker()
  clearTimeout(searchTimer)
  if (!query || !picker.data) return
  searchTimer = setTimeout(async () => {
    picker.searching = true
    renderPicker()
    const result = await runAction({ type: 'reviewers-load', number: picker.number, query }).catch(() => null)
    if (!picker) return
    picker.searching = false
    if (result?.ok) picker.extra = [...picker.extra, ...result.data.users]
    renderPicker()
  }, 350)
}

async function closePicker() {
  if (!picker) return
  const { number, selected, initial } = picker
  picker = null
  renderPicker()
  const add = [...selected].filter(l => !initial.has(l))
  const remove = [...initial].filter(l => !selected.has(l))
  if (!add.length && !remove.length) return
  $('#notice').textContent = 'Updating reviewers on GitHub…'
  const result = await runAction({ type: 'reviewers-set', number, add, remove }).catch(() => null)
  $('#notice').textContent = !result
    ? 'Claude Code did not answer: reviewers were not changed.'
    : result.ok
      ? ''
      : `GitHub refused the reviewer change: ${result.message ?? 'unknown error'}`
}

/* events */

document.addEventListener('click', event => {
  const t = event.target
  if (t.closest('td.ln[data-line]')) return
  if (picker && !t.closest('#picker') && !t.closest('[data-act="reviewers"]')) closePicker()
  const person = t.closest('#picker [data-person]')
  if (person && picker?.data) {
    const login = person.dataset.person
    if (picker.selected.has(login)) picker.selected.delete(login)
    else if (picker.selected.size < 15) picker.selected.add(login)
    renderPicker()
    return
  }
  const code = t.closest('#diff td.code:not(.empty)')
  if (code && window.getSelection()?.isCollapsed !== false) {
    let ln = code.previousElementSibling
    if (!ln?.dataset.line) ln = ln?.previousElementSibling
    if (ln?.dataset.line) {
      const at = cellTarget(ln)
      const last = composers.at(-1)
      const extend = event.shiftKey && last && last.path === at.path && last.side === at.side
      const start = extend ? Math.min(last.start, at.line) : at.line
      const end = extend ? Math.max(last.line, at.line) : at.line
      if (extend) composers = composers.filter(c => c !== last)
      const carry = extend ? last.text : undefined
      openComposer({ ...at, start, line: end, text: carry })
      return
    }
  }
  const head = t.closest('.file-head')
  const headToggle =
    head && !t.closest('button, label, input, a') && window.getSelection()?.isCollapsed !== false ? head.querySelector('[data-collapse]') : null
  const el = headToggle ?? t.closest('[data-uncommitted],[data-branch],[data-nav],[data-format],[data-compare],[data-act],[data-show],[data-expand],[data-collapse],[data-copy],[data-goto],[data-edit],[data-remove],[data-dismiss],[data-jump],[data-describe-edit],[data-send-now],[data-remove-at],[data-thread-act],[data-changes]')
  if (!t.closest('#submit') && !t.closest('[data-act="review"]')) $('#submit').hidden = true
  if (!el) return
  const d = el.dataset
  if (d.threadAct) return threadAct(el)
  if (d.changes) return toggleChanges(d.changes)
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
    copyText(d.copy).then(
      () => showTip(el, 'Copied to clipboard'),
      () => showTip(el, "Couldn't copy"),
    )
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
    renderCommentViews()
    renderDescriptionThreads()
  }
  if (d.dismiss) {
    const [comment] = sent.splice(Number(d.dismiss), 1)
    store(`sent:${selected}`, sent.length ? sent : undefined)
    if (comment) rerenderFile(comment.path)
    renderCommentViews()
    renderDescriptionThreads()
  }
  if (d.removeAt !== undefined) {
    const target = jumps[Number(d.removeAt)]
    if (!target) return
    if (target.branch === selected) {
      comments.splice(target.index, 1)
      persistComments()
    } else {
      const list = stored(`comments:${target.branch}`, [])
      list.splice(target.index, 1)
      store(`comments:${target.branch}`, list.length ? list : undefined)
    }
    renderAll()
    return
  }
  if (d.jump) {
    const target = jumps[Number(d.jump)]
    $('#submit').hidden = true
    if (target) jumpTo(target)
  }
  if (d.act === 'comments') {
    renderCommentViews()
    $('#comments-panel').hidden = !$('#comments-panel').hidden
  }
  if (d.act === 'close-comments') $('#comments-panel').hidden = true
  if (d.act === 'clear-sent') {
    for (const row of stackRows()) store(`sent:${row.branch}`, undefined)
    sent = []
    renderAll()
  }
  if (d.act === 'pr-ready') setReady(el)
  if (d.act === 'submit-branch') submitBranch(el)
  if (d.act === 'reviewers') {
    if (picker) closePicker()
    else openPicker(el)
  }
  if (d.act === 'describe') openDescribe(el.dataset.quote ?? descriptionSelection())
  if (d.act === 'describe-save') saveDescribe()
  if (d.act === 'describe-cancel') {
    describing = null
    renderDescriptionThreads()
    saveDraft()
  }
  if (d.describeEdit !== undefined) openDescribe('', Number(d.describeEdit))
  if (d.act === 'toggle-description') {
    descriptionOpen = !descriptionOpen
    renderDescription()
  }
  if (d.act === 'send-now') sendComposerNow(el, composerFor(el))
  if (d.sendNow !== undefined) {
    const comment = comments[Number(d.sendNow)]
    if (comment) sendNow(comment, el)
  }
  if (d.act === 'save') saveComposer(composerFor(el))
  if (d.act === 'cancel') closeComposer(composerFor(el))
  if (d.act === 'suggest') insertSuggestion(composerFor(el), el.closest('.composer')?.querySelector('textarea'))
  if (d.act === 'collapse-all') {
    const allClosed = files.every(isCollapsed)
    collapsed = new Set(allClosed ? files.filter(isViewed).map(f => `open:${f.path}`) : files.map(f => f.path))
    renderAll()
  }
  if (d.act === 'review') {
    renderCommentViews()
    $('#submit').hidden = !$('#submit').hidden
    if (!$('#submit').hidden) $('#summary').focus()
  }
  if (d.act === 'send') sendReview()
  if (d.act === 'discard') {
    clearComments()
    $('#submit').hidden = true
  }
})

let drag = null

const cellTarget = cell => ({ path: cell.dataset.path, side: cell.dataset.side, line: Number(cell.dataset.line) })

function paintDrag() {
  const from = Math.min(drag.start, drag.end)
  const to = Math.max(drag.start, drag.end)
  for (const cell of document.querySelectorAll('#diff td.ln[data-line]')) {
    const at = cellTarget(cell)
    cell.classList.toggle('in-range', at.path === drag.path && at.side === drag.side && from <= at.line && at.line <= to)
  }
}

document.addEventListener('mousedown', event => {
  const describe = event.target.closest('[data-act="describe"]')
  if (describe) describe.dataset.quote = descriptionSelection()
  const cell = event.button === 0 && event.target.closest('#diff td.ln[data-line]')
  if (!cell) return
  event.preventDefault()
  const at = cellTarget(cell)
  const last = composers.at(-1)
  const extend = event.shiftKey && last && last.path === at.path && last.side === at.side
  if (extend) composers = composers.filter(c => c !== last)
  drag = { path: at.path, side: at.side, start: extend ? last.start : at.line, end: at.line, text: extend ? last.text : undefined }
  document.body.classList.add('selecting')
  paintDrag()
})

document.addEventListener('mouseover', event => {
  if (!drag) return
  const row = event.target.closest('#diff tr')
  const cell = [...(row?.querySelectorAll('td.ln[data-line]') ?? [])].find(
    c => c.dataset.path === drag.path && c.dataset.side === drag.side,
  )
  if (!cell) return
  const at = cellTarget(cell)
  if (at.path !== drag.path || at.side !== drag.side || at.line === drag.end) return
  drag.end = at.line
  paintDrag()
})

document.addEventListener('mouseup', () => {
  if (!drag) return
  const { path, side, start, end, text } = drag
  drag = null
  document.body.classList.remove('selecting')
  openComposer({ path, side, start: Math.min(start, end), line: Math.max(start, end), text })
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
  if (t.dataset.toggle === 'show-sent') {
    prefs.showSent = t.checked
    store('showSent', t.checked ? undefined : false)
    renderDiff()
  }
})

document.addEventListener('keydown', event => {
  if (event.target.closest('#picker input')) {
    if (event.key === 'Escape') closePicker()
    return
  }
  if (event.target.closest('#description .composer textarea')) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveDescribe()
    if (event.key === 'Escape') {
      describing = null
      renderDescriptionThreads()
      saveDraft()
    }
    return
  }
  const noteArea = event.target.closest('.thread-note textarea')
  if (noteArea) {
    const id = noteArea.closest('.thread-note').dataset.thread
    const act = event.key === 'Escape' ? 'note-cancel' : event.key === 'Enter' && (event.metaKey || event.ctrlKey) ? 'note-add' : ''
    if (act) threadAct({ dataset: { thread: id, threadAct: act } })
    return
  }
  if (event.target.closest('.composer textarea')) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveComposer(composerFor(event.target))
    if (event.key === 'Escape') closeComposer(composerFor(event.target))
    return
  }
  if (event.target.closest('textarea, input')) {
    if (event.target.id === 'summary' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendReview()
    if (event.key === 'Escape') $('#submit').hidden = true
    return
  }
  if (event.key === 'Escape') {
    $('#submit').hidden = true
    closePicker()
  }
  if (event.key === '[') navigate(-1)
  if (event.key === ']') navigate(1)
})

document.addEventListener('input', event => {
  const area = event.target
  if (area.id === 'summary') saveDraft()
  if (area.closest?.('.thread-note')) {
    const note = noteAt(area.closest('.thread-note').dataset.thread)
    if (note) note.text = area.value
    saveDraft()
  } else if (area.closest?.('#description .composer') && describing) {
    describing.text = area.value
    saveDraft()
  } else if (composerFor(area)) {
    composerFor(area).text = area.value
    saveDraft()
  }
  if (event.target.closest('#picker input') && picker) searchPicker(event.target.value.trim())
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
      const threadsWere = JSON.stringify(selectedRow()?.pr?.threads)
      state = { ...next, rows: next.rows ?? [] }
      if (!state.rows.some(r => r.branch === selected && !r.isTrunk)) {
        const fallback = state.rows.find(r => r.isCurrent && !r.isTrunk) ?? stackRows()[0]
        selected = ''
        if (fallback) select(fallback.branch)
      }
      renderStack()
      if (applyReplies() && renderedKey) composers.length || threadNotes.length ? renderCommentViews() : renderAll()
      const threadsChanged = JSON.stringify(selectedRow()?.pr?.threads) !== threadsWere
      if (!(composers.length || threadNotes.length) || !renderedKey) loadDiff(restarted).then(() => threadsChanged && !restarted && renderAll())
    } catch {
      $('#connection').className = 'connection offline'
      $('#connection').title = 'Disconnected: waiting for Claude Code'
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
}

comments = stored(`comments:${selected}`, [])
sent = stored(`sent:${selected}`, [])
restoreDraft()
poll()
