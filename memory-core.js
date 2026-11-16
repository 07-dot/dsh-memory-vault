/**
 * 记忆库核心逻辑：与 Harness 无关的纯 Node 模块。
 * 负责：扫描 Obsidian 记忆库、解析 frontmatter、中文 n-gram 打分、生成注入文本、体检。
 * 这里所有 I/O 都是同步的，因为 prompt context 的 text 回调必须是同步函数。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const NOTE_EXT = '.md'
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules'])

/** 记忆库里被视为「常驻核心」的笔记（相对路径，正斜杠）。 */
export const DEFAULT_CORE_FILES = [
  '记忆库首页.md',
  '01-个人档案/个人概况.md',
  '01-个人档案/偏好与习惯.md',
  '02-目标与进展/目标总览.md',
]

export const DEFAULT_OPTIONS = {
  vault: process.env.DSH_MEMORY_VAULT ?? '',
  coreFiles: DEFAULT_CORE_FILES,
  coreBudget: 900,
  matchCount: 3,
  matchBudget: 1300,
  minScore: 2.5,
  staleDays: 45,
  inboxRel: '04-收件箱.md',
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '需要', '一个', '一下',
  '现在', '就是', '还是', '如果', '因为', '所以', '但是', '然后', '已经', '没有', '不是',
  '帮我', '我的', '你的', '这些', '那些', '这样', '那样', '如何', '为什', '么样', '能否',
  '请你', '希望', '进行', '对于', '关于', '以及', '并且', '或者', '另外', '同时', '通过',
])

// ---------------------------------------------------------------- 扫描与解析

/** 递归列出笔记文件（相对 vault 的正斜杠路径 + mtime）。 */
export function listNoteFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(NOTE_EXT)) continue
      let mtimeMs = 0
      try {
        mtimeMs = statSync(full).mtimeMs
      } catch {
        /* ignore */
      }
      out.push({ rel: relative(root, full).split(sep).join('/'), full, mtimeMs })
    }
  }
  walk(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))
}

/** 拆分 frontmatter（支持 `tags:` 竖排列表）。 */
export function parseFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '')
  const data = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(src)
  if (!m) return { data, body: src }
  const lines = m[1].split(/\r?\n/)
  let listKey = null
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey) {
      const value = cleanScalar(item[1])
      if (value) {
        if (!Array.isArray(data[listKey])) data[listKey] = []
        data[listKey].push(value)
      }
      continue
    }
    const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].trim()
    const value = kv[2].trim()
    if (value === '') {
      listKey = key
      data[key] = []
      continue
    }
    listKey = null
    data[key] = cleanScalar(value)
  }
  return { data, body: src.slice(m[0].length) }
}

function cleanScalar(value) {
  let v = String(value).trim()
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1)
  v = v.replace(/^["']/, '').replace(/["']$/, '').trim()
  return v
}

function tagsOf(data) {
  const raw = data.tags ?? data.tag
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw) return raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  return []
}

/** 把一条笔记解析成索引记录。 */
export function parseNote(file) {
  let text = ''
  try {
    text = readFileSync(file.full, 'utf8')
  } catch {
    return null
  }
  const { data, body } = parseFrontmatter(text)
  const title = file.rel.replace(/\.md$/i, '').split('/').pop()
  const updated = normalizeDate(data.更新日期 ?? data.更新 ?? data.date)
  return {
    rel: file.rel,
    title: typeof data.title === 'string' && data.title ? data.title : title,
    type: typeof data.类型 === 'string' ? data.类型 : '',
    status: typeof data.状态 === 'string' ? data.状态 : '',
    updated,
    tags: tagsOf(data),
    mtimeMs: file.mtimeMs,
    chars: text.length,
    text,
    body,
    headings: extractHeadings(body),
  }
}

function normalizeDate(value) {
  if (!value) return ''
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value))
  if (!m) return ''
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function extractHeadings(body) {
  const out = []
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+)$/.exec(line.trim())
    if (m) out.push(m[1].trim())
  }
  return out
}

// ---------------------------------------------------------------- 索引与缓存

let cache = { root: '', stamp: '', at: 0, index: null }

/** 构建（或复用缓存中的）记忆库索引。stamp 由文件数与最新 mtime 组成。 */
export function getIndex(options, { force = false, ttlMs = 3000 } = {}) {
  const root = options.vault
  const now = Date.now()
  if (!force && cache.index && cache.root === root && now - cache.at < ttlMs) return cache.index
  let stamp = ''
  try {
    const files = listNoteFiles(root)
    stamp = files.length + ':' + files.reduce((acc, f) => Math.max(acc, f.mtimeMs), 0)
    if (!force && cache.index && cache.root === root && cache.stamp === stamp && now - cache.at < ttlMs) {
      cache.at = now
      return cache.index
    }
    const notes = files.map(parseNote).filter(Boolean)
    const index = {
      root,
      notes,
      byRel: new Map(notes.map((n) => [n.rel, n])),
      byName: new Map(notes.map((n) => [n.rel.replace(/\.md$/i, '').split('/').pop(), n])),
      core: extractCore(notes, options),
      builtAt: now,
    }
    cache = { root, stamp, at: now, index }
    return index
  } catch {
    return cache.index && cache.root === root ? cache.index : emptyIndex(root)
  }
}

export function emptyIndex(root = '') {
  return { root, notes: [], byRel: new Map(), byName: new Map(), core: [], builtAt: Date.now() }
}

export function resetCache() {
  cache = { root: '', stamp: '', at: 0, index: null }
}

// ---------------------------------------------------------------- 核心档案提取

function sectionLines(body, headingKeyword) {
  const lines = body.split(/\r?\n/)
  const out = []
  let inside = false
  let level = 0
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+)$/.exec(line.trim())
    if (h) {
      if (inside) break
      if (h[2].includes(headingKeyword)) {
        inside = true
        level = h[1].length
      }
      continue
    }
    if (inside) out.push(line)
  }
  return level > 0 ? out : []
}

/** 从一节里取两列表格的行：`| 键 | 值 |`。 */
function tablePairs(lines) {
  const pairs = []
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue
    const key = stripMd(cells[0])
    const value = stripMd(cells[1])
    if (!key || !value) continue
    if (key === '项目' || key === '维度' || key === '字段') continue
    // 占位内容（如「待填 → 个人概况」）不算事实，不进核心档案
    if (/^(待填|待确认|todo|tbd|—|-)/i.test(value)) continue
    pairs.push([key, value])
  }
  return pairs
}

function stripMd(value) {
  return String(value)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|__|==|~~/g, '')
    .replace(/^>+\s*/, '')
    .trim()
}

function numberedItems(lines) {
  const out = []
  for (const line of lines) {
    const t = line.trim()
    const m = /^(\d+)[.、)]\s*(.+)$/.exec(t) ?? /^[-*]\s+(.+)$/.exec(t)
    if (!m) continue
    const value = stripMd(m[2] ?? m[1] ?? '')
    if (!value || /^(待填|待确认|todo|tbd)/i.test(value)) continue
    out.push(value)
  }
  return out
}

/** 生成「常驻核心」的键值行。 */
export function extractCore(notes, options = DEFAULT_OPTIONS) {
  const wanted = options.coreFiles ?? DEFAULT_CORE_FILES
  const lines = []
  const seen = new Set()
  const push = (label, value) => {
    const key = label + '=' + value
    if (seen.has(key)) return
    seen.add(key)
    lines.push(`${label}：${value}`)
  }
  for (const rel of wanted) {
    const note = notes.find((n) => n.rel === rel)
    if (!note) continue
    if (rel.endsWith('记忆库首页.md')) {
      const focus = tablePairs(sectionLines(note.body, '速读区'))
      for (const [k, v] of focus) push(k, v)
      continue
    }
    if (rel.includes('个人概况')) {
      for (const [k, v] of tablePairs(sectionLines(note.body, '基本信息'))) push(k, v)
      continue
    }
    if (rel.includes('偏好与习惯')) {
      const seenSection = ['沟通偏好', '雷区']
      for (const head of seenSection) {
        for (const [k, v] of tablePairs(sectionLines(note.body, head))) push(k, v)
      }
      const mine = numberedItems(sectionLines(note.body, '雷区'))
      if (mine.length) push('雷区', mine.slice(0, 3).join('；'))
      continue
    }
    if (rel.includes('目标总览')) {
      const items = numberedItems(sectionLines(note.body, '本月聚焦'))
      if (items.length) push('本月重点', items.slice(0, 3).join('；'))
    }
  }
  return lines
}

// ---------------------------------------------------------------- 分词与检索

/** 中文按 2-gram（必要时补 3-gram），拉丁按词。 */
export function tokenize(text) {
  const grams = new Set()
  const normalized = String(text ?? '')
  for (const word of normalized.toLowerCase().match(/[a-z][a-z0-9+#._-]{1,}/g) ?? []) {
    if (word.length >= 2) grams.add(word)
  }
  for (const run of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) continue
    for (let i = 0; i < run.length - 1; i++) {
      const gram = run.slice(i, i + 2)
      if (!STOP.has(gram)) grams.add(gram)
    }
    if (run.length >= 3) {
      for (let i = 0; i < run.length - 2; i++) grams.add(run.slice(i, i + 3))
    }
  }
  return grams
}

function countHits(haystack, grams) {
  let hits = 0
  for (const gram of grams) {
    if (haystack.includes(gram)) hits++
  }
  return hits
}

/** 按任务文本给笔记打分，返回前 limit 条。模板是脚手架，不参与检索。 */
export function match(index, query, limit = 3, minScore = 2.5, options = {}) {
  const grams = tokenize(query)
  if (grams.size === 0) return []
  const skipTemplates = options.skipTemplates !== false
  const scored = []
  for (const note of index.notes) {
    if (skipTemplates && /(^|\/)05-模板\//.test(note.rel)) continue
    const titleHits = countHits(note.title, grams)
    const tagHits = countHits(note.tags.join(' '), grams)
    const headHits = countHits(note.headings.join(' '), grams)
    const bodyHits = countHits(note.body, grams)
    const score = titleHits * 6 + tagHits * 4 + headHits * 1.5 + Math.min(bodyHits, 12) * 0.5
    if (score < minScore) continue
    scored.push({ note, score })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0].score
  const floor = Math.max(minScore, best * 0.35)
  return scored
    .filter((s) => s.score >= floor)
    .slice(0, limit)
    .map((s) => ({ ...s, excerpt: excerptFor(s.note, grams) }))
}

function excerptFor(note, grams) {
  const flat = note.body.replace(/\s+/g, ' ').trim()
  let at = -1
  for (const gram of grams) {
    const i = flat.indexOf(gram)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return tidyExcerpt(flat.slice(0, 160))
  const start = Math.max(0, at - 40)
  const end = Math.min(flat.length, at + 160)
  return (start > 0 ? '…' : '') + tidyExcerpt(flat.slice(start, end)) + (end < flat.length ? '…' : '')
}

/** 去掉摘录里的 Markdown 噪声，只留可读文字。 */
function tidyExcerpt(text) {
  return String(text)
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\*\*|__|`|==|~~/g, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- 注入文本

function clip(text, budget) {
  if (text.length <= budget) return text
  return text.slice(0, Math.max(0, budget - 1)) + '…'
}

/** 生成注入到系统提示里的「长期记忆」块。query 为空时只给核心档案。 */
export function renderMemoryBlock(index, query, options = DEFAULT_OPTIONS) {
  if (!index.notes.length) return ''
  const coreBudget = options.coreBudget ?? DEFAULT_OPTIONS.coreBudget
  const matchBudget = options.matchBudget ?? DEFAULT_OPTIONS.matchBudget
  const parts = []
  if (index.core.length) {
    parts.push('### 核心档案\n' + clip(index.core.map((l) => `- ${l}`).join('\n'), coreBudget))
  }
  const hits = query ? match(index, query, options.matchCount ?? 3, options.minScore ?? 2.5, options) : []
  if (hits.length) {
    const lines = hits.map(({ note, excerpt }) => {
      const meta = [note.type, note.status, note.updated].filter(Boolean).join(' · ')
      return `- ${note.rel.replace(/\.md$/i, '')}${meta ? `（${meta}）` : ''}：${clip(excerpt, 260)}`
    })
    parts.push('### 与当前任务相关\n' + clip(lines.join('\n'), matchBudget))
  }
  if (!parts.length) return ''
  const inbox = inboxPending(index, options)
  const tail = [
    inbox > 0 ? `> 记忆库收件箱还有 ${inbox} 条待整理。` : '',
    '> 需要更多细节调用 memory_recall；要记新信息调用 memory_note；结构体检调用 memory_health。',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    '## 长期记忆（自动检索自 Obsidian 记忆库）',
    '以下是用户的长期档案与本次任务相关的记忆条目，按需采用，不要复述本文。',
    ...parts,
    tail,
  ].join('\n\n')
}

// ---------------------------------------------------------------- 体检

export function inboxPending(index, options = DEFAULT_OPTIONS) {
  const rel = options.inboxRel ?? DEFAULT_OPTIONS.inboxRel
  const note = index.byRel.get(rel)
  if (!note) return 0
  const section = sectionLines(note.body, '待整理')
  const source = section.length ? section : note.body.split(/\r?\n/)
  let count = 0
  for (const line of source) {
    const m = /^\s*-\s*\[ \]\s*(.+)$/.exec(line)
    if (m && stripMd(m[1])) count++
  }
  return count
}

/**
 * 收集记忆库之外（同一个 Obsidian 仓库里）的笔记名。
 * 记忆库允许用双链指向仓库其他笔记，断链检查必须认得它们。
 */
export function collectOutsideNames(linkRoot, excludeRoot, limit = 3000) {
  const names = new Set()
  if (!linkRoot || linkRoot === excludeRoot) return names
  const walk = (dir, depth) => {
    if (depth > 8 || names.size >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (names.size >= limit) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (resolve(full) === resolve(excludeRoot)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.name.toLowerCase().endsWith(NOTE_EXT)) continue
      const rel = relative(linkRoot, full).split(sep).join('/').replace(/\.md$/i, '')
      names.add(rel)
      names.add(rel.split('/').pop())
    }
  }
  walk(linkRoot, 0)
  return names
}

/** 记忆库结构体检：收件箱积压、过期、重复候选、断链、frontmatter 缺失。 */
export function health(index, options = DEFAULT_OPTIONS) {
  const staleDays = options.staleDays ?? DEFAULT_OPTIONS.staleDays
  const today = new Date()
  const stale = []
  const missingMeta = []
  const isTemplate = (rel) => /(^|\/)05-模板\//.test(rel)
  const linkIndex = new Map()
  for (const note of index.notes) {
    linkIndex.set(note.rel.replace(/\.md$/i, ''), note.rel)
    linkIndex.set(note.title, note.rel)
  }
  const linkRoot = options.linkRoot ?? (index.root ? dirname(index.root) : '')
  const outside = collectOutsideNames(linkRoot, index.root, options.linkScanLimit ?? 3000)
  const brokenLinks = []
  const duplicateCandidates = []

  for (const note of index.notes) {
    if (!note.type) missingMeta.push({ rel: note.rel, missing: '类型' })
    else if (!note.updated && note.type !== '规则' && note.type !== '记忆库首页' && !isTemplate(note.rel)) {
      missingMeta.push({ rel: note.rel, missing: '更新日期' })
    }
    if (note.updated && note.type === '目标' && !isTemplate(note.rel)) {
      const age = (today - new Date(note.updated + 'T00:00:00')) / 86400000
      if (Number.isFinite(age) && age > staleDays) {
        stale.push({ rel: note.rel, updated: note.updated, ageDays: Math.round(age) })
      }
    }
    for (const m of note.body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const target = m[1].trim().replace(/\\/g, '/')
      if (!target || target.startsWith('待建')) continue
      const base = target.split('/').pop()
      const known =
        linkIndex.has(target) || linkIndex.has(base) || outside.has(target) || outside.has(base)
      if (!known) brokenLinks.push({ from: note.rel, target })
    }
  }

  for (let i = 0; i < index.notes.length; i++) {
    for (let j = i + 1; j < index.notes.length; j++) {
      const a = index.notes[i]
      const b = index.notes[j]
      if (isTemplate(a.rel) || isTemplate(b.rel)) continue
      if (a.title.includes(b.title) || b.title.includes(a.title)) {
        duplicateCandidates.push([a.rel, b.rel, '标题互相包含'])
        continue
      }
      if (a.tags.length && b.tags.length) {
        const sa = new Set(a.tags)
        const sb = new Set(b.tags)
        const inter = [...sa].filter((t) => sb.has(t)).length
        const union = new Set([...sa, ...sb]).size
        if (union > 0 && inter / union >= 0.8) duplicateCandidates.push([a.rel, b.rel, '标签高度重合'])
      }
    }
  }

  return {
    vault: index.root,
    notes: index.notes.length,
    chars: index.notes.reduce((acc, n) => acc + n.chars, 0),
    inboxPending: inboxPending(index, options),
    stale,
    missingMeta,
    brokenLinks,
    duplicateCandidates,
    builtAt: new Date(index.builtAt).toISOString(),
  }
}

/** 把体检结果渲染成给人/模型看的一段文字。 */
export function renderHealth(report) {
  const lines = [
    `记忆库：${report.vault}`,
    `笔记 ${report.notes} 条，约 ${report.chars} 字；收件箱待整理 ${report.inboxPending} 条`,
  ]
  const section = (title, items, fmt) => {
    if (!items.length) return
    lines.push('', `### ${title}`)
    for (const item of items.slice(0, 12)) lines.push('- ' + fmt(item))
  }
  section('过期目标（超过阈值未更新）', report.stale, (x) => `${x.rel}：更新于 ${x.updated}，已 ${x.ageDays} 天`)
  section('待整理（收件箱）', report.inboxPending ? [report.inboxPending] : [], (n) => `有 ${n} 条未归位`)
  section('frontmatter 缺失', report.missingMeta, (x) => `${x.rel}：缺 ${x.missing}`)
  section('断链', report.brokenLinks, (x) => `${x.from} → [[${x.target}]] 不存在`)
  section('重复候选', report.duplicateCandidates, (x) => `${x[0]} ↔ ${x[1]}（${x[2]}）`)
  if (lines.length <= 3) lines.push('', '体检通过：没有发现结构问题。')
  return lines.join('\n')
}
