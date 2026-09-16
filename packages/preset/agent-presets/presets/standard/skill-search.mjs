/**
 * skill-search — on-demand skill discovery and loading, replacing
 * `dsh-tool-skill`'s full-catalog injection.
 *
 * WHY: the available-skills reminder (`<available_skills>`, ~9KB with many
 * skills) is injected into the first step by dsh-tool-skill and again after
 * every promotion/compaction. That large injected block perturbs the
 * trajectory in tool-heavy requests (issue #6). We remove the catalog injection entirely
 * and expose two small on-demand tools instead:
 *
 *  - `skill_search` — list skills whose name/description match a query
 *    (summaries only, bounded; no bodies). The model discovers what exists
 *    without a 9KB dump.
 *  - `skill_load` — load ONE skill's full instructions by exact name and
 *    inject them for the NEXT request via `agent.inject` (the non-waking
 *    next-step inbox). The model (or the user) calls this only when the
 *    skill is actually needed.
 *
 * Discovery reads `ctx.skills` scoped to the calling agent, exactly like
 * dsh-tool-skill. If skills are unavailable the tools answer with a short
 * message instead of throwing.
 *
 * NOTE: this plugin REPLACES the `dsh-tool-skill` row in the composition —
 * the composition must NOT mount both, or the catalog injection returns.
 */

import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-search'

/** The agent, tools, and skills services must exist before these tools can register. */
export const inject = ['agents', 'tools', 'skills']

const MAX_RESULTS = 20

/** Characters of each description shown in a search result, after newlines collapse. */
const MAX_DESCRIPTION = 400

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Register the two on-demand skill tools. */
export function apply(ctx) {
  /**
   * Normalize text into lowercase tokens for substring matching. Unicode letters
   * and digits stay in: the former ASCII-only class dropped every CJK character,
   * so a Chinese query tokenized to nothing, hit the `wanted.length === 0` branch,
   * and returned the whole catalog instead of the skills actually asked for.
   */
  // 中英混排查询要点：`\p{L}` 保住了 CJK，但也让「PDF技能」这类混排整段变成一个
  // 不可分的 token，永远匹配不上 haystack 里独立的 `pdf`。这里在汉字/Latin 边界再
  // 切一刀，两边任一命中即可（「PDF技能」→ `pdf` + `技能`）。
  const tokens = (text) => (text || '').toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .flatMap((part) => part.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? [])
    .filter(Boolean)

  ctx.tools.register({
    name: 'skill_search',
    description: 'Search the available skills by keyword and return matching skill names with short descriptions. This session keeps NO skill catalog in the prompt — if a task looks like it matches a skill (document conversion, image processing, game reviews, markdown, PDF, spreadsheets, …), call skill_search FIRST to find it, then skill_load to activate it. Do NOT assume skill names from memory.',
    parameters: toJsonSchema({
      query: { type: 'string', required: true, description: 'search keywords (e.g. "pdf", "obsidian", "game review")' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const wanted = tokens(args.query)
      const scope = exec?.agent ?? ctx
      try {
        const all = await ctx.skills.list({
          scope,
          cwd: exec?.agent?.session?.header?.cwd,
          signal: exec?.signal,
        })
        const matches = all.filter((skill) => {
          if (wanted.length === 0) return true
          const haystack = tokens(`${skill.name} ${skill.description ?? ''} ${skill.whenToUse ?? ''}`).join(' ')
          // 任一 token 命中即可：原来的 every 让查询里多一个词（例如顺手加的「技能」）
          // 就把整条查询打成零结果。下面按「命中名字 ×10」排序、结果有上限兜底，
          // 所以放宽召回不等于失控。
          return wanted.some((token) => haystack.includes(token))
        })
        // Rank by where the tokens hit: a name hit counts ten times a description
        // hit, and ties fall back to name order so an unfiltered query stays stable.
        const ranked = matches
          .map((skill) => {
            const name = String(skill.name ?? '').toLowerCase()
            const below = String(skill.description ?? '').toLowerCase()
            const score = wanted.filter((token) => name.includes(token)).length * 10
              + wanted.filter((token) => below.includes(token)).length
            return { skill, name, score }
          })
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        const lines = ranked.slice(0, MAX_RESULTS).map(({ skill }) => {
          // Collapse the whole description: keeping only its first line hid the
          // trigger conditions that multiline descriptions write further down.
          const desc = String(skill.description ?? '').replace(/\s+/g, ' ').trim()
          const shown = desc.length > MAX_DESCRIPTION ? `${desc.slice(0, MAX_DESCRIPTION)}…` : desc
          return `- ${skill.name}: ${shown}`
        })
        if (lines.length === 0) return { text: `No skills match "${args.query}". Use skill_search with other keywords.` }
        const extra = matches.length > MAX_RESULTS ? `\n…(${matches.length - MAX_RESULTS} more)` : ''
        return { text: `Matching skills (${matches.length}):\n${lines.join('\n')}${extra}\n\nLoad one with skill_load (exact name).` }
      } catch (error) {
        return { text: `skill_search unavailable: ${String((error && error.message) || error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact name (from skill_search results) and inject them for the next request. Call this before acting on a task that matches the skill.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact skill name (kebab-case, from skill_search)' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        if (agent === undefined) return { text: 'skill_load requires an agent context.' }
        const skill = await ctx.skills.get(args.name, {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec?.signal,
        })
        if (skill === undefined) {
          return { text: `No skill named "${args.name}". Run skill_search to list available skills.` }
        }
        const body = extractSkillBody(skill)
        if (body.length === 0) {
          return { text: `Skill "${args.name}" has no loadable body.` }
        }
        // Queue the skill content as a non-waking next-step context message,
        // exactly like dsh-tool-skill's invocation injection.
        agent.inject({
          id: `skill-load-${args.name}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: body }],
          source: { kind: 'skill-invocation', name: args.name, form: 'instructions' },
        })
        // 三种形态都要给出可直接使用的绝对路径：directory bundle（<dir>/SKILL.md）、
        // 根部扁平 <name>.md、以及软链接入口。`skill.path` 是指令文件本身、`resourceBase.path`
        // 是其所在目录，但两者都由 provider 用 join(root, name) 拼出、不解析软链接（扁平 skill 的
        // resourceBase 更是整个 root 目录），所以真身一律再 realpathSync 解析一次。
        const entryFile = typeof skill?.path === 'string' ? skill.path : undefined
        const entryDir = skill?.resourceBase?.kind === 'directory' ? skill.resourceBase.path : undefined
        const resolveReal = value => {
          if (value === undefined) return undefined
          try { return realpathSync(value) } catch { return value }
        }
        const file = resolveReal(entryFile)
        const dir = file === undefined ? resolveReal(entryDir) : dirname(file)
        const lines = []
        if (file !== undefined) lines.push(`Skill file: ${file}`)
        if (dir !== undefined) lines.push(`Skill directory: ${dir}`)
        if (file !== undefined && entryFile !== file) lines.push(`(discovered via ${entryFile})`)
        const located = lines.length === 0 ? ''
          : `\n${lines.join('\n')}\nResolve relative paths mentioned by this skill (such as reference.md or scripts/) against the skill directory.`
        return { text: `Skill "${args.name}" loaded; its instructions will be injected for the next request.${located}` }
      } catch (error) {
        return { text: `skill_load failed: ${String((error && error.message) || error)}` }
      }
    },
  })
}

/** Extract the model-facing body of a loaded skill definition. */
function extractSkillBody(skill) {
  const content = skill?.content ?? skill?.instructions ?? skill?.body
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('\n')
  }
  return ''
}
