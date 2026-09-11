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
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { planRepair } from './ingest/compat.mjs'

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
    state.catalog = await res.json()
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
        sendJson(res, 200, {
          updated: data.updated,
          count: data.count,
          total: rows.length,
          plugins: rows.slice(0, limit),
        })
      } catch (error) {
        // A market that cannot reach its catalog says so; it never shows
        // emptiness as if the catalog had nothing in it.
        sendJson(res, 502, { error: 'catalog_unreachable', message: String(error?.message ?? error) })
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

  ctx.effect(() => () => { disposeCatalog(); disposeInstall() }, 'dsh-market-own: routes')
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
  const compat = await planForHost(ctx, entry)
  const home = harnessHome(ctx)
  let target = entry.install
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
    target: entry.install,
    repaired: overlayDir !== null,
    notes: compat?.notes ?? [],
    status: result.code === 0 ? 'succeeded' : 'failed',
  })
  return { ok: result.code === 0, code: result.code, log: result.output, repair: compat, target: entry.install }
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
  if (entry.repo === undefined || entry.repo === null || typeof version !== 'string') return fromCatalog
  try {
    const manifest = await readManifest(entry.repo, entry.subpath ?? null)
    if (manifest === null) return fromCatalog
    const plan = planRepair({
      plugin: { name: entry.name, npm: entry.npm ?? null, target: entry.install, install: entry.install },
      manifest,
      treePaths: null,
      hostVersion: version,
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

/** Run the harness CLI and capture its output. */
function runCli(home, args) {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'dsh'
  const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `dsh ${args.join(' ')}`] : args
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd: home, windowsHide: true })
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
