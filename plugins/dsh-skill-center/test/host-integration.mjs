/**
 * Host integration test — boots the *real* Cordis + the *real* skill registry
 * from the installed harness and mounts this plugin into them.
 *
 * This is the closest check to "did it work after a restart" that can run
 * without restarting the GUI running the session: the plugin's `apply` runs
 * against a genuine `Context`, a genuine `ctx.effect` (with its effect-shape
 * validation), a genuine `ctx.inject`, and the genuine `SkillRegistry` that
 * `dsh-tool-skill` reads. The connection fence is the genuine
 * `HostConnectionService` too — only its `browserAuth` is stood in for, so the
 * Host/Origin/sec-fetch-site half of the decision is the shipped one. The web
 * server is the only stub, and it is provided *after* the plugin mounts —
 * which also proves the nested `webServer`/`connection` inject activates late
 * instead of leaving the routes unregistered.
 *
 * Skips (exit 0) when the harness packages cannot be located.
 *
 *   node plugins/dsh-skill-center/test/host-integration.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/**
 * Locate the installed `@deepseek-ai/*` package directory.
 *
 * The running `node` is not a reliable anchor on its own: nvm puts a symlink on
 * PATH (`C:\nvm4w\nodejs`) that may point at a Node version with no global dsh
 * installed at all, while the harness runs from a different version directory.
 * So the search covers the resolved executable, every PATH entry, and every
 * nvm version directory, and `DSH_PACKAGES` can pin it outright.
 *
 * @returns the directory, or undefined when this is not a dsh host.
 */
function findPackages() {
  const override = process.env.DSH_PACKAGES
  if (override !== undefined && override !== '') return override

  const execDirs = new Set([path.dirname(process.execPath)])
  try {
    execDirs.add(path.dirname(realpathSync(process.execPath)))
  } catch {
    // A missing executable path is not fatal; the other anchors remain.
  }

  const roots = []
  const addFrom = (dir) => {
    roots.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    roots.push(path.join(dir, 'node_modules', '@deepseek-ai'))
  }
  for (const dir of execDirs) addFrom(dir)
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry !== '') addFrom(entry)
  }
  for (const base of [process.env.NVM_HOME, process.env.NVM_DIR, path.join(os.homedir(), 'AppData', 'Local', 'nvm')]) {
    if (base === undefined || base === '') continue
    try {
      for (const version of readdirSync(base)) addFrom(path.join(base, version))
    } catch {
      // No nvm at this location.
    }
  }

  for (const candidate of roots) {
    if (
      existsSync(path.join(candidate, 'cordis', 'package.json')) &&
      existsSync(path.join(candidate, 'dsh-skill', 'package.json')) &&
      // The fence's own implementation, so the security checks below run the
      // real Host/Origin decision rather than this suite's idea of it.
      existsSync(path.join(candidate, 'dsh-client-connection', 'package.json'))
    ) {
      return candidate
    }
  }
  return undefined
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

/** Build a fake `ServerResponse`. */
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
 * Defaults to the headers a real same-origin, authenticated browser sends — a
 * body is declared as JSON, a session cookie is present — so a check about the
 * fence overrides exactly the header it is about.
 *
 * @param route - route from the stub web server.
 * @param method - HTTP method.
 * @param body - optional JSON body.
 * @param headers - request headers, merged over the trusted defaults.
 * @returns the response and parsed payload.
 */
async function call(route, method, body, headers = {}) {
  const response = fakeResponse()
  const sent = { ...TRUSTED_REQUEST, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  await route.handler(fakeRequest(method, body, sent), response)
  return { response, payload: response.body === '' ? undefined : JSON.parse(response.body) }
}

/** Let pending inject fibers settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

console.log('dsh-skill-center host integration test\n')

const packages = findPackages()
if (packages === undefined) {
  console.log('  --  skipped: no installed @deepseek-ai package directory found (set DSH_PACKAGES to run)')
  process.exit(0)
}
console.log(`  --  harness packages: ${packages}\n`)

const { Context } = await import(pathToFileURL(path.join(packages, 'cordis', 'lib', 'index.js')).href)
const skillModule = await import(pathToFileURL(path.join(packages, 'dsh-skill', 'lib', 'index.js')).href)
const { SkillRegistry, isModelInvocable, isUserInvocable } = skillModule
const { HostConnectionService } = await import(pathToFileURL(path.join(packages, 'dsh-client-connection', 'lib', 'index.js')).href)
const { apply } = await import('../lib/index.js')

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-center-host-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root

const library = path.join(root, 'skill-center', 'library')
await mkdir(path.join(library, 'alpha-skill'), { recursive: true })
await writeFile(
  path.join(library, 'alpha-skill', 'SKILL.md'),
  '---\nname: alpha-skill\ndescription: First skill.\nwhenToUse: When the smoke test runs.\n---\n\n# Alpha\n\nFollow these steps.\n',
  'utf8',
)
await mkdir(path.join(library, 'beta-skill'), { recursive: true })
await writeFile(path.join(library, 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\ndescription: Second skill.\n---\n\n# Beta\n', 'utf8')

const context = new Context()
const registryFiber = context.plugin(SkillRegistry)
await registryFiber

let pluginFiber
const changes = []
const routes = new Map()

try {
  await check('a real SkillRegistry owns ctx.skills', () => {
    assert.ok(context.get('skills') !== undefined, 'ctx.skills is missing')
    assert.ok(context.skills instanceof SkillRegistry)
  })

  await check('the plugin mounts into the real context and registers a provider', async () => {
    pluginFiber = context.plugin({ name: 'dsh-skill-center', inject: ['skills'], apply })
    await pluginFiber
    context.on('skills/change', () => changes.push(true))
    const listed = await context.skills.list()
    assert.deepEqual(listed.map((skill) => skill.name), ['alpha-skill', 'beta-skill'])
    assert.equal(listed.every((skill) => skill.provider === 'skill-center' && skill.source === 'custom'), true)
    assert.equal(isModelInvocable(listed[0]), true)
    assert.equal(isUserInvocable(listed[0]), true)
    assert.equal(listed.find((skill) => skill.name === 'alpha-skill').whenToUse, 'When the smoke test runs.')
  })

  await check('the real registry loads a body through the provider', async () => {
    const definition = await context.skills.get('alpha-skill')
    assert.equal(definition.content, '# Alpha\n\nFollow these steps.\n')
    assert.equal(definition.provider, 'skill-center')
    assert.deepEqual(definition.resourceBase, { kind: 'directory', path: path.join(library, 'alpha-skill') })
  })

  await check('routes register only once the web server and the connection fence both exist', async () => {
    assert.deepEqual([...routes.keys()], [], 'routes existed before webServer was provided')
    context.provide('webServer', {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    })
    await settle()
    // A web server with no fence to consult is not enough to serve an API that
    // mutates the library; the plugin must wait rather than register unguarded.
    assert.deepEqual([...routes.keys()], [], 'the routes were registered with no connection fence to guard them')

    // The genuine fence, with only browser authentication stood in for.
    new HostConnectionService(context, [], {
      isAuthenticated: (request) => request.headers?.cookie === TRUSTED_REQUEST.cookie,
    })
    await settle()
    assert.deepEqual([...routes.keys()].sort(), [
      '/dsh-skill-center/api/library',
      '/dsh-skill-center/api/mutate',
      '/dsh-skill-center/api/sources',
    ])
  })

  await check('refreshing the panel surfaces a hand-added skill to the real registry', async () => {
    const warm = await context.skills.list()
    assert.deepEqual(warm.map((skill) => skill.name), ['alpha-skill', 'beta-skill'])

    // Dropped in by hand, exactly like a user copying a skill into the library.
    await mkdir(path.join(library, 'gamma-skill'), { recursive: true })
    await writeFile(path.join(library, 'gamma-skill', 'SKILL.md'), '---\nname: gamma-skill\ndescription: Added later.\n---\n\n# Gamma\n', 'utf8')

    const refreshed = await call(routes.get('/dsh-skill-center/api/library'), 'GET')
    assert.equal(refreshed.response.statusCode, 200)
    assert.equal(refreshed.payload.skills.some((skill) => skill.name === 'gamma-skill'), true, 'the API did not re-scan the library')

    const after = await context.skills.list()
    assert.equal(
      after.some((skill) => skill.name === 'gamma-skill'),
      true,
      'the registry catalog was not resynced, so the model would never see the new skill',
    )
  })

  await check('a toggle through the real route invalidates the real registry catalog', async () => {
    const listed = await call(routes.get('/dsh-skill-center/api/library'), 'GET')
    assert.equal(listed.response.statusCode, 200)
    assert.deepEqual(listed.payload.skills.map((skill) => [skill.name, skill.enabled]), [
      ['alpha-skill', true],
      ['beta-skill', true],
      ['gamma-skill', true],
    ])

    const before = changes.length
    const toggled = await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', {
      action: 'skills.enabled',
      names: ['beta-skill'],
      enabled: false,
    })
    assert.equal(toggled.response.statusCode, 200)
    assert.ok(changes.length > before, 'no skills/change notification reached the registry observers')
    await settle()

    const after = await context.skills.list()
    const beta = after.find((skill) => skill.name === 'beta-skill')
    assert.equal(isModelInvocable(beta), false, 'a disabled skill is still model-invocable')
    assert.equal(isUserInvocable(beta), false, 'a disabled skill is still user-invocable')
    // Still listed: the registry catalog is invocation-neutral on purpose.
    assert.equal(after.length, 3)

    // And the body still loads, so the panel can describe a disabled skill.
    const definition = await context.skills.get('beta-skill')
    assert.equal(definition.name, 'beta-skill')
  })

  await check('categories organise the panel without reaching the registry', async () => {
    const tool = await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', { action: 'categories.create', name: '工具' })
    assert.equal(tool.response.statusCode, 200)
    const toolId = tool.payload.createdCategory

    const filed = await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', {
      action: 'skills.category',
      names: ['alpha-skill'],
      categoryId: toolId,
    })
    assert.equal(filed.response.statusCode, 200)
    assert.equal(filed.payload.skills.find((skill) => skill.name === 'alpha-skill').categoryId, toolId)

    const catalog = await context.skills.list()
    const alpha = catalog.find((skill) => skill.name === 'alpha-skill')
    assert.equal('categoryId' in alpha, false, 'a category leaked into the registry catalog')
    // Filing a skill must not change what the model may invoke.
    assert.equal(isModelInvocable(alpha), true)
    assert.equal(isUserInvocable(alpha), true)
  })

  await check('uninstalling removes the skill from disk and from the real catalog', async () => {
    const gone = await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', { action: 'skills.uninstall', names: ['gamma-skill'] })
    assert.equal(gone.response.statusCode, 200)
    await settle()

    const catalog = await context.skills.list()
    assert.equal(catalog.some((skill) => skill.name === 'gamma-skill'), false, 'the uninstalled skill is still offered to the model')
    assert.equal(await context.skills.get('gamma-skill'), undefined)
    await assert.rejects(() => stat(path.join(library, 'gamma-skill')))
    // A neighbouring skill is untouched.
    assert.ok((await stat(path.join(library, 'alpha-skill', 'SKILL.md'))).isFile())
  })

  await check('the real fence refuses a cross-site mutation before it reaches the library', async () => {
    const mutate = routes.get('/dsh-skill-center/api/mutate')
    const hostile = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
    const refused = await call(mutate, 'POST', { action: 'skills.uninstall', names: ['alpha-skill'] }, hostile)
    assert.equal(refused.response.statusCode, 403)
    assert.ok(
      (await stat(path.join(library, 'alpha-skill', 'SKILL.md'))).isFile(),
      'a cross-site request uninstalled a skill from disk',
    )

    // The Origin rule on its own, with no fetch metadata to give it away: the
    // fence compares Origin's host to Host's, which a policy copy would miss.
    const mismatched = await call(mutate, 'POST', { action: 'skills.uninstall', names: ['alpha-skill'] }, {
      origin: 'http://127.0.0.1:9999',
    })
    assert.equal(mismatched.response.statusCode, 403)
    assert.ok(
      (await stat(path.join(library, 'alpha-skill', 'SKILL.md'))).isFile(),
      'a foreign-Origin request uninstalled a skill from disk',
    )
  })

  await check('the real fence refuses a same-origin mutation with no browser session', async () => {
    const refused = await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', { action: 'skills.uninstall', names: ['alpha-skill'] }, { cookie: undefined })
    assert.equal(refused.response.statusCode, 401)
    assert.ok(
      (await stat(path.join(library, 'alpha-skill', 'SKILL.md'))).isFile(),
      'an unauthenticated request uninstalled a skill from disk',
    )
    // The read surface is behind the same fence; it probes directories.
    const read = await call(routes.get('/dsh-skill-center/api/sources'), 'GET', undefined, { cookie: undefined })
    assert.equal(read.response.statusCode, 401)
  })

  await check('the real fence admits an authenticated same-origin mutation', async () => {
    const accepted = await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', {
      action: 'skills.enabled',
      names: ['alpha-skill'],
      enabled: false,
    })
    assert.equal(accepted.response.statusCode, 200, 'a sanctioned request was refused')
    assert.equal(accepted.payload.skills.find((skill) => skill.name === 'alpha-skill').enabled, false)
    // Put it back so the disposal check below still sees a populated library.
    assert.equal(
      (await call(routes.get('/dsh-skill-center/api/mutate'), 'POST', { action: 'skills.enabled', names: ['alpha-skill'], enabled: true }))
        .response.statusCode,
      200,
    )
  })

  await check('a mutation that does not declare JSON is refused', async () => {
    const refused = await call(
      routes.get('/dsh-skill-center/api/mutate'),
      'POST',
      { action: 'skills.uninstall', names: ['alpha-skill'] },
      { 'content-type': 'text/plain' },
    )
    assert.equal(refused.response.statusCode, 415)
    assert.ok((await stat(path.join(library, 'alpha-skill', 'SKILL.md'))).isFile(), 'a non-JSON request uninstalled a skill from disk')
  })

  await check('disposing the plugin unregisters the provider', async () => {
    await pluginFiber.dispose()
    const after = await context.skills.list()
    assert.deepEqual(after, [], 'the provider outlived its fiber')
  })
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${checked.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
