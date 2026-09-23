/**
 * Host-half smoke test — runs on plain Node, no dsh process required.
 *
 * It loads the real plugin modules against a temporary `DSH_HOME` and a fake
 * Cordis context, then drives both surfaces the way the harness does: through
 * `ctx.skills.registerProvider` for the model side, and through the registered
 * web routes for the browser side.
 *
 *   node plugins/dsh-skill-center/test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'
import { scanLibrary } from '../lib/library.js'
import { splitFrontmatter, readBoolean, readString } from '../lib/frontmatter.js'
import { isEnabled, STATE_VERSION, SkillStateStore } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const checked = []
let failures = 0

/**
 * Record one assertion group.
 * @param label - what was checked.
 * @param run - assertion body.
 */
async function check(label, run) {
  try {
    await run()
    checked.push(label)
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${label}\n      ${error.message}`)
  }
}

/** @returns a fresh sandbox root. */
async function sandbox() {
  return await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-center-'))
}

/**
 * Write one skill bundle under a library root.
 * @param library - library root.
 * @param name - skill directory name.
 * @param frontmatter - frontmatter body (without fences).
 * @param body - markdown body.
 */
async function writeSkill(library, name, frontmatter, body = '# Body\n') {
  await mkdir(path.join(library, name), { recursive: true })
  await writeFile(path.join(library, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`, 'utf8')
}

/**
 * The request facts a real browser sends for a same-origin, authenticated
 * panel call: loopback authority, matching Origin, same-site fetch metadata,
 * and the session cookie the connection carrier handed the page at index time.
 */
const TRUSTED_REQUEST = {
  host: '127.0.0.1:3080',
  origin: 'http://127.0.0.1:3080',
  'sec-fetch-site': 'same-origin',
  cookie: 'dsh-auth=test-session',
}

/**
 * Stand-in for the host's `connection` service.
 *
 * The real one lives in `@deepseek-ai/dsh-client-connection`, and this double
 * deliberately does *not* reproduce its Host/Origin/`trustedHosts` policy — a
 * second copy of a policy is a copy that can drift. It answers only the two
 * verdicts the plugin's contract has to distinguish, so the checks below can
 * watch the plugin consult the fence and honour its answer. The policy itself
 * is exercised against the genuine service in `test/host-integration.mjs`.
 *
 * @returns the double, with the requests it was asked about.
 */
function fenceStub() {
  const requests = []
  return {
    requests,
    requestRejection(request) {
      requests.push(request)
      const headers = request.headers ?? {}
      if (headers['sec-fetch-site'] === 'cross-site') return 403
      return headers.cookie === TRUSTED_REQUEST.cookie ? undefined : 401
    },
  }
}

/**
 * Build a fake Cordis context that records what the plugin registers.
 *
 * `inject` models the real thing rather than waving the dependency list
 * through: a callback runs only once *every* dependency it names is
 * available, which is what makes "the routes stay unregistered while the
 * fence is missing" a property of the plugin and not of this double.
 *
 * @param options - `withFence: false` withholds the connection service.
 * @returns the fake context and the observations the checks make.
 */
function createHost({ withFence = true } = {}) {
  const routes = new Map()
  const requested = []
  const connection = withFence ? fenceStub() : null
  const available = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    ...(connection === null ? {} : { connection }),
  }
  let provider
  let invalidations = 0
  // The real registry calls the factory synchronously inside apply(), so the
  // plugin's invalidation handle is live from the moment apply() returns.
  const control = {
    signal: new AbortController().signal,
    invalidate: () => {
      invalidations += 1
    },
  }
  // Cordis accepts a disposer, a promise of one, an iterable of them, or
  // nothing at all. Anything else is a boot-time TypeError in the real host.
  const checkedEffect = (run) => {
    const produced = run()
    assert.ok(
      produced === undefined || produced === null || typeof produced === 'function',
      `effect returned an invalid shape (${typeof produced}); the host would throw "Invalid effect"`,
    )
    return produced
  }
  const ctx = {
    logger: undefined,
    skills: {
      registerProvider: (create) => {
        provider = create(control)
        return () => {
          provider = undefined
        }
      },
    },
    effect: checkedEffect,
    inject: (deps, callback) => {
      requested.push([...deps])
      if (!deps.every((dep) => Object.hasOwn(available, dep))) return
      callback({ ...Object.fromEntries(deps.map((dep) => [dep, available[dep]])), effect: checkedEffect })
    },
  }
  return {
    ctx,
    routes,
    requested,
    connection,
    invalidations: () => invalidations,
    provider: () => {
      assert.ok(provider !== undefined, 'plugin did not register a skill provider')
      return provider
    },
  }
}

/** Build a fake `IncomingMessage` for a JSON request. */
function fakeRequest(method, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Build a fake `ServerResponse` that records status, headers, and body. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
    },
    end(text) {
      this.body = text ?? ''
    },
  }
}

/**
 * Drive one registered route.
 *
 * The default headers are the ones a real same-origin, authenticated browser
 * panel sends — including `content-type: application/json` on a body — so a
 * check that cares about the fence overrides exactly the header it is about.
 *
 * @param route - route from the fake web server.
 * @param method - HTTP method.
 * @param body - optional JSON body.
 * @param headers - request headers, merged over the trusted defaults.
 * @returns the fake response and its parsed JSON payload.
 */
async function call(route, method, body, headers = {}) {
  const response = fakeResponse()
  const sent = { ...TRUSTED_REQUEST, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  await route.handler(fakeRequest(method, body, sent), response)
  return { response, payload: response.body === '' ? undefined : JSON.parse(response.body) }
}

console.log('dsh-skill-center host smoke test\n')

// ---------------------------------------------------------------- frontmatter
await check('frontmatter: scalars, quotes, comments, block scalars', () => {
  const { data, body, present } = splitFrontmatter(
    [
      '---',
      'name: demo-skill',
      'description: "quoted: value" # trailing comment',
      'whenToUse: >',
      '  first line',
      '  second line',
      'metadata:',
      '  owner: someone',
      '---',
      '',
      '# Heading',
    ].join('\n'),
  )
  assert.equal(present, true)
  assert.equal(readString(data, 'name'), 'demo-skill')
  assert.equal(readString(data, 'description'), 'quoted: value')
  assert.equal(readString(data, 'whenToUse'), 'first line second line')
  assert.equal(data.has('metadata'), true)
  assert.equal(body, '# Heading')
})

await check('frontmatter: invocation booleans are strict', () => {
  const strict = splitFrontmatter('---\nname: a\nuser-invocable: OFF\n---\n').data
  assert.deepEqual(readBoolean(strict, 'user-invocable'), { state: 'set', value: false })
  const sloppy = splitFrontmatter('---\nname: a\ndisable-model-invocation: maybe\n---\n').data
  assert.equal(readBoolean(sloppy, 'disable-model-invocation').state, 'invalid')
  const absent = splitFrontmatter('---\nname: a\n---\n').data
  assert.deepEqual(readBoolean(absent, 'user-invocable'), { state: 'absent' })
})

await check('frontmatter: a file without fences keeps its whole body', () => {
  const { data, body, present } = splitFrontmatter('# Just markdown\n')
  assert.equal(present, false)
  assert.equal(data.size, 0)
  assert.equal(body, '# Just markdown\n')
})

// -------------------------------------------------------------------- library
await check('library: bundles and flat files are found, junk is warned about', async () => {
  const root = await sandbox()
  try {
    const library = path.join(root, 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: First skill.')
    await writeFile(path.join(library, 'beta-skill.md'), '---\nname: beta-skill\ndescription: Flat skill.\n---\n\nbody\n', 'utf8')
    await writeSkill(library, 'broken', 'name: broken')
    await writeSkill(library, 'bad name', 'name: bad name\ndescription: Bad grammar.')
    const { skills, warnings } = await scanLibrary(library)
    assert.deepEqual(skills.map((skill) => skill.name), ['alpha-skill', 'beta-skill'])
    assert.equal(warnings.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('library: a missing root is an empty library, not an error', async () => {
  const { skills, warnings } = await scanLibrary(path.join(os.tmpdir(), 'dsh-skill-center-does-not-exist'))
  assert.deepEqual(skills, [])
  assert.deepEqual(warnings, [])
})

// ---------------------------------------------------------------------- store
await check('store: absent records mean enabled, and writes are atomic', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    const store = new SkillStateStore(file, undefined)
    const initial = await store.read()
    assert.equal(isEnabled(initial, 'anything'), true)
    // A bare name is accepted alongside an array; it must never be iterated
    // character by character.
    await store.setEnabled('alpha-skill', false)
    const reread = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(reread.skills['alpha-skill'].enabled, false)
    assert.deepEqual(Object.keys(reread.skills), ['alpha-skill'])
    assert.equal(reread.version, STATE_VERSION)
    assert.deepEqual(reread.categories, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: unknown keys survive a round trip', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    await writeFile(
      file,
      JSON.stringify({ version: 2, categories: [{ id: 'c1', name: '工具' }], skills: { a: { enabled: true, note: 'keep me' } }, futureKey: 7 }),
      'utf8',
    )
    const store = new SkillStateStore(file, undefined)
    await store.setEnabled(['a'], false)
    const reread = JSON.parse(await readFile(file, 'utf8'))
    // Unknown top-level and unknown per-skill keys are not this plugin's to drop.
    assert.equal(reread.futureKey, 7)
    assert.equal(reread.skills.a.note, 'keep me')
    assert.equal(reread.skills.a.enabled, false)
    // `categories` is modelled now, so it is normalized to the tree shape
    // rather than passed through verbatim.
    assert.deepEqual(reread.categories, [{ id: 'c1', name: '工具', children: [] }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: a corrupt file is kept aside rather than silently dropped', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    await writeFile(file, '{ not json', 'utf8')
    const warnings = []
    const store = new SkillStateStore(file, { warn: (message) => warnings.push(message) })
    assert.deepEqual(await store.read(), { version: STATE_VERSION, categories: [], skills: {}, sources: [] })
    assert.equal(warnings.length, 1)
    const kept = await readdir(root)
    assert.ok(kept.some((name) => name.startsWith('state.json.corrupt-')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- plugin wiring
await check('plugin: the provider lists every skill and gates invocation by state', async () => {
  const root = await sandbox()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = root
    const library = path.join(root, 'skill-center', 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: First skill.\nwhenToUse: When testing.')
    await writeSkill(library, 'beta-skill', 'name: beta-skill\ndescription: Second skill.')
    await writeSkill(library, 'closed-skill', 'name: closed-skill\ndescription: Model closed.\ndisable-model-invocation: true')
    await writeSkill(library, 'quiet-skill', 'name: quiet-skill\ndescription: Closed by skill-center.')
    // An enablement record already on disk is what the plugin starts from.
    await writeFile(
      path.join(root, 'skill-center', 'state.json'),
      JSON.stringify({ version: 2, skills: { 'quiet-skill': { enabled: false } } }),
      'utf8',
    )

    const host = createHost()
    apply(host.ctx)
    const provider = host.provider()
    assert.equal(provider.name, 'skill-center')

    const candidates = await provider.list({})
    assert.deepEqual(candidates.map((entry) => entry.name), ['alpha-skill', 'beta-skill', 'closed-skill', 'quiet-skill'])
    assert.equal(candidates.every((entry) => entry.rank === 350 && entry.source === 'custom'), true)
    assert.equal(candidates.every((entry) => typeof entry.locator === 'string'), true)

    const byName = (name) => candidates.find((entry) => entry.name === name)
    // Enabled and open on both surfaces.
    assert.deepEqual(byName('alpha-skill').invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(byName('alpha-skill').whenToUse, 'When testing.')
    // The file closed the model side: skill-center must not widen it.
    assert.deepEqual(byName('closed-skill').invocation, { modelInvocable: false, userInvocable: true })
    // skill-center closed both sides.
    assert.deepEqual(byName('quiet-skill').invocation, { modelInvocable: false, userInvocable: false })
    // Never filtered: a disabled skill stays visible so the panel can re-enable it.
    assert.equal(candidates.length, 4)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

await check('plugin: get() returns the body and a directory resource base', async () => {
  const root = await sandbox()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = root
    const library = path.join(root, 'skill-center', 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: First skill.', '# Alpha\n\nDo the thing.\n')
    const host = createHost()
    apply(host.ctx)
    const provider = host.provider()
    const [candidate] = await provider.list({})
    const definition = await provider.get(candidate, {})
    assert.equal(definition.content, '# Alpha\n\nDo the thing.\n')
    assert.deepEqual(definition.resourceBase, { kind: 'directory', path: path.join(library, 'alpha-skill') })
    assert.equal(definition.provider, 'skill-center')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

await check('plugin: the browser API reads, mutates, invalidates, and rejects bad input', async () => {
  const root = await sandbox()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = root
    const library = path.join(root, 'skill-center', 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: First skill.')
    await writeSkill(library, 'beta-skill', 'name: beta-skill\ndescription: Second skill.')

    const host = createHost()
    apply(host.ctx)
    const readRoute = host.routes.get('/dsh-skill-center/api/library')
    const mutateRoute = host.routes.get('/dsh-skill-center/api/mutate')
    assert.ok(readRoute !== undefined, 'read route missing')
    assert.ok(mutateRoute !== undefined, 'mutate route missing')

    const beforeRead = host.invalidations()
    const read = await call(readRoute, 'GET')
    assert.equal(read.response.statusCode, 200)
    assert.equal(read.payload.libraryDir, library)
    assert.deepEqual(read.payload.categories, [])
    assert.deepEqual(
      read.payload.skills.map((skill) => [skill.name, skill.enabled, skill.categoryId]),
      [
        ['alpha-skill', true, null],
        ['beta-skill', true, null],
      ],
    )
    assert.equal(read.response.headers['cache-control'], 'no-store')
    // Reading re-scans disk, so it also resyncs the registry's cached catalog:
    // a skill dropped into the library by hand must reach the model on refresh.
    assert.equal(host.invalidations(), beforeRead + 1, 'reading did not resync the registry catalog')

    // Method and payload guards.
    assert.equal((await call(readRoute, 'POST')).response.statusCode, 405)
    assert.equal((await call(mutateRoute, 'GET')).response.statusCode, 405)
    assert.equal((await call(mutateRoute, 'POST', { action: 'nope' })).response.statusCode, 400)
    assert.equal((await call(mutateRoute, 'POST', {})).response.statusCode, 400)
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.enabled', names: ['alpha-skill'] })).response.statusCode, 400)
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.enabled', names: [], enabled: true })).response.statusCode, 400)
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.enabled', names: ['ghost'], enabled: true })).response.statusCode, 404)
    assert.equal((await call(mutateRoute, 'POST', { action: 'categories.rename', id: 'x', name: 'y' })).response.statusCode, 400)

    // Batch enablement.
    const beforeMutate = host.invalidations()
    const disabled = await call(mutateRoute, 'POST', { action: 'skills.enabled', names: ['alpha-skill', 'beta-skill'], enabled: false })
    assert.equal(disabled.response.statusCode, 200)
    assert.deepEqual(disabled.payload.changed, ['alpha-skill', 'beta-skill'])
    assert.equal(disabled.payload.skills.every((skill) => skill.enabled === false), true)
    assert.equal(host.invalidations(), beforeMutate + 1, 'the registry was not invalidated after a write')

    // Create categories, nest one, file a skill under it.
    const tool = await call(mutateRoute, 'POST', { action: 'categories.create', name: '工具' })
    assert.equal(tool.response.statusCode, 200)
    const toolId = tool.payload.createdCategory
    assert.equal(tool.payload.categories[0].name, '工具')

    const nested = await call(mutateRoute, 'POST', { action: 'categories.create', name: '后台', parentId: toolId })
    const nestedId = nested.payload.createdCategory
    assert.deepEqual(nested.payload.categories[0].children.map((node) => node.name), ['后台'])

    const filed = await call(mutateRoute, 'POST', { action: 'skills.category', names: ['alpha-skill'], categoryId: nestedId })
    assert.equal(filed.response.statusCode, 200)
    assert.equal(filed.payload.skills.find((skill) => skill.name === 'alpha-skill').categoryId, nestedId)

    // Renaming keeps the pointer, because the pointer is the id.
    const renamed = await call(mutateRoute, 'POST', { action: 'categories.rename', id: nestedId, name: '运维' })
    assert.equal(renamed.payload.categories[0].children[0].name, '运维')
    assert.equal(renamed.payload.skills.find((skill) => skill.name === 'alpha-skill').categoryId, nestedId)

    // Deleting the parent takes the subtree; the skill falls back to the
    // uncategorized container instead of vanishing.
    const deleted = await call(mutateRoute, 'POST', { action: 'categories.delete', id: toolId })
    assert.deepEqual(deleted.payload.removedCategories, [toolId, nestedId])
    assert.deepEqual(deleted.payload.categories, [])
    assert.equal(deleted.payload.skills.find((skill) => skill.name === 'alpha-skill').categoryId, null)
    assert.equal(deleted.payload.skills.length, 2, 'deleting a folder must not delete skills')

    // Create a skill (header and body both come from the dialog), then uninstall it.
    const created = await call(mutateRoute, 'POST', {
      action: 'skills.create',
      name: 'gamma-skill',
      description: 'Made by the test.',
      body: '# Gamma\n\nDo the thing.\n',
    })
    assert.equal(created.response.statusCode, 200)
    assert.equal(created.payload.created, 'gamma-skill')
    assert.equal(created.payload.skills.find((skill) => skill.name === 'gamma-skill').description, 'Made by the test.')
    assert.equal(
      await readFile(path.join(library, 'gamma-skill', 'SKILL.md'), 'utf8'),
      '---\nname: gamma-skill\ndescription: "Made by the test."\n---\n\n# Gamma\n\nDo the thing.\n',
    )
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.create', name: 'gamma-skill' })).response.statusCode, 400)

    // Create without a name is refused before anything touches the disk.
    const unnamed = await call(mutateRoute, 'POST', { action: 'skills.create', description: 'no name' })
    assert.equal(unnamed.response.statusCode, 400)
    assert.equal((await readdir(library)).includes('undefined'), false)

    const removed = await call(mutateRoute, 'POST', { action: 'skills.uninstall', names: ['gamma-skill'] })
    assert.equal(removed.response.statusCode, 200)
    assert.deepEqual(removed.payload.removed, [{ name: 'gamma-skill', removed: ['bundle'] }])
    assert.equal(removed.payload.skills.some((skill) => skill.name === 'gamma-skill'), false)

    // A traversal spelling is refused rather than escaped.
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.uninstall', names: ['../escape'] })).response.statusCode, 400)
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.create', name: '../escape' })).response.statusCode, 400)

    // Everything above survived to disk, and the provider never learnt about
    // categories — organisation is not visibility.
    const persisted = JSON.parse(await readFile(path.join(root, 'skill-center', 'state.json'), 'utf8'))
    assert.equal(persisted.version, STATE_VERSION)
    assert.equal(persisted.skills['alpha-skill'].enabled, false)

    const provider = host.provider()
    const candidates = await provider.list({})
    assert.deepEqual(candidates.map((entry) => entry.name), ['alpha-skill', 'beta-skill'])
    assert.equal(candidates.every((entry) => !('categoryId' in entry)), true, 'a category leaked into a registry candidate')
    assert.deepEqual(candidates.find((entry) => entry.name === 'alpha-skill').invocation, {
      modelInvocable: false,
      userInvocable: false,
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

await check('plugin: import sources over HTTP', async () => {
  const root = await sandbox()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = root
    const library = path.join(root, 'skill-center', 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: Already here.')

    // A source outside the library, in the shape Claude Code uses.
    const source = path.join(root, 'outside', '.claude', 'skills')
    await writeSkill(source, 'alpha-skill', 'name: alpha-skill\ndescription: The source copy.')
    await writeSkill(source, 'fresh-skill', 'name: fresh-skill\ndescription: Not here yet.')
    await writeSkill(source, 'broken-skill', 'name: broken-skill')

    const host = createHost()
    apply(host.ctx)
    const readRoute = host.routes.get('/dsh-skill-center/api/library')
    const sourcesRoute = host.routes.get('/dsh-skill-center/api/sources')
    const mutateRoute = host.routes.get('/dsh-skill-center/api/mutate')
    assert.ok(sourcesRoute !== undefined, 'sources route missing')

    // The listing marks what is already imported.
    const added = await call(mutateRoute, 'POST', { action: 'sources.add', path: source })
    assert.equal(added.response.statusCode, 200)
    assert.equal(added.payload.sourceWasNew, true)
    const sourceId = added.payload.addedSource

    const listed = await call(sourcesRoute, 'GET')
    assert.equal(listed.response.statusCode, 200)
    const custom = listed.payload.sources.find((entry) => entry.id === sourceId)
    assert.ok(custom !== undefined, 'the added source is missing from the listing')
    assert.equal(custom.custom, true)
    assert.deepEqual(
      custom.skills.map((skill) => [skill.name, skill.imported]),
      [
        ['alpha-skill', true],
        ['fresh-skill', false],
      ],
    )
    // An unusable entry is reported, not silently dropped.
    assert.equal(custom.invalid.length, 1)
    assert.match(custom.invalid[0].reason, /description/)

    // Import: the clash is skipped, the new one copied, the unknown one reported.
    const imported = await call(mutateRoute, 'POST', { action: 'skills.import', sourceId, names: ['fresh-skill', 'alpha-skill', '../escape'] })
    assert.equal(imported.response.statusCode, 200)
    assert.deepEqual(imported.payload.imported, [{ name: 'fresh-skill', replaced: false }])
    assert.deepEqual(imported.payload.skipped, [
      { name: 'alpha-skill', reason: 'a skill named "alpha-skill" is already in the library' },
      { name: '../escape', reason: 'not found in this source' },
    ])
    assert.equal(imported.payload.skills.some((skill) => skill.name === 'fresh-skill'), true)
    // A client-supplied name never becomes a path.
    assert.equal(await readFile(path.join(library, 'alpha-skill', 'SKILL.md'), 'utf8').then((text) => text.includes('Already here.')), true)

    // Overwriting is opt-in, and carries the imported category.
    const category = await call(mutateRoute, 'POST', { action: 'categories.create', name: '工具' })
    const categoryId = category.payload.createdCategory
    const replaced = await call(mutateRoute, 'POST', { action: 'skills.import', sourceId, names: ['alpha-skill'], overwrite: true, categoryId })
    assert.equal(replaced.response.statusCode, 200)
    assert.deepEqual(replaced.payload.imported, [{ name: 'alpha-skill', replaced: true }])
    const alpha = replaced.payload.skills.find((skill) => skill.name === 'alpha-skill')
    assert.equal(alpha.description, 'The source copy.')
    assert.equal(alpha.categoryId, categoryId)

    // Guards: the path must be absolute, must exist, and must not be the library.
    assert.equal((await call(mutateRoute, 'POST', { action: 'sources.add', path: 'relative/dir' })).response.statusCode, 400)
    assert.equal((await call(mutateRoute, 'POST', { action: 'sources.add', path: library })).response.statusCode, 400)
    const typo = await call(mutateRoute, 'POST', { action: 'sources.add', path: path.join(root, 'no', 'such', 'dir') })
    assert.equal(typo.response.statusCode, 400, 'a typo was stored as a dead source instead of being refused at the door')
    assert.match(typo.payload.error, /no directory/)
    assert.equal((await call(mutateRoute, 'POST', { action: 'skills.import', sourceId: 'nope', names: ['fresh-skill'] })).response.statusCode, 404)

    // A built-in path is not stored as a removable shadow entry — and that is
    // answered even though `<dshHome>/skills` does not exist on this machine.
    const builtIn = await call(mutateRoute, 'POST', { action: 'sources.add', path: path.join(root, 'skills') })
    assert.equal(builtIn.response.statusCode, 200)
    assert.equal(builtIn.payload.sourceWasNew, false)

    const removed = await call(mutateRoute, 'POST', { action: 'sources.remove', id: sourceId })
    assert.equal(removed.response.statusCode, 200)
    const after = await call(sourcesRoute, 'GET')
    assert.equal(after.payload.sources.some((entry) => entry.id === sourceId), false)
    // Removing a source never touches the directory.
    assert.equal((await readdir(source)).includes('fresh-skill'), true)

    // The library still reads, and the import stayed a copy.
    const finalState = await call(readRoute, 'GET')
    assert.deepEqual(finalState.payload.skills.map((skill) => skill.name).sort(), ['alpha-skill', 'fresh-skill'])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- request fence
await check('plugin: the routes wait for the connection fence as well as the web server', () => {
  const host = createHost()
  apply(host.ctx)
  // A `webServer`-only dependency list is the bug: it registers the routes on a
  // host that has no fence to offer, which is the same as having no fence.
  assert.deepEqual(host.requested, [['webServer', 'connection']], 'the routes must depend on the connection fence too')
  assert.deepEqual([...host.routes.keys()].sort(), [
    '/dsh-skill-center/api/library',
    '/dsh-skill-center/api/mutate',
    '/dsh-skill-center/api/sources',
  ])
})

await check('plugin: no routes are registered when the connection fence is absent', () => {
  const host = createHost({ withFence: false })
  apply(host.ctx)
  // Degrading to an unfenced registration is the other half of the bug: on a
  // headless composition there is nobody to ask, so there is nothing to serve.
  assert.deepEqual([...host.routes.keys()], [], 'the plugin registered unfenced routes')
})

await check('plugin: a cross-site request is refused before it reaches the library', async () => {
  const root = await sandbox()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = root
    const library = path.join(root, 'skill-center', 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: Kept on disk.')

    const host = createHost()
    apply(host.ctx)
    const mutateRoute = host.routes.get('/dsh-skill-center/api/mutate')

    // A cross-site "simple request": no preflight, so nothing upstream stops it.
    // The fence is the only thing standing between it and `uninstallSkill`.
    const hostile = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
    const uninstall = await call(mutateRoute, 'POST', { action: 'skills.uninstall', names: ['alpha-skill'] }, hostile)
    assert.equal(uninstall.response.statusCode, 403)
    assert.equal(host.connection.requests.length, 1, 'the mutation route never asked the fence')
    assert.equal(
      (await readdir(library)).includes('alpha-skill'),
      true,
      'a cross-site request uninstalled a skill from disk',
    )

    // Reading is fenced too: the sources listing is a directory probe.
    const read = await call(host.routes.get('/dsh-skill-center/api/sources'), 'GET', undefined, hostile)
    assert.equal(read.response.statusCode, 403)
    assert.equal(host.connection.requests.length, 2, 'the sources route never asked the fence')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

await check('plugin: an unauthenticated or non-JSON mutation is refused', async () => {
  const root = await sandbox()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = root
    const library = path.join(root, 'skill-center', 'library')
    await writeSkill(library, 'alpha-skill', 'name: alpha-skill\ndescription: Kept on disk.')

    const host = createHost()
    apply(host.ctx)
    const mutateRoute = host.routes.get('/dsh-skill-center/api/mutate')
    const uninstall = { action: 'skills.uninstall', names: ['alpha-skill'] }

    // Same origin, but no browser session: the fence answers 401.
    const anonymous = await call(mutateRoute, 'POST', uninstall, { cookie: undefined })
    assert.equal(anonymous.response.statusCode, 401)
    assert.equal((await readdir(library)).includes('alpha-skill'), true, 'an unauthenticated request uninstalled a skill')

    // A session at last — but a body that cannot even claim to be JSON is
    // refused before it is read, so a preflight-free cross-origin form post
    // never gets a parser.
    const wrongType = await call(mutateRoute, 'POST', uninstall, { 'content-type': 'text/plain' })
    assert.equal(wrongType.response.statusCode, 415)
    assert.equal((await readdir(library)).includes('alpha-skill'), true, 'a non-JSON request uninstalled a skill')

    // The same command over the sanctioned shape still goes through, so the
    // fence is not simply refusing everything.
    const allowed = await call(mutateRoute, 'POST', uninstall)
    assert.equal(allowed.response.statusCode, 200)
    assert.equal((await readdir(library)).includes('alpha-skill'), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------- packaging
await check('packaging: manifest points at files that exist', async () => {
  const pkg = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-skill-center')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client/client.js')
  // `main` is written without the `./` prefix; both must name the same file.
  assert.equal(pkg.exports['.'].default, `./${pkg.main}`)
  for (const relative of [pkg.exports['./client'], pkg.exports['.'].default, pkg.dsh.bundle.patch]) {
    await readFile(path.join(here, '..', relative), 'utf8')
  }
})

console.log(`\n${checked.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
