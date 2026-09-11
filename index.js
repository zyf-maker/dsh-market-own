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
 * Routes live under `/dsh-market-own/` so the section's data path is unambiguous
 * even while another market plugin is installed side by side.
 */
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
// The repair rules are shared with the ingest half rather than copied: two
// implementations of "what makes a plugin incompatible" would drift apart, and
// the one a user actually hits is this one.
//
// `./ingest/compat.mjs`, NOT `../ingest/...`. As a path inside the package the
// file ships with it; one level up it resolves to `node_modules/ingest/`, which
// only exists while the plugin is a sibling of the ingest directory in a
// working copy — so the host half loaded during development and failed the
// moment the package was installed from a repository.
import { planRepair } from './ingest/compat.mjs'

export const name = 'dsh-market-own'

/** Where the market's catalog artifacts live. */
const CATALOG_URL = process.env.DSH_MARKET_CATALOG
  ?? 'https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/data/catalog.json'

/** How long one catalog fetch is reused before the next open refetches. */
const CACHE_MS = 5 * 60 * 1000

/**
 * Register the market with the host.
 *
 * @param ctx - host context: `ctx.http` for routes, `ctx.home` for the harness
 *   home, `ctx.version` for the running harness version.
 */
export async function apply(ctx) {
  const state = { catalog: null, fetchedAt: 0 }

  /** Read the catalog, revalidating at most once every five minutes. */
  async function catalog() {
    if (state.catalog !== null && Date.now() - state.fetchedAt < CACHE_MS) return state.catalog
    const res = await fetch(CATALOG_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`)
    state.catalog = await res.json()
    state.fetchedAt = Date.now()
    return state.catalog
  }

  // ---- read route: the client half's data plane ---------------------------
  ctx.http?.get?.('/dsh-market-own/api/catalog', async (req, res) => {
    try {
      const data = await catalog()
      const url = new URL(req.url, 'http://localhost')
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const sort = url.searchParams.get('sort') ?? 'score'
      const kind = url.searchParams.get('kind') ?? ''
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 60) || 60, 200)
      let rows = data.plugins ?? []
      if (q !== '') {
        rows = rows.filter((p) =>
          `${p.name} ${p.owner} ${p.description?.en ?? ''} ${p.description?.zh ?? ''}`.toLowerCase().includes(q))
      }
      if (kind !== '') rows = rows.filter((p) => (p.targetKind ?? '') === kind)
      const key = sort === 'stars' ? 'stars' : sort === 'downloads' ? 'downloads' : sort === 'name' ? 'name' : 'score'
      rows = key === 'name'
        ? [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)))
        : [...rows].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ updated: data.updated, count: data.count, total: rows.length, plugins: rows.slice(0, limit) }))
    } catch (error) {
      // A market that cannot reach its catalog says so; it never shows emptiness
      // as if the catalog had nothing in it.
      res.statusCode = 502
      res.end(JSON.stringify({ error: 'catalog_unreachable', message: String(error?.message ?? error) }))
    }
  })

  // ---- install, with the compatibility repair ------------------------------
  ctx.http?.post?.('/dsh-market-own/api/install', async (req, res) => {
    const body = await readJson(req)
    const target = String(body.target ?? '')
    const profile = String(body.profile ?? 'web')
    try {
      const data = await catalog()
      // Trust boundary: the catalog is the only source of install targets, so a
      // page cannot ask the host to install something the market never listed.
      const entry = (data.plugins ?? []).find((p) =>
        p.install === target || p.target === target || p.npm === target || (body.name !== undefined && p.name === body.name && p.install === target))
      if (entry === undefined) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'target_not_in_catalog' }))
        return
      }
      const result = await installWithRepair(ctx, entry, profile)
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(result))
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  })
}

/**
 * Install one catalog entry, repairing it first when it needs repairing.
 *
 * Two sources of repair knowledge, deliberately:
 *   - the catalog's own plan, computed while the ingest run read the manifest to
 *     admit the entry (host-independent breaks);
 *   - a check against **this** host's version, because the ingest run is CI and
 *     cannot know which harness the user is on — peer drift is only decidable
 *     here.
 *
 * @param ctx - host context (`ctx.home`, `ctx.version`).
 * @param entry - the catalog entry being installed.
 * @param profile - the target harness profile, `web` by default.
 */
async function installWithRepair(ctx, entry, profile) {
  if (entry.installable === false) return { ok: false, code: 1, error: 'not_installable', log: '' }
  const compat = await planForHost(ctx, entry)
  let target = entry.install
  let overlayDir = null

  if (compat?.overlay !== undefined && compat.overlay !== null) {
    // The overlay is written under the harness home, never into a user project:
    // an install artifact must not appear in their working tree.
    overlayDir = join(ctx.home ?? process.cwd(), 'market-overlays', compat.overlay.name)
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'package.json'), JSON.stringify(compat.overlay, null, 2))
    target = overlayDir
  }

  const result = await run(ctx, ['plugin', '--profile', profile, 'add', target])

  if (overlayDir !== null) {
    // The overlay has been consumed by pnpm. Leaving it behind would make the
    // next install look like a change to a package the user never asked for.
    try { rmSync(overlayDir, { recursive: true }) } catch { /* best effort */ }
  }
  recordEvent(ctx, {
    plugin: entry.name,
    target: entry.install,
    repaired: overlayDir !== null,
    notes: compat?.notes ?? [],
    status: result.code === 0 ? 'succeeded' : 'failed',
  })
  return { ok: result.code === 0, code: result.code, log: result.output, repair: compat, target: entry.install }
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
  if (entry.repo === undefined || entry.repo === null || ctx.version === undefined) return fromCatalog
  try {
    const manifest = await readManifest(entry.repo, entry.subpath ?? null)
    if (manifest === null) return fromCatalog
    const plan = planRepair({
      plugin: { name: entry.name, npm: entry.npm ?? null, target: entry.install, install: entry.install },
      manifest,
      treePaths: null,
      hostVersion: ctx.version,
    })
    if (!plan.needed) return fromCatalog
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
 * The host half has no database, and losing the record of a repair would make
 * the same fix impossible to audit later, so the log is a plain append-only file
 * anything can read.
 */
function recordEvent(ctx, event) {
  try {
    const dir = join(ctx.home ?? process.cwd(), 'market-state')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'install-events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  } catch { /* an unwritable log must never fail the install */ }
}

/** Run the harness CLI and capture its output. */
function run(ctx, args) {
  return new Promise((resolve) => {
    const child = spawn(ctx.cli ?? 'dsh', args, { cwd: ctx.home ?? process.cwd(), windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

/** Read and parse a JSON request body, tolerating an empty one. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}
