/**
 * dsh-skill-center — host half.
 *
 * Owns the harness skill library (`<dshHome>/skill-center/library`) and the two
 * facts that govern it: enablement and category placement. Three surfaces come
 * out of that ownership:
 *
 * - a **shadow provider** registered into `ctx.skills`. It always lists every
 *   skill in the library — never filtering — and rewrites each candidate's
 *   invocation flags from the enablement record, so a disabled skill is simply
 *   not invocable rather than absent. Listing everything is what keeps the
 *   library's own panel able to show a disabled skill and re-enable it.
 * - the **category tree**, which is pure organisation: it never reaches the
 *   provider, never appears in a prompt, and never changes what a model can
 *   invoke. Enablement and placement are orthogonal by construction — the
 *   catalog is built from the library scan, and only `invocation` reads state.
 * - a small HTTP API the browser half reads and writes: one library snapshot,
 *   one source listing, one mutation dispatcher. Every route passes the host's
 *   `connection` fence first, and the routes are registered only where that
 *   fence exists — a web server without one gets no API, not an open one.
 *
 * The library root is deliberately disjoint from every native skill root
 * (`<dshHome>/skills`, project roots, configured dirs), so no name in the
 * library competes with a name from another provider and rank only decides
 * ties inside this layer.
 *
 * @module dsh-skill-center
 */

import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CategoryError } from './categories.js'
import {
  InvalidSkillError,
  LibraryError,
  createSkill,
  importSkill,
  readSkillFile,
  scanLibrary,
  uninstallSkill,
} from './library.js'
import { SourceError, defaultSources, describeSources, isDirectory, resolveSourcePath, scanSource, sourceIdOf, sourceKey } from './sources.js'
import { SkillStateStore, categoryOf, isEnabled } from './store.js'

export const name = 'dsh-skill-center'

/** The skill registry is the whole point; without it there is nothing to serve. */
export const inject = ['skills']

/** Absolute prefix of the browser-facing API. */
const API_BASE = '/dsh-skill-center/api'

/** Precedence rank inside the registry's global layer. */
const PROVIDER_RANK = 350

/** Provider name registered into `ctx.skills`. */
const PROVIDER_NAME = 'skill-center'

/**
 * Refuse oversized request bodies rather than buffering them. Sized for a
 * pasted skill body, which is the largest thing any command carries.
 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Register the library provider and the browser API.
 * @param ctx - host context; `skills` is required, while `webServer` and
 *   `connection` are optional so the provider still works in a headless
 *   composition. Both are needed for the routes: without a fence to guard them
 *   there is no API, rather than an unguarded one.
 */
export function apply(ctx) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const root = path.join(home, 'skill-center')
  const libraryDir = path.join(root, 'library')
  const store = new SkillStateStore(path.join(root, 'state.json'), loggerOf(ctx))
  const log = loggerOf(ctx)

  /** Invalidation handle of the live provider registration. */
  let invalidate

  // Best effort: a library that does not exist yet is still a valid library,
  // but creating it makes the directory visible to whoever wants to drop a
  // skill in by hand.
  ctx.effect(() => {
    void mkdir(libraryDir, { recursive: true }).catch((error) => {
      log?.warn?.(`cannot create skill library at ${libraryDir}: ${error.message}`)
    })
  }, 'dsh-skill-center: library directory')

  /**
   * Library snapshot consumed by both surfaces: every skill on disk with its
   * effective enablement, its category, and the invocation policy that follows.
   */
  const describe = async () => {
    const { skills, warnings } = await scanLibrary(libraryDir)
    const state = await store.read()
    return {
      categories: state.categories,
      warnings,
      rows: skills.map((skill) => {
        const enabled = isEnabled(state, skill.name)
        return { ...skill, enabled, categoryId: categoryOf(state, skill.name), invocation: invocationOf(skill, enabled) }
      }),
    }
  }

  /** Snapshot in the shape the browser half renders. */
  const snapshot = async () => {
    const { rows, warnings, categories } = await describe()
    return { libraryDir, categories, skills: rows.map(toWire), warnings }
  }

  ctx.effect(
    () =>
      ctx.skills.registerProvider((control) => {
        invalidate = control.invalidate
        return {
          name: PROVIDER_NAME,
          list: async (options) => {
            if (options?.signal?.aborted === true) return []
            const { rows } = await describe()
            return rows.map((row) => ({
              name: row.name,
              description: row.description,
              ...(row.whenToUse === undefined ? {} : { whenToUse: row.whenToUse }),
              invocation: row.invocation,
              source: 'custom',
              provider: PROVIDER_NAME,
              rank: PROVIDER_RANK,
              locator: row.file,
              path: row.file,
            }))
          },
          get: async (candidate) => {
            const file = locatorOf(candidate)
            if (file === undefined) return undefined
            let skill
            try {
              skill = await readSkillFile(file, fallbackNameOf(file))
            } catch (error) {
              // Deleted or newly malformed after discovery: no longer loadable.
              if (!(error instanceof InvalidSkillError) && error?.code !== 'ENOENT') {
                log?.warn?.(`cannot load ${file}: ${error.message}`)
              }
              return undefined
            }
            const state = await store.read()
            const enabled = isEnabled(state, skill.name)
            return {
              name: skill.name,
              description: skill.description,
              ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
              invocation: invocationOf(skill, enabled),
              source: 'custom',
              provider: PROVIDER_NAME,
              content: skill.body,
              path: file,
              resourceBase: { kind: 'directory', path: skill.directory },
            }
          },
        }
      }),
    'dsh-skill-center: library provider',
  )

  // `connection` is not decoration: it owns the Host/Origin/authentication
  // fence every route on this server is expected to pass through, so the
  // routes are registered only where a fence exists to consult. A composition
  // with a web server but no connection service gets no API at all, rather
  // than an unfenced one.
  ctx.inject(['webServer', 'connection'], (hostCtx) => {
    hostCtx.effect(() => {
      const handlers = {
        describe,
        snapshot,
        libraryDir,
        dshHome: home,
        store,
        log,
        invalidate: () => invalidate?.(),
        fence: fenceOf(hostCtx),
      }
      const disposers = [
        hostCtx.webServer.register({
          kind: 'exact',
          path: `${API_BASE}/library`,
          handler: (request, response) => handleRead(request, response, handlers),
        }),
        hostCtx.webServer.register({
          kind: 'exact',
          path: `${API_BASE}/sources`,
          handler: (request, response) => handleSources(request, response, handlers),
        }),
        hostCtx.webServer.register({
          kind: 'exact',
          path: `${API_BASE}/mutate`,
          handler: (request, response) => handleMutate(request, response, handlers),
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-skill-center: http routes')
  })
}

/**
 * Resolve the effective invocation policy for one skill.
 *
 * A disabled skill is closed to both surfaces. An enabled skill still honours
 * what its own file declares, so skill-center can take a skill away but never
 * widen one whose author closed it.
 *
 * @param skill - library descriptor.
 * @param enabled - skill-center enablement.
 * @returns the invocation policy handed to the registry.
 */
function invocationOf(skill, enabled) {
  if (!enabled) return { modelInvocable: false, userInvocable: false }
  return { modelInvocable: skill.fileModelInvocable, userInvocable: skill.fileUserInvocable }
}

/**
 * Build the request fence shared by every route.
 *
 * The decision belongs to the deployment, not to this plugin: `connection`
 * answers a status for a request the host refuses — wrong authority, a
 * cross-site browser marker, or no browser session — and `undefined` for one it
 * accepts. This is deliberately the only opinion the routes have, so the API is
 * exactly as reachable as the rest of the host and no more.
 *
 * The service is read per request rather than captured: what matters is the
 * fence the composition provides now.
 *
 * @param ctx - the context carrying the `connection` service.
 * @returns the fence: it writes the refusal onto the response and reports whether it did.
 */
function fenceOf(ctx) {
  return (request, response) => {
    const rejection = ctx.connection.requestRejection(request)
    if (rejection === undefined) return false
    response.writeHead(rejection, { 'content-length': 0, 'cache-control': 'no-store' })
    response.end()
    return true
  }
}

/**
 * Serve the current library snapshot.
 *
 * Scanning is also the moment the host learns the library may have moved on:
 * the registry caches provider catalogs, and the library root sits outside
 * every native root's watcher, so a skill dropped in by hand would otherwise
 * stay invisible to the model until something else invalidated. Invalidating
 * here makes the panel's refresh mean "resync the model's catalog too"; it is
 * idempotent, and consumers only rewrite the prompt catalog when the digest
 * actually changed.
 *
 * @param request - incoming request.
 * @param response - response to write.
 * @param host - plugin surfaces the handler needs.
 */
async function handleRead(request, response, host) {
  if (host.fence(request, response)) return
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'GET required' }, { allow: 'GET, HEAD' })
    return
  }
  try {
    const payload = await host.snapshot()
    host.invalidate()
    sendJson(response, 200, payload)
  } catch (error) {
    host.log?.warn?.(`listing the skill library failed: ${error.message}`)
    sendJson(response, 500, { error: `cannot read the skill library: ${error.message}` })
  }
}

/**
 * Serve the import sources: what each one is, and what it holds.
 *
 * Scanned per request rather than cached: a source is somebody else's directory
 * and can change under us, and the listing is what the user acts on.
 *
 * @param request - incoming request.
 * @param response - response to write.
 * @param host - plugin surfaces the handler needs.
 */
async function handleSources(request, response, host) {
  if (host.fence(request, response)) return
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'GET required' }, { allow: 'GET, HEAD' })
    return
  }
  try {
    const { rows } = await host.describe()
    const imported = new Set(rows.map((row) => row.name))
    const sources = await describeSources(await host.store.sources(), defaultSources(host.dshHome), host.libraryDir, imported)
    sendJson(response, 200, { sources })
  } catch (error) {
    host.log?.warn?.(`listing import sources failed: ${error.message}`)
    sendJson(response, 500, { error: `cannot read the import sources: ${error.message}` })
  }
}

/**
 * Apply one mutation and answer with the refreshed snapshot.
 *
 * A single dispatcher rather than a route per operation: every action shares
 * the same three steps (validate, apply to the store or the library, persist
 * and resync), and keeping them in one place is what makes the read-after-write
 * snapshot identical for all of them.
 *
 * @param request - incoming request.
 * @param response - response to write.
 * @param host - plugin surfaces the handler needs.
 */
async function handleMutate(request, response, host) {
  if (host.fence(request, response)) return
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'POST required' }, { allow: 'POST' })
    return
  }
  // Belt to the fence's braces: a request that cannot even claim JSON is a
  // cross-origin `simple request` that never faced a preflight, and refusing it
  // here means such a request never reaches the body parser or the dispatcher.
  if (!isJsonRequest(request)) {
    sendJson(response, 415, { error: 'the request body must be declared as application/json' })
    return
  }
  let body
  try {
    body = await readJsonBody(request)
  } catch (error) {
    sendJson(response, 400, { error: error.message })
    return
  }

  try {
    const result = await applyMutation(body, host)
    host.invalidate()
    sendJson(response, 200, { ...(await host.snapshot()), ...result })
  } catch (error) {
    if (error instanceof CategoryError || error instanceof LibraryError || error instanceof SourceError || error instanceof InvalidSkillError) {
      sendJson(response, 400, { error: error.message })
      return
    }
    if (error instanceof RequestError) {
      sendJson(response, error.status, { error: error.message })
      return
    }
    host.log?.warn?.(`mutation ${String(body?.action)} failed: ${error.message}`)
    sendJson(response, 500, { error: `the operation failed: ${error.message}` })
  }
}

/** Raised for a request that is well-formed JSON but not a valid command. */
class RequestError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param message - user-facing reason.
   */
  constructor(status, message) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

/**
 * Dispatch one mutation command.
 * @param body - parsed request body.
 * @param host - plugin surfaces the handler needs.
 * @returns extra fields merged into the response snapshot.
 */
async function applyMutation(body, host) {
  const action = body?.action
  switch (action) {
    case 'skills.enabled': {
      const names = await knownNames(body, host)
      if (typeof body.enabled !== 'boolean') throw new RequestError(400, '"enabled" must be a boolean')
      await host.store.setEnabled(names, body.enabled)
      return { changed: names }
    }
    case 'skills.category': {
      const names = await knownNames(body, host)
      const categoryId = body.categoryId ?? null
      await host.store.setCategory(names, categoryId)
      return { changed: names }
    }
    case 'skills.uninstall': {
      const names = nameList(body.names)
      const removed = []
      for (const name of names) removed.push(await uninstallSkill(host.libraryDir, name))
      // Drop the records even when the files were already gone, so a stale
      // enabled/category row cannot outlive its skill.
      await host.store.forget(names)
      return { removed }
    }
    case 'skills.create': {
      const name = requireName(body.name)
      const categoryId = body.categoryId ?? null
      // The body is arbitrary Markdown and can be long; it rides the same
      // request cap as everything else, which is why that cap is generous.
      const created = await createSkill(host.libraryDir, name, body.description, body.body)
      if (categoryId !== null) await host.store.setCategory([name], categoryId)
      return { created: created.name }
    }
    case 'categories.create': {
      const parentId = body.parentId ?? null
      const created = await host.store.createCategory(parentId, body.name)
      return { createdCategory: created.id }
    }
    case 'categories.rename': {
      await host.store.renameCategory(requireId(body.id), body.name)
      return {}
    }
    case 'categories.delete': {
      const deleted = await host.store.deleteCategory(requireId(body.id))
      return { removedCategories: deleted.removed }
    }
    case 'categories.move': {
      await host.store.moveCategory(requireId(body.id), body.parentId ?? null, body.index)
      return {}
    }
    case 'sources.add': {
      const sourcePath = resolveSourcePath(body.path, host.libraryDir)
      // A built-in source is already listed and is not the user's to remove, so
      // adding its path must not store a shadow row the UI cannot act on. This
      // is checked before existence on purpose: "it is already a source" is the
      // more useful answer for a directory that is merely not there yet.
      const builtIn = defaultSources(host.dshHome).some((entry) => sourceKey(entry.path) === sourceKey(sourcePath))
      if (builtIn) return { addedSource: sourceIdOf(sourcePath), sourceWasNew: false }
      // A typo has to fail here, while the user can still fix it — not turn
      // into a permanently greyed-out chip nobody can explain.
      if (!(await isDirectory(sourcePath))) throw new SourceError(`no directory at ${sourcePath}`)
      const label = typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : path.basename(sourcePath)
      const added = await host.store.addSource(sourcePath, label)
      return { addedSource: added.id, sourceWasNew: added.added }
    }
    case 'sources.remove': {
      await host.store.removeSource(requireId(body.id))
      return {}
    }
    case 'skills.import': {
      return await importIntoLibrary(body, host)
    }
    default:
      throw new RequestError(400, `unknown action ${JSON.stringify(action ?? null)}`)
  }
}

/**
 * Copy skills from a source directory into the library.
 *
 * The browser sends a source id and skill names — never a path and never a file
 * — and the paths come back out of a scan this process just ran. Importing is
 * per skill rather than all-or-nothing so one name clash cannot lose the rest of
 * a batch; every name comes back with what happened to it.
 *
 * @param body - parsed request body.
 * @param host - plugin surfaces the handler needs.
 * @returns the per-skill outcome.
 */
async function importIntoLibrary(body, host) {
  const names = nameList(body.names)
  const source = await sourceByPath(host, requireId(body.sourceId))
  const { skills } = await scanSource(source.path)
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const overwrite = body.overwrite === true
  const categoryId = body.categoryId ?? null

  const imported = []
  const skipped = []
  for (const name of names) {
    const found = byName.get(name)
    if (found === undefined) {
      skipped.push({ name, reason: 'not found in this source' })
      continue
    }
    try {
      const result = await importSkill(host.libraryDir, found, { overwrite })
      if (categoryId !== null) await host.store.setCategory([result.name], categoryId)
      imported.push({ name: result.name, replaced: result.replaced })
    } catch (error) {
      if (error instanceof LibraryError || error instanceof InvalidSkillError) {
        skipped.push({ name, reason: error.message })
        continue
      }
      throw error
    }
  }
  return { imported, skipped }
}

/**
 * Resolve one configured source by id.
 * @param host - plugin surfaces the handler needs.
 * @param id - source id.
 * @returns the source descriptor.
 */
async function sourceByPath(host, id) {
  const configured = await host.store.sources()
  const candidates = [...defaultSources(host.dshHome), ...configured].map((entry) => ({
    id: entry.id ?? sourceIdOf(entry.path),
    label: entry.label ?? path.basename(entry.path),
    path: path.resolve(entry.path),
  }))
  const source = candidates.find((entry) => entry.id === id)
  if (source === undefined) throw new RequestError(404, `unknown import source ${JSON.stringify(id)}`)
  return source
}

/**
 * Read a list of skill names and require that each one is in the library.
 * @param body - parsed request body.
 * @param host - plugin surfaces the handler needs.
 * @returns the validated names.
 */
async function knownNames(body, host) {
  const names = nameList(body.names)
  const { rows } = await host.describe()
  const known = new Set(rows.map((row) => row.name))
  for (const name of names) {
    if (!known.has(name)) throw new RequestError(404, `no skill named ${JSON.stringify(name)} in the library`)
  }
  return names
}

/**
 * Read a non-empty array of distinct strings.
 * @param value - candidate from the request body.
 * @returns the names.
 */
function nameList(value) {
  if (!Array.isArray(value) || value.length === 0) throw new RequestError(400, '"names" must be a non-empty array')
  const names = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') throw new RequestError(400, 'every entry of "names" must be a non-empty string')
    if (!names.includes(entry)) names.push(entry)
  }
  return names
}

/**
 * Read a valid skill name.
 * @param value - candidate from the request body.
 * @returns the name.
 */
function requireName(value) {
  if (typeof value !== 'string' || value === '') throw new RequestError(400, '"name" must be a non-empty string')
  return value
}

/**
 * Read a non-empty category id.
 * @param value - candidate from the request body.
 * @returns the id.
 */
function requireId(value) {
  if (typeof value !== 'string' || value === '') throw new RequestError(400, '"id" must be a non-empty string')
  return value
}

/**
 * Project one library descriptor onto the browser-facing wire shape.
 * @param row - library row.
 * @returns the JSON-serializable record.
 */
function toWire(row) {
  return {
    name: row.name,
    description: row.description,
    whenToUse: row.whenToUse,
    enabled: row.enabled,
    modelInvocable: row.invocation.modelInvocable,
    userInvocable: row.invocation.userInvocable,
    categoryId: row.categoryId,
    path: row.file,
    bytes: row.bytes,
    mtimeMs: row.mtimeMs,
    nameMismatch: row.nameMismatch,
  }
}

/**
 * Read the skill file path carried by a registry candidate.
 * @param candidate - candidate handed back by the registry.
 * @returns the absolute path, or undefined.
 */
function locatorOf(candidate) {
  if (typeof candidate?.locator === 'string') return candidate.locator
  if (typeof candidate?.path === 'string') return candidate.path
  return undefined
}

/**
 * Derive the fallback skill name for a file path.
 * @param file - absolute path to a skill file.
 * @returns the bundle directory name, or the flat file's stem.
 */
function fallbackNameOf(file) {
  const base = path.basename(file)
  return base.toLowerCase() === 'skill.md' ? path.basename(path.dirname(file)) : base.slice(0, base.length - path.extname(base).length)
}

/**
 * Whether a request declares itself as JSON.
 *
 * The declared type is what matters, and parameters (`; charset=utf-8`) are
 * ignored: the point is to reject a body whose type is not JSON at all.
 *
 * @param request - incoming request.
 * @returns true when `content-type` is `application/json`.
 */
function isJsonRequest(request) {
  const declared = request.headers?.['content-type']
  if (typeof declared !== 'string') return false
  return declared.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/**
 * Buffer and parse a JSON request body.
 * @param request - incoming request.
 * @returns the parsed body.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * Write one JSON response.
 * @param response - response to write.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 * @param headers - extra response headers.
 */
function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

/**
 * Acquire a named logger without making it a hard dependency.
 * @param ctx - host context.
 * @returns a logger, or undefined when the service is absent.
 */
function loggerOf(ctx) {
  try {
    return typeof ctx.logger === 'function' ? ctx.logger(name) : undefined
  } catch {
    return undefined
  }
}
