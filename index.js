/**
 * DSH Market (own) — host half.
 *
 * Owns three things a page cannot do:
 *   1. serving the catalog (fetched from the data repository, cached in memory),
 *   2. installing a plugin into the profile, in harness format, applying the
 *      compatibility repair when the entry needs one,
 *   3. recording what happened, so a repair is never applied blindly twice.
 *
 * The install path mirrors the harness's own rules: a target is accepted only
 * when it came from the catalog (the catalog is the trust list), and a repair is
 * installed as a local overlay package the harness handles like any other.
 *
 * Routes live under `/dsh-market-own/` so the section's data path is unambiguous.
 *
 * Two host facts came from live verification rather than from reading the plugin
 * this replaces, and both are load-bearing:
 *
 *   - the HTTP carrier is the **`webServer`** service, not `http`, and cordis
 *     throws `cannot get property "http" without inject` while the plugin tree is
 *     assembling — so a wrong name does not degrade the market, it stops `dsh web`
 *     from booting at all;
 *   - a plugin must therefore `export const inject`, and every service it reads
 *     has to be listed there.
 */
import { mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
// The repair rules are shared with the ingest half rather than copied: two
// implementations of "what makes a plugin incompatible" would drift apart, and
// the one a user actually hits is this one.
//
// `./ingest/compat.mjs`, NOT `../ingest/...`. As a path inside the package the
// file ships with it; one level up it resolves to `node_modules/ingest/`, which
// only exists while the plugin is a sibling of the ingest directory in a working
// copy — so the host half loaded during development and failed the moment the
// package was installed from a repository.
import { ISSUE, planRepair } from './ingest/compat.mjs'

export const name = 'dsh-market-own'

/** The HTTP carrier. `webServer` serves the routes below. */
export const inject = ['webServer']

/** Where the market's catalog artifacts live. */
const CATALOG_URL = process.env.DSH_MARKET_CATALOG
  ?? 'https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/data/catalog.json'

/** How long one catalog fetch is reused before the next open refetches. */
const CACHE_MS = 5 * 60 * 1000

/** Route prefixes owned by this plugin. */
const CATALOG_PATH = '/dsh-market-own/api/catalog'
const INSTALL_PATH = '/dsh-market-own/api/install'
const INSTALLED_PATH = '/dsh-market-own/api/installed'

/**
 * Read a context property that may be an undeclared service.
 *
 * Cordis throws on reading a service that is not in `inject`, and the throw
 * happens during boot — so an optional read must be guarded rather than assumed.
 *
 * @param ctx - host context.
 * @param key - property name.
 * @returns the value, or undefined when it is not available here.
 */
function optional(ctx, key) {
  try { return ctx[key] } catch { return undefined }
}

/**
 * Screen the harvested catalog before it reaches the settings page.
 *
 * Discovery signals are deliberately not treated as usefulness: a topic tag,
 * npm keyword, star count, or a directory's install command can all describe a
 * normal application rather than a Harness plugin. The pipeline's own
 * admission already decided that question — a row here carries
 * `installable: true` because a source catalog gave it a real install target,
 * or because admission read its manifest and found `dsh.bundle`. Re-trying
 * that question with weaker information only removes real plugins: requiring
 * manifest evidence here cut 11408 rows to 2999, dropping entries the catalog
 * had already admitted (every npm-targeted row, half the github-targeted ones)
 * because the ingest run never needs to probe a target a source declared.
 *
 * So the only rows removed here are semantic shells — placeholder text, a name
 * that describes nothing, promotion-only entries. Everything else stays, and
 * the weaker evidence sorts lower rather than disappearing.
 */
function screenCatalog(raw, home) {
  const source = Array.isArray(raw?.plugins) ? raw.plugins : []
  const plugins = source
    .map(entry => ({ ...entry, ...qualityOf(entry, home) }))
    .filter(entry => entry.qualityState !== 'unverified')
  const categories = rebuildCategories(raw?.categories, plugins)
  const categoryStats = {
    ...(raw?.stats?.category ?? raw?.categoryStats ?? {}),
    used: Object.keys(categories).length,
    counts: Object.entries(categories).map(([id, value]) => ({
      id,
      en: value.en,
      zh: value.zh,
      count: value.count,
    })),
  }
  return { plugins, categories, categoryStats }
}

/** Score real plugin signals without making popularity the admission rule. */
function qualityOf(entry, home) {
  const moduleName = String(entry?.npm || entry?.name || '').trim()
  const verified = isHarnessCatalogEntry(entry) || hasInstalledHarnessManifest(home, 'web', moduleName)
  const target = String(entry?.target || entry?.npm || normalizeInstallTarget(entry?.install)).trim()
  const hasTarget = target !== '' && entry?.installable !== false
  const description = [entry?.description?.en, entry?.description?.zh]
    .map(value => String(value ?? '').trim())
    .find(value => value !== '') ?? ''
  const meaningfulDescription = description.length >= 24 && !/^((test|demo|example|plugin|todo|tbd)[ .:_-]*)+$/i.test(description)
  const searchable = `${entry?.name ?? ''} ${entry?.description?.en ?? ''} ${entry?.description?.zh ?? ''} ${(entry?.topics ?? []).join(' ')}`
  const dshRelevance = /\b(dsh|deepseek|harness|cordis)\b/i.test(searchable)
  const judgment = judgePlugin(entry, searchable)
  const sourceCount = Array.isArray(entry?.sources) ? entry.sources.length : Number(entry?.sourceCount ?? 0)
  const stars = Math.max(0, Number(entry?.stars ?? 0) || 0)
  const downloads = Math.max(0, Number(entry?.downloads ?? 0) || 0)
  const popularity = Math.min(12, Math.round(Math.log10(1 + stars + downloads) * 2.5))
  const recent = recencyScore(entry?.added)
  const score = Math.min(100, (verified ? 45 : 0)
    + (hasTarget ? 10 : 0)
    + (meaningfulDescription ? 20 : 0)
    + (dshRelevance ? 10 : 0)
    + Math.min(8, sourceCount * 2)
    + recent
    + Math.min(7, popularity)
    + judgment.bonus)
  const usefulSignal = meaningfulDescription || stars >= 25 || downloads >= 100 || sourceCount >= 2
  // Admission follows the catalog's own verdict: a row that reaches here with a
  // target was either given that target by a source catalog or had its manifest
  // read by the ingest run's admission step. Requiring manifest evidence again
  // here would reject exactly the rows the catalog already admitted. The shell
  // judgement is the only remaining gate; evidence moves to the ranking score.
  const accepted = judgment.verdict !== 'exclude' && hasTarget
  const strongUsage = stars >= 100 || downloads >= 1000 || sourceCount >= 2
  const recommended = accepted && meaningfulDescription && strongUsage
    && (recent >= 4 || stars >= 100 || downloads >= 1000)
  const qualityState = !accepted ? 'unverified' : recommended ? 'recommended' : 'verified'
  const qualityReasons = [
    verified ? 'Harness manifest' : null,
    meaningfulDescription ? 'description' : null,
    dshRelevance ? 'DSH relevance' : null,
    sourceCount >= 2 ? 'multiple sources' : null,
    recent >= 5 ? 'recent activity' : null,
    popularity >= 5 ? 'usage signal' : null,
    ...judgment.reasons,
  ].filter(Boolean)
  return { qualityState, qualityScore: score, qualityReasons }
}
/**
 * Apply a narrow semantic judgement to catch empty or nominal entries. This is
 * intentionally not a category blacklist: a real theme, market, red-team,
 * editor, or standalone tool is allowed to remain in the catalog.
 */
function judgePlugin(entry, searchable) {
  const name = String(entry?.name ?? '').trim()
  const descriptions = [entry?.description?.en, entry?.description?.zh]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
  const description = descriptions.join(' ')
  const text = `${name} ${description}`
  const placeholderRules = [
    { pattern: /(?:coming soon|work in progress|placeholder|lorem ipsum|not implemented|待实现|待完善|占位|暂无内容)/i, reason: 'placeholder or unfinished entry' },
    { pattern: /^(?:dsh|deepseek|harness)?\s*(?:plugin|插件|extension|扩展|addon)(?:\s+(?:for|for dsh|相关))?[.!。 ]*$/i, reason: 'no concrete function described' },
  ]
  const placeholder = placeholderRules.find(rule => rule.pattern.test(text))
  if (placeholder !== undefined) return { verdict: 'exclude', bonus: -100, reasons: [placeholder.reason] }

  const concreteCapability = /(?:支持|提供|实现|允许|自动|管理|查看|生成|导出|同步|搜索|识别|调用|连接|增强|安装|更新|监控|审计|接入|渲染|编辑|回滚|路由|工作流|记忆|上下文|模型|工具|浏览器|图片|视觉|通知|智能体|团队|角色|编辑器|市场|皮肤|主题|红队|测试|验证|防护|Supports|Provides|Enables|Adds|Automates|Manage|View|Generate|Export|Sync|Search|Detect|Connect|Enhance|Install|Update|Monitor|Audit|Integrat|Render|Edit|Rollback|Route|Workflow|Memory|Context|Model|Tool|Browser|Image|Vision|Notify)/i.test(description)
  const promotionOnly = /(?:求\s*star|求收藏|求关注|welcome\s*to\s*star|please\s*star)/i.test(text)
  if (promotionOnly && !concreteCapability && description.length < 42) {
    return { verdict: 'exclude', bonus: -100, reasons: ['promotion-only entry'] }
  }
  if (description.length < 18 && !concreteCapability) {
    return { verdict: 'exclude', bonus: -100, reasons: ['empty or nominal description'] }
  }
  if (!concreteCapability && description.length < 42) {
    return { verdict: 'exclude', bonus: -100, reasons: ['no concrete function described'] }
  }
  return { verdict: 'keep', bonus: 0, reasons: [] }
}

/** Rebuild category counts after low-signal rows have been removed. */
function rebuildCategories(source, plugins) {
  const counts = new Map()
  for (const entry of plugins) {
    const id = String(entry.category ?? 'other').trim() || 'other'
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return Object.fromEntries([...counts.entries()].map(([id, count]) => {
    const base = source?.[id] ?? { en: id, zh: id }
    return [id, { en: base.en ?? id, zh: base.zh ?? base.en ?? id, count }]
  }))
}

/** Give recently maintained entries a small ranking bonus, never an admission pass. */
function recencyScore(value) {
  const text = String(value ?? '').trim()
  if (text === '') return 0
  const time = Date.parse(text)
  if (!Number.isFinite(time)) return 0
  const age = Date.now() - time
  if (age < 0 || age <= 180 * 24 * 60 * 60 * 1000) return 7
  if (age <= 365 * 24 * 60 * 60 * 1000) return 4
  return 0
}

/** Keep recommended entries above merely verified, regardless of raw popularity. */
function qualityRank(state) {
  return state === 'recommended' ? 1 : 0
}

/**
 * Register the market with the host.
 *
 * @param ctx - host context carrying the `webServer` service.
 */
export function apply(ctx) {
  const state = { catalog: null, fetchedAt: 0 }

  /** Read the catalog, revalidating at most once every five minutes. */
  async function catalog() {
    if (state.catalog !== null && Date.now() - state.fetchedAt < CACHE_MS) return state.catalog
    const res = await fetch(CATALOG_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`)
    const raw = await res.json()
    const screened = screenCatalog(raw, harnessHome(ctx))
    state.catalog = {
      ...raw,
      count: screened.plugins.length,
      plugins: screened.plugins,
      categories: screened.categories,
      categoryStats: screened.categoryStats,
      rawCount: Number(raw.count ?? raw.plugins?.length ?? 0),
    }
    state.fetchedAt = Date.now()
    return state.catalog
  }

  // ---- read route: the client half's data plane ---------------------------
  const disposeCatalog = ctx.webServer.register({
    kind: 'exact',
    path: CATALOG_PATH,
    handler: async (req, res) => {
      // A named route answers every method, so the method gate is ours.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      try {
        const data = await catalog()
        const url = new URL(req.url ?? '/', 'http://x')
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        const sort = url.searchParams.get('sort') ?? 'score'
        const kind = url.searchParams.get('kind') ?? ''
        const category = url.searchParams.get('category') ?? ''
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 60) || 60, 200)

        const matchesQuery = (p) => q === ''
          || `${p.name} ${p.owner} ${p.description?.en ?? ''} ${p.description?.zh ?? ''}`.toLowerCase().includes(q)
        const matchesKind = (p) => kind === '' || (p.targetKind ?? '') === kind

        // Global match count, computed over the WHOLE catalog independently of the
        // category filter. Without it a search inside a category that has no match
        // is indistinguishable from a search that has none anywhere — and "the whole
        // catalog has 340 of these, just not in this category" is the answer the
        // reader actually needs.
        const globalMatched = q === '' && kind === ''
          ? data.count
          : (data.plugins ?? []).filter((p) => matchesQuery(p) && matchesKind(p)).length

        let rows = (data.plugins ?? []).filter((p) => matchesQuery(p) && matchesKind(p) && (category === '' || (p.category ?? '') === category))
        const matched = rows.length

        // A row carries what the card needs to say something even when popularity is
        // silent: `sources.length` is the only signal available for the third of the
        // catalog with neither stars nor downloads, and `riskFlags` is the only fact
        // that changes whether installing is safe.
        const decorate = (p) => ({
          name: p.name,
          owner: (p.repoPath ?? '').split('/')[0] || p.owner || '',
          url: p.url,
          category: p.category,
          description: p.description ?? {},
          install: p.install,
          target: p.target ?? '',
          npm: p.npm ?? '',
          targetKind: p.targetKind,
          stars: p.stars ?? 0,
          downloads: p.downloads ?? 0,
          score: p.score ?? 0,
          version: p.version ?? '',
          added: p.added ?? '',
          sourceCount: Array.isArray(p.sources) ? p.sources.length : 0,
          riskFlags: Array.isArray(p.riskFlags) ? p.riskFlags : [],
          evidence: p.evidence ?? null,
          qualityState: p.qualityState ?? 'unverified',
          qualityScore: p.qualityScore ?? 0,
          qualityReasons: Array.isArray(p.qualityReasons) ? p.qualityReasons : [],
          // The catalog's own admission verdict is the installability decision:
          // `true` means a source gave it a real target or admission read its
          // manifest; `null` means the target could not be verified, so the row
          // is listed with a disabled button rather than removed. Overriding
          // either with a local re-check rejected rows the catalog admitted.
          installable: p.installable === null ? null : p.installable !== false,
        })

        const compare = {
          score: (a, b) => (qualityRank(b.qualityState) - qualityRank(a.qualityState))
            || (b.qualityScore - a.qualityScore) || (b.score - a.score) || (b.stars - a.stars) || (b.downloads - a.downloads)
            || String(b.added).localeCompare(String(a.added)) || a.name.localeCompare(b.name),
          stars: (a, b) => (b.stars - a.stars) || (b.downloads - a.downloads) || (b.score - a.score) || a.name.localeCompare(b.name),
          downloads: (a, b) => (b.downloads - a.downloads) || (b.stars - a.stars) || (b.score - a.score) || a.name.localeCompare(b.name),
          newest: (a, b) => String(b.added).localeCompare(String(a.added)) || (b.score - a.score) || a.name.localeCompare(b.name),
          name: (a, b) => a.name.localeCompare(b.name),
        }[sort] ?? null

        rows = compare === null ? rows : [...rows].sort(compare)
        const offset = (page - 1) * limit
        const pageRows = rows.slice(offset, offset + limit).map(decorate)

        sendJson(res, 200, {
          updated: data.updated,
          // `count` is the whole catalog, `globalMatched` is what the search and
          // install-kind filters allow, and `matched` adds the category — three
          // numbers so "showing / in this category / in the catalog" can all be told
          // apart on screen.
          count: data.count,
          globalMatched,
          matched,
          rawCount: data.rawCount ?? data.count,
          page,
          limit,
          hasMore: offset + pageRows.length < matched,
          // Global category counts, deliberately NOT narrowed by the current filter:
          // the index is how a reader discovers where plugins live, and counts that
          // shrink with the filter make every other bucket look empty.
          categories: data.categories ?? {},
          categoryStats: data.stats?.category ?? null,
          plugins: pageRows,
        })
      } catch (error) {
        // A market that cannot reach its catalog says so; it never shows
        // emptiness as if the catalog had nothing in it.
        sendJson(res, 502, { error: 'catalog_unreachable', message: String(error?.message ?? error) })
      }
    },
  })

  // ---- successful market installations -------------------------------
  // This is deliberately separate from the full Loader inventory. The Loader
  // contains Harness core entries and manually composed plugins; the market's
  // append-only ledger is the only source that can say an entry came from this
  // market. The client intersects these markers with the live Loader state so
  // removed entries disappear while failed/disabled market entries remain.
  const disposeInstalled = ctx.webServer.register({
    kind: 'exact',
    path: INSTALLED_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      try {
        let data = null
        try { data = await catalog() } catch { /* successful ledger markers remain available offline */ }
        sendJson(res, 200, { entries: readMarketInstallMarkers(harnessHome(ctx), data) })
      } catch (error) {
        sendJson(res, 500, { error: 'market_install_ledger_unavailable', message: String(error?.message ?? error) })
      }
    },
  })

  // ---- install, with the compatibility repair ------------------------------
  const disposeInstall = ctx.webServer.register({
    kind: 'exact',
    path: INSTALL_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = await readJson(req)
        const target = String(body.target ?? '')
        const profile = String(body.profile ?? 'web')
        const data = await catalog()
        // Trust boundary: the catalog is the only source of install targets, so a
        // page cannot ask the host to install something the market never listed.
        const entry = (data.plugins ?? []).find((p) =>
          p.install === target || p.target === target || p.npm === target)
        if (entry === undefined) {
          sendJson(res, 400, { ok: false, error: 'target_not_in_catalog' })
          return
        }
        sendJson(res, 200, await installWithRepair(ctx, entry, profile))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.effect(() => () => { disposeCatalog(); disposeInstalled(); disposeInstall() }, 'dsh-market-own: routes')
}

/**
 * Install one catalog entry, repairing it first when it needs repairing.
 *
 * Two sources of repair knowledge, deliberately:
 *   - the catalog's own plan, computed while the ingest run read the manifest to
 *     admit the entry (host-independent breaks);
 *   - a check against **this** host's version, because the ingest run is CI and
 *     cannot know which harness the user is on — peer drift is only decidable here.
 *
 * @param ctx - host context.
 * @param entry - the catalog entry being installed.
 * @param profile - the target harness profile, `web` by default.
 */
async function installWithRepair(ctx, entry, profile) {
  if (entry.installable === false) return { ok: false, code: 1, error: 'not_installable', log: '' }
  const home = harnessHome(ctx)
  // Catalog entries may expose `install` as the complete CLI command (for
  // example `dsh plugin --profile web add github:owner/repo`). The host API
  // expects only the value after `add`; passing the complete command here
  // would produce `... add dsh plugin ... add ...` and fail every install.
  const resolvedTarget = entry.target || entry.npm || normalizeInstallTarget(entry.install)
  const compat = await planForHost(ctx, entry)
  const blockingIssue = compat?.issues?.find(issue => issue.code === ISSUE.MISSING_MANIFEST)
  if (blockingIssue !== undefined) {
    const log = `not a Harness plugin: ${blockingIssue.detail}`
    recordEvent(home, {
      plugin: entry.name,
      moduleName: entry.npm || entry.name,
      target: entry.install,
      resolvedTarget,
      profile,
      repaired: false,
      notes: compat?.notes ?? [],
      status: 'rejected',
    })
    return { ok: false, code: 2, error: 'not_harness_plugin', log, repair: compat, target: entry.install, resolvedTarget }
  }
  let target = resolvedTarget
  let overlayDir = null

  if (compat?.overlay !== undefined && compat.overlay !== null) {
    // The overlay is written under the harness home, never into a user project:
    // an install artifact must not appear in their working tree.
    overlayDir = join(home, 'market-overlays', compat.overlay.name)
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'package.json'), JSON.stringify(compat.overlay, null, 2))
    target = overlayDir
  }

  const result = await runCli(home, ['plugin', '--profile', profile, 'add', target])

  if (overlayDir !== null) {
    // The overlay has been consumed by pnpm. Leaving it behind would make the
    // next install look like a change to a package the user never asked for.
    try { rmSync(overlayDir, { recursive: true }) } catch { /* best effort */ }
  }
  recordEvent(home, {
    plugin: entry.name,
    // A repaired install is loaded under the overlay package name. Recording
    // that actual Loader identity keeps the installed view correct after the
    // host restarts while the catalog still retains the original plugin name.
    moduleName: compat?.overlay?.name || entry.npm || entry.name,
    sourceModuleName: entry.npm || entry.name,
    target: entry.install,
    resolvedTarget,
    profile,
    repaired: overlayDir !== null,
    notes: compat?.notes ?? [],
    status: result.code === 0 ? 'succeeded' : 'failed',
  })
  return { ok: result.code === 0, code: result.code, log: result.output, repair: compat, target: entry.install, resolvedTarget }
}

/** Convert a catalog install command to the target consumed by `dsh plugin add`. */
function normalizeInstallTarget(value) {
  const raw = String(value ?? '').trim()
  const match = /^dsh\s+plugin(?:\s+--profile\s+\S+)?\s+add\s+(.+)$/i.exec(raw)
  const target = match?.[1]?.trim() ?? raw
  if (target.length >= 2 && ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))) {
    return target.slice(1, -1).trim()
  }
  return target
}

/** Catalog evidence accepted by the Harness plugin loader. */
function isHarnessCatalogEntry(entry) {
  return entry?.evidence === 'dsh.bundle' || entry?.evidence === 'dsh.client'
}

/**
 * The harness home for on-disk artifacts.
 *
 * `DSH_HOME` first because the desktop shell sets it for the service it spawns,
 * then the context property when some plugin provides one, then the process's own
 * directory — never a guess at a path that may belong to another installation.
 */
function harnessHome(ctx) {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const fromCtx = optional(ctx, 'home')
  return typeof fromCtx === 'string' && fromCtx !== '' ? fromCtx : process.cwd()
}

/** Read successful market installation markers without exposing the full ledger. */
function readMarketInstallMarkers(home, data = null) {
  const file = join(home, 'market-state', 'install-events.jsonl')
  let content
  try { content = readFileSync(file, 'utf8') } catch { content = '' }
  const markers = new Map()
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line)
      if (event.status !== 'succeeded' || (event.profile !== undefined && event.profile !== 'web')) continue
      const plugin = String(event.plugin ?? '').trim()
      const target = String(event.target ?? '').trim()
      const moduleName = String(event.moduleName ?? plugin).trim()
      const sourceModuleName = String(event.sourceModuleName ?? '').trim()
      const resolvedTarget = String(event.resolvedTarget ?? '').trim()
      if (plugin === '' && target === '' && moduleName === '') continue
      const key = `${plugin}\u0000${target}\u0000${moduleName}\u0000${sourceModuleName}\u0000${resolvedTarget}`
      markers.set(key, { plugin, target, moduleName, sourceModuleName, resolvedTarget, at: String(event.at ?? '') })
    } catch { /* one malformed audit line must not hide valid later entries */ }
  }

  // The audit ledger was added after the profile already contained plugins.
  // Recover that history from the profile's real dependency manifest, but only
  // when the package is also a verified Harness entry in the current market.
  // This excludes core bundles and unrelated manually installed libraries while
  // restoring legitimate market plugins that predate the ledger.
  const dependencies = readProfileDependencies(home, 'web')
  if (data !== null && dependencies.size > 0) {
    for (const entry of data.plugins ?? []) {
      const moduleName = String(entry.npm || entry.name || '').trim()
      if (moduleName === '' || !dependencies.has(moduleName)) continue
      if (!isHarnessCatalogEntry(entry) && !hasInstalledHarnessManifest(home, 'web', moduleName)) continue
      const target = String(entry.install ?? '').trim()
      const resolvedTarget = String(entry.target || entry.npm || normalizeInstallTarget(entry.install)).trim()
      const key = `${entry.name}\u0000${target}\u0000${moduleName}\u0000${moduleName}\u0000${resolvedTarget}`
      if (!markers.has(key)) {
        markers.set(key, {
          plugin: String(entry.name ?? moduleName),
          target,
          moduleName,
          sourceModuleName: moduleName,
          resolvedTarget,
          at: '',
          historical: true,
        })
      }
    }
  }
  return [...markers.values()]
}

/** Read dependency names from one profile without treating its bundle list as provenance. */
function readProfileDependencies(home, profile) {
  const file = join(home, 'profiles', profile, 'package.json')
  try {
    const packageJson = JSON.parse(readFileSync(file, 'utf8'))
    return new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ])
  } catch {
    return new Set()
  }
}

/** Check the installed package manifest when catalog evidence predates the ledger. */
function hasInstalledHarnessManifest(home, profile, moduleName) {
  const clean = String(moduleName ?? '').trim()
  if (clean === '') return false
  const file = join(home, 'profiles', profile, 'node_modules', ...clean.split('/'), 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    return manifest?.dsh?.bundle !== undefined || manifest?.dsh?.client !== undefined
  } catch {
    return false
  }
}

/**
 * Decide what, if anything, this install has to repair.
 *
 * Starts from the catalog's plan and upgrades it with a host-version check when
 * the entry names a repository. A failed manifest read is never fatal: the
 * catalog's plan still applies, and an unrepairable plugin installs normally so
 * the harness reports its own error rather than the market inventing one.
 */
async function planForHost(ctx, entry) {
  const fromCatalog = entry.compat ?? null
  const version = optional(ctx, 'version')
  const repo = entry.repo ?? entry.repoPath
  const subpath = entry.subpath ?? entry.repoSubpath ?? null
  if (repo === undefined || repo === null) return fromCatalog
  try {
    const manifest = await readManifest(repo, subpath)
    if (manifest === null) return fromCatalog
    const plan = planRepair({
      plugin: {
        name: entry.name,
        npm: entry.npm ?? null,
        target: entry.target || entry.npm || normalizeInstallTarget(entry.install),
        install: entry.install,
      },
      manifest,
      treePaths: null,
      hostVersion: typeof version === 'string' ? version : null,
    })
    if (!plan.needed) {
      // Preserve a catalog repair plan when present, but keep live manifest
      // diagnostics (notably missing-manifest) so unrepairable repositories are
      // rejected before pnpm mutates the profile.
      return plan.issues.length === 0 ? fromCatalog : { issues: plan.issues, overlay: null, notes: [] }
    }
    return { issues: plan.issues, overlay: plan.overlay, notes: plan.notes }
  } catch {
    return fromCatalog
  }
}

/** Read a repository manifest at its default branch, or null. */
async function readManifest(repo, subpath) {
  const paths = subpath === null || subpath === undefined || subpath === '' ? ['package.json'] : [`${subpath}/package.json`, 'package.json']
  for (const path of paths) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`, {
        headers: { 'user-agent': 'dsh-market-own' },
      })
      if (!res.ok) continue
      const text = await res.text()
      try { return JSON.parse(text) } catch { continue }
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * Append one install event to a JSONL log under the harness home.
 *
 * The host half has no database, and losing the record of a repair would make the
 * same fix impossible to audit later, so the log is a plain append-only file
 * anything can read.
 */
function recordEvent(home, event) {
  try {
    const dir = join(home, 'market-state')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'install-events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  } catch { /* an unwritable log must never fail the install */ }
}

/**
 * Resolve the CLI that owns this running Harness service.
 *
 * A source checkout starts the service as `node --import tsx/esm
 * apps/cli/src/bin.ts`, and the entry is what makes the child a *Harness* CLI
 * rather than a stray node. Two facts have to travel together, and the first
 * version kept only one:
 *
 *   - the **entry** (so the child is this installation's CLI, not whatever
 *     `dsh` happens to be on PATH, which on Windows is usually nothing);
 *   - the **cwd** (so `--import tsx/esm` can resolve `tsx` at all).
 *
 * Node resolves a `--import` specifier relative to the child's working
 * directory, not to the entry file. Spawning with `cwd = DSH_HOME` — which
 * contains profiles and state but no `node_modules/tsx` — made the child die
 * instantly with `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`, so every
 * install through the market failed before pnpm was ever reached. The checkout
 * root is the directory that has `tsx`, and it is derivable from the entry
 * itself rather than assumed, so a checkout moved to another path still works.
 *
 * `DSH_HOME` still reaches the child through the inherited environment, which
 * is what the CLI uses to find the profile; the cwd is only module resolution.
 */
function cliInvocation(args) {
  const candidates = [
    process.env.DSH_CLI_ENTRY,
    process.argv[1],
    resolve(process.cwd(), 'apps/cli/src/bin.ts'),
    resolve(process.cwd(), 'apps/cli/dist/bin.js'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const entry = resolve(candidate)
    if (!existsSync(entry)) continue
    return { command: process.execPath, argv: [...process.execArgv, entry, ...args], cwd: checkoutRoot(entry) }
  }
  throw new Error('Harness CLI entry not found for the running service')
}

/**
 * The checkout root a CLI entry belongs to: the first directory at or above the
 * entry from which the child can resolve `tsx`.
 *
 * Node resolves a `--import` specifier by walking `node_modules` up from the
 * child's **cwd**, not from the entry file. A checkout has module directories
 * at more than one level (`apps/cli/node_modules` exists but holds no `tsx`),
 * so a check for *any* `node_modules` stops one level too early and the loader
 * still dies with `ERR_MODULE_NOT_FOUND`. Looking for the loader package itself
 * reproduces Node's own resolution and lands on the checkout root.
 */
function checkoutRoot(entry) {
  let dir = resolve(entry, '..')
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'node_modules', 'tsx'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return resolve(entry, '..')
}

/** Run the harness CLI and capture its output. */
function runCli(home, args) {
  let invocation
  try {
    invocation = cliInvocation(args)
  } catch (error) {
    return Promise.resolve({ code: 1, output: String(error?.message ?? error) })
  }
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.argv, { cwd: invocation.cwd, windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

/** Write a JSON response with the headers a same-origin fetch needs. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read and parse a JSON request body, tolerating an empty one. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}
