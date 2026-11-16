# dsh-memory-vault

把 **Obsidian 长期记忆库**接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：每个任务开始前自动检索相关记忆、注入上下文；提供写入与结构体检工具；每周由定时任务自动整理。

装在 Harness 侧，不装 Obsidian 插件，不修改你已有的笔记结构。

## 它做什么

| 机制 | 实现 | 效果 |
| --- | --- | --- |
| **每轮注入** | 每个 Agent 创建时挂一个 scoped `systemPrompt.context`，从 `agent/inbox/claimed` 取当前任务文本 | 常驻核心档案 ~900 字 + 按任务检索的 3 条记忆 ~1300 字 |
| **检索** | 中文 2/3-gram + 拉丁词；标题×6、标签×4、小标题×1.5、正文×0.5，按相对阈值截断 | 纯本地、同步、无嵌入模型、无外部依赖 |
| **写入** | `memory_note` 工具，路径强制锁在记忆库目录内 | 覆盖时自动把 frontmatter 的 `更新日期` 改成当天 |
| **体检** | `memory_health` 工具 | 收件箱积压、过期目标、断链（扫整个 Obsidian 仓库）、重复候选、frontmatter 缺失 |
| **每周优化** | 配合 Harness 定时任务 | 体检 → 清收件箱 → 合并去重 → 回写索引 |

## 安装

```bash
git clone https://github.com/07-dot/dsh-memory-vault.git
```

然后在 Harness 里用 `plugin_manager` 的 `install_bundle`，target 指向这个目录（本地目录会被链接安装，不是拷贝）。安装后重启或等 HMR 生效。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: memory-vault
      name: '@local/dsh-memory-vault'
      config:
        vault: ''            # 你的记忆库目录，必填；也可用环境变量 DSH_MEMORY_VAULT
        matchCount: 3        # 每次注入的检索条数
        matchBudget: 1300    # 检索结果字数上限
        coreBudget: 900      # 核心档案字数上限
        minScore: 2.5        # 相关度阈值
        staleDays: 45        # 目标多久未更新算过期
```

`vault` 留空时插件会打一条警告并停用注入，写入与体检工具会明确报错——不会静默失败。

## 记忆库的结构约定

插件按 frontmatter 的 `类型` 和固定文件名识别内容。推荐（非强制）结构：

```
记忆库/
├── 记忆库首页.md          # 「速读区」表格会被当作核心档案
├── 01-个人档案/
│   ├── 个人概况.md        # 「基本信息」表格 → 核心档案
│   └── 偏好与习惯.md      # 「沟通偏好」「雷区」→ 核心档案
├── 02-目标与进展/目标总览.md   # 「本月聚焦」→ 核心档案
├── 03-项目与主题/项目总览.md
├── 04-收件箱.md
└── 05-模板/               # 模板目录：不参与检索、不参与查重
```

约定：

- frontmatter 至少写 `类型` 和 `更新日期`（`YYYY-MM-DD`）。
- 表格里写「待填」「待确认」的占位不会被注入。
- `05-模板/` 被排除在检索与重复检测之外——模板是脚手架，不是记忆。
- 断链检查只对记忆库内的笔记做，但会认整个 Obsidian 仓库的目标名，所以跨目录双链不会误报。

## 结构

- `index.js` —— 插件接线：prompt context、3 个工具、生命周期清理。任何注入失败都静默降级为空串，不会拖垮会话。
- `memory-core.js` —— 纯 Node 逻辑：扫描、frontmatter 解析、打分、注入文本、体检。不依赖 Harness，可单独用 `node` 调用测试。

## 已知限制

- 检索是词面匹配，不理解同义词；中文靠 n-gram，长句里噪声片段会命中弱相关笔记。
- 注入块随任务变化，会削弱 prompt 缓存命中率。
- 每个 Agent 首次组装提示词时才建索引（之后按 mtime 缓存），大记忆库（上千条）需要留意首次延迟。
- 写入工具的路径限制是前缀校验，不做符号链接解析。

## License

MIT © 2026 07-dot
