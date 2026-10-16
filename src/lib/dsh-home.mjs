// ============================================================
//  dsh-home.mjs — DSH home 解析（环境可注入）
//  ------------------------------------------------------------
//  优先级：显式参数  >  $DSH_HOME  >  $BUTLER_DSH_HOME  >  ~/.dsh
//  （空 / 纯空白的取值视为未设置，避免解析到 cwd）
//
//  ⚠️ 本发行版的**环境变量主名是 DSH_HOME**；BUTLER_DSH_HOME 是旧私有名，只作
//     **一次性兼容读**（先读主名、再回落旧名，不报错）。两者都没设 ⇒ 回落 ~/.dsh。
//
//  用途：让部署/恢复脚本与运行期组件能被指向隔离的实例
//        （例：把 $DSH_HOME 指向 <隔离实例根>/.dsh），先把插件部署到测试
//        profile 验证通过，再部署到生产。
//
//  兼容性铁律：**不设置任何环境变量时，返回的路径 = ~/.dsh**。
// ============================================================
import os from 'node:os'
import path from 'node:path'

/** 解析 DSH home 绝对路径。 */
export function resolveDshHome(configured) {
  if (configured) return path.resolve(configured)
  // 逐变量判定：空 / 纯空白取值一律视为「未设置」，逐级回落
  //   DSH_HOME → BUTLER_DSH_HOME（旧名兼容读）→ ~/.dsh（复用本文件 envValue()，不另造判定）。
  // 为什么不用 `process.env.A || process.env.B`：它只挡得住**空串**——纯空白（'   '）是
  // truthy 会被当成"已设置"，而 `'   '.trim()` 又是空串 ⇒ 两个变量都被跳过，直接落回 ~/.dsh。
  // 实测后果：隔离实例场景里只要残留一个空白值，脚本就静默读写**默认实例**，
  // 而调用方以为自己在沙箱里（实测：want 沙箱 / got 默认 home）。
  const override = homeEnvValue()
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.dsh')
}

/**
 * home 环境变量取值：**先读主名 DSH_HOME，再回落旧私有名 BUTLER_DSH_HOME**（不报错）。
 * 旧名只为兼容既有部署；新部署请一律用 DSH_HOME。
 */
function homeEnvValue() {
  return envValue('DSH_HOME') ?? envValue('BUTLER_DSH_HOME') // 主名优先；旧私有名仅作兼容读
}

/** web profile 目录（插件实体、package.json、.package-map.json 所在处）。 */
export function webProfileDir(configuredHome) {
  return path.join(resolveDshHome(configuredHome), 'profiles', 'web')
}

/**
 * 标记当前目标是不是测试环境（仅用于日志提示与安全自检）。
 * 判定：home 路径不等于默认的 ~/.dsh。
 */
export function isNonDefaultHome(configuredHome) {
  const def = path.join(os.homedir(), '.dsh')
  return path.resolve(resolveDshHome(configuredHome)) !== path.resolve(def)
}

/**
 * 工作区环境变量名（放 docs\ 与报告的那棵树的根）。
 * ⚠️ 本发行版**不内置任何本机工作区默认值** => 必须走显式参数或这个环境变量，
 *    否则 resolveDshWorkspace() 抛错（绝不会静默落到某个磁盘路径）。
 */
export const DSH_WORKSPACE_ENV = 'DSH_WORKSPACE'

/** 任意环境变量的非空取值（空串/纯空白视为未设置）。 */
function envValue(name) {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : null
}

/**
 * 解析工作区根（放 docs\ 与报告的那棵树）。
 * 优先级：显式参数 > $DSH_WORKSPACE > 由 home 推导（**仅当 home 被环境变量重定向到
 * `<某目录>/.dsh` 这种"隔离实例"形态时**）。
 * ⚠️ 判据必须是「env 显式指向了非默认 home」而不是"路径层数够"——默认 home 本身也在
 * 用户目录下、层数一样，按层数判会把工作区错推成用户目录。
 * ⚠️ **本发行版不内置任何本机默认值**：四处都拿不到 => 抛错（明确告诉你该设哪个变量），
 *    绝不静默落到某个磁盘路径。
 */
export function resolveDshWorkspace(configured) {
  if (configured) return path.resolve(configured)
  const env = envValue(DSH_WORKSPACE_ENV)
  if (env) return path.resolve(env)
  const defaultHome = path.join(os.homedir(), '.dsh')
  const override = homeEnvValue()
  if (override) {
    const home = path.resolve(override)
    if (home.toLowerCase() !== path.resolve(defaultHome).toLowerCase()
      && path.basename(home).toLowerCase() === '.dsh') {
      return path.resolve(path.dirname(home))
    }
  }
  throw new Error(
    `cannot resolve the workspace root: pass it explicitly or set $${DSH_WORKSPACE_ENV} `
    + '(the tree that holds your docs/ and tools/ directories). '
    + 'This build intentionally ships no machine-specific default.',
  )
}

/**
 * 管家日报/周报输出目录。
 * 环境变量主名 = `DSH_REPORT_DIR`；旧私有名 `BUTLER_REPORT_DIR` 作**一次兼容读**（不报错）。
 */
export function resolveReportDir(configured) {
  if (configured) return path.resolve(configured)
  const env = envValue('DSH_REPORT_DIR') ?? envValue('BUTLER_REPORT_DIR') // 主名优先；旧私有名仅作兼容读
  if (env) return path.resolve(env)
  return path.join(resolveDshWorkspace(), 'docs', '管家报告')
}

/** 变更流水目录（<workspace>\docs\变更流水）。 */
export function resolveChangelogDir(configured) {
  if (configured) return path.resolve(configured)
  return path.join(resolveDshWorkspace(), 'docs', '变更流水')
}
