/**
 * Ship the `/syn-dsh` skill with the plugin.
 *
 * The skill body lives in `assets/syn-dsh.md` and is read on every `get()`, so
 * editing it takes effect without reinstalling the package. Serving it from
 * the package is what keeps the instructions and the tools in one version: a
 * skill in the config repository could drift from the implementation it
 * documents.
 *
 * `rank` matches `BUNDLED_SKILL_RANK` (600) in `@deepseek-ai/dsh-skill`: the
 * bundled layer sorts last, so a project-local override still wins.
 *
 * @module dsh-config-sync/core/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const BODY_URL = new URL('../../assets/syn-dsh.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../../assets/', import.meta.url)),
}
const PROVIDER_NAME = 'dsh-config-sync'
const SKILL_NAME = 'syn-dsh'

const CANDIDATE = {
  name: SKILL_NAME,
  description: '跨电脑同步 DSH 配置（技能 / 插件 / profile 设置 / AGENTS.md）与私有仓库 dsh-config：拉取、推送、新机恢复、体检与失败排查。当用户说「同步 dsh」「syn_dsh」「把配置推到仓库」「换电脑恢复配置」「为什么技能没同步」时使用。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: 600,
  locator: BODY_URL,
}

/**
 * Register the bundled skill provider.
 *
 * @param {{ skills: { registerProvider(factory: Function): unknown } }} ctx
 */
export function registerSkill(ctx) {
  if (ctx.skills === undefined || typeof ctx.skills.registerProvider !== 'function') return
  ctx.skills.registerProvider(() => ({
    name: PROVIDER_NAME,
    list: () => Promise.resolve([CANDIDATE]),
    get: async (candidate) => {
      if (candidate !== undefined && candidate.name !== undefined && candidate.name !== SKILL_NAME) {
        throw new Error(`unknown skill ${String(candidate.name)}`)
      }
      return { ...CANDIDATE, content: await readFile(BODY_URL, 'utf8') }
    },
  }))
}

export { CANDIDATE, PROVIDER_NAME, SKILL_NAME }
