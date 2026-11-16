/**
 * 记忆库插件（Host 侧）：把 Obsidian 长期记忆库接进 Harness。
 *
 * 两件事：
 * 1. 每个 Agent 创建时挂一个 scoped prompt context —— 每轮组装提示词时，
 *    按当前任务文本从记忆库里检索相关条目，连同常驻核心档案一起注入。
 * 2. 注册三个工具：memory_recall（检索）、memory_note（写入）、memory_health（体检）。
 *
 * 检索与体检逻辑在 memory-core.js，那里不依赖 Harness，可单独测试。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import * as coreModule from './memory-core.js'

export const name = 'memory-vault'
export const inject = ['systemPrompt', 'tools']

/** 按任务文本检索并注入的提示词上下文。 */
const CONTEXT_ORDER = 900
const CONTEXT_NAME = 'memory-vault'



function resolveOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const vault = String(raw.vault || process.env.DSH_MEMORY_VAULT || coreModule.DEFAULT_OPTIONS.vault)
  const options = { ...coreModule.DEFAULT_OPTIONS, ...raw, vault }
  options.coreBudget = Number(options.coreBudget) || coreModule.DEFAULT_OPTIONS.coreBudget
  options.matchCount = Number(options.matchCount) || coreModule.DEFAULT_OPTIONS.matchCount
  options.matchBudget = Number(options.matchBudget) || coreModule.DEFAULT_OPTIONS.matchBudget
  options.minScore = Number(options.minScore) || coreModule.DEFAULT_OPTIONS.minScore
  options.staleDays = Number(options.staleDays) || coreModule.DEFAULT_OPTIONS.staleDays
  if (!Array.isArray(options.coreFiles) || options.coreFiles.length === 0) {
    options.coreFiles = coreModule.DEFAULT_CORE_FILES
  }
  return options
}

/** 从一条用户消息里取出纯文本。 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (typeof block === 'string') parts.push(block)
    else if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 覆盖写入时自动把 frontmatter 里的 更新日期 改成今天。 */
function touchUpdated(text) {
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) return text
  const day = today()
  if (/(^|\n)更新日期\s*:/.test(text)) {
    return text.replace(/(^|\n)(更新日期\s*:\s*)[^\r\n]*/, `$1$2${day}`)
  }
  return text.replace(/^---\r?\n/, `---\n更新日期: ${day}\n`)
}

/** 把相对路径限制在记忆库目录内。 */
function resolveInside(vault, relPath) {
  const base = resolve(vault)
  const candidate = String(relPath ?? '').trim()
  if (!candidate) throw new Error('缺少 path 参数')
  if (/^[a-zA-Z]:/.test(candidate) || candidate.startsWith('\\\\') || candidate.startsWith('/')) {
    throw new Error('path 必须是记忆库内的相对路径，例如 02-目标与进展/目标-护资.md')
  }
  const target = resolve(base, candidate)
  if (target !== base && !target.startsWith(base + sep)) throw new Error('path 越出了记忆库目录')
  return target
}

function toPosix(p) {
  return p.split(sep).join('/')
}

function ensureMd(target) {
  return target.toLowerCase().endsWith('.md') ? target : target + '.md'
}

export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  if (!options.vault) {
    console.warn(
      '[memory-vault] 未配置 vault：记忆注入已停用。推荐把记忆库存放在一个 Obsidian 库里，' +
        '再把插件配置的 vault 或环境变量 DSH_MEMORY_VAULT 指向那个文件夹。',
    )
  }
  /** 每个 Agent 最近一条用户消息，用于按任务检索。 */
  const lastTask = new Map()
  /** Agent 上的 context 需要自己持有 disposer，插件卸载时一并释放。 */
  const agentDisposers = new Map()
  /** 同一 agent + 同一任务文本只渲染一次。 */
  const renderCache = new Map()

  const vaultReady = () => {
    try {
      return existsSync(options.vault)
    } catch {
      return false
    }
  }

  const renderFor = (agentId) => {
    try {
      if (!vaultReady()) return ''
      const task = lastTask.get(agentId) ?? ''
      const key = agentId + '\u0000' + task
      const cached = renderCache.get(key)
      if (cached !== undefined) return cached
      const index = coreModule.getIndex(options)
      const text = coreModule.renderMemoryBlock(index, task, options)
      if (renderCache.size > 200) renderCache.clear()
      renderCache.set(key, text)
      return text
    } catch {
      return ''
    }
  }

  // ---- 每个 Agent 挂一个 scoped prompt context ----
  ctx.on('agent/created', ({ agent }) => {
    try {
      const agentCtx = agent?.ctx
      if (!agentCtx || typeof agentCtx.systemPrompt?.context !== 'function') return
      const agentId = agent.id
      const dispose = agentCtx.effect(() => {
        const off = agentCtx.systemPrompt.context({
          name: CONTEXT_NAME,
          order: CONTEXT_ORDER,
          text: () => renderFor(agentId),
        })
        return () => {
          off()
        }
      })
      agentDisposers.set(agentId, dispose)
    } catch {
      /* 注入失败不应影响会话创建 */
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const agentId = agent?.id
    if (!agentId) return
    const dispose = agentDisposers.get(agentId)
    agentDisposers.delete(agentId)
    lastTask.delete(agentId)
    if (typeof dispose === 'function') {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const agentId = agent?.id
    if (!agentId) return
    const text = messageText(message)
    if (text) lastTask.set(agentId, text)
  })

  // ---- 工具 ----
  const textOutput = (description) => ({
    schema: { type: 'string', description },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  })

  ctx.tools.register({
    name: 'memory_recall',
    description:
      '在用户的 Obsidian 长期记忆库中检索条目。用于回忆用户的档案、偏好、目标、过往项目结论。' +
      '当对话涉及「我是谁、我以前怎么决定的、我做过什么」而当前上下文没有足够信息时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索用的自然语言，通常就是当前任务的一句话概括' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 10' },
        full: { type: 'boolean', description: '为 true 时返回命中条目的正文（截断至 4000 字），默认 false 只给摘要' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOutput('检索结果，Markdown 文本'),
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const query = String(input.query ?? '').trim()
      if (!query) throw new Error('query 不能为空')
      if (!vaultReady()) throw new Error(`记忆库路径不可用：${options.vault || '（未配置）'}。请在插件配置的 vault 或环境变量 DSH_MEMORY_VAULT 中填写记忆库文件夹。`)
      const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10)
      const index = coreModule.getIndex(options, { force: true })
      const hits = coreModule.match(index, query, limit, options.minScore, options)
      if (!hits.length) {
        return `没有匹配到与「${query}」相关的记忆条目。记忆库共 ${index.notes.length} 条笔记。`
      }
      const lines = [`命中 ${hits.length} 条（记忆库共 ${index.notes.length} 条）：`, '']
      hits.forEach((hit, i) => {
        const meta = [hit.note.type, hit.note.status, hit.note.updated].filter(Boolean).join(' · ')
        lines.push(`### ${i + 1}. ${hit.note.rel}${meta ? `（${meta}）` : ''}`)
        lines.push(hit.excerpt)
        if (input.full) {
          lines.push('')
          lines.push('```markdown')
          lines.push(hit.note.text.slice(0, 4000))
          lines.push('```')
        }
        lines.push('')
      })
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'memory_note',
    description:
      '向用户的 Obsidian 长期记忆库写入笔记（无需额外授权）。用于「记住这件事」：更新档案、追加目标进展、' +
      '记录项目结论、或往收件箱丢一条待整理信息。覆盖已有条目前先确认它应该被更新而不是新建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '记忆库内的相对路径，如 01-个人档案/个人概况.md；省略 .md 会自动补上' },
        content: { type: 'string', description: '完整 Markdown 内容（overwrite 时即全文）' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append', 'create'],
          description: 'overwrite 覆盖（自动改 更新日期）；append 追加；create 仅当文件不存在时新建。默认 overwrite',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    output: textOutput('写入结果说明'),
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      if (!vaultReady()) throw new Error(`记忆库路径不可用：${options.vault || '（未配置）'}。请在插件配置的 vault 或环境变量 DSH_MEMORY_VAULT 中填写记忆库文件夹。`)
      const mode = ['overwrite', 'append', 'create'].includes(input.mode) ? input.mode : 'overwrite'
      const target = ensureMd(resolveInside(options.vault, input.path))
      const exists = existsSync(target)
      const content = String(input.content ?? '')
      if (!content.trim()) throw new Error('content 不能为空')
      if (mode === 'create' && exists) throw new Error(`文件已存在：${toPosix(target)}`)
      mkdirSync(dirname(target), { recursive: true })
      if (mode === 'append') {
        const prev = exists ? readFileSync(target, 'utf8') : ''
        const patch = (prev.endsWith('\n') || prev === '' ? '' : '\n') + content.trimEnd() + '\n'
        writeFileSync(target, prev + patch, 'utf8')
      } else {
        writeFileSync(target, touchUpdated(content), 'utf8')
      }
      coreModule.resetCache()
      renderCache.clear()
      const rel = toPosix(target).replace(toPosix(resolve(options.vault)) + '/', '')
      return `${mode === 'append' ? '已追加' : exists ? '已覆盖' : '已新建'}：${rel}（${content.length} 字）`
    },
  })

  ctx.tools.register({
    name: 'memory_health',
    description:
      '对 Obsidian 长期记忆库做结构体检：收件箱积压、过期目标、frontmatter 缺失、断链、重复候选。' +
      '每周维护、或用户问「记忆库现在怎么样」时调用；拿到报告后再决定合并、精简或补全。',
    parameters: {
      type: 'object',
      properties: {
        staleDays: { type: 'number', description: '目标类条目多少天未更新算过期，默认 45' },
      },
      additionalProperties: false,
    },
    output: textOutput('体检报告，Markdown 文本'),
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      if (!vaultReady()) throw new Error(`记忆库路径不可用：${options.vault || '（未配置）'}。请在插件配置的 vault 或环境变量 DSH_MEMORY_VAULT 中填写记忆库文件夹。`)
      const local = { ...options }
      if (Number(input.staleDays) > 0) local.staleDays = Number(input.staleDays)
      const index = coreModule.getIndex(local, { force: true })
      const report = coreModule.health(index, local)
      return coreModule.renderHealth(report)
    },
  })

  // ---- 卸载时释放 ----
  ctx.effect(() => {
    return () => {
      for (const dispose of agentDisposers.values()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      agentDisposers.clear()
      lastTask.clear()
      renderCache.clear()
    }
  })
}

export const __internal = { resolveOptions, messageText, touchUpdated, resolveInside }
