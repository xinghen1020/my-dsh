/**
 * Browser-half smoke test — runs on plain Node, no browser required.
 *
 * The bundle is executed in a `vm` sandbox with just enough of the page
 * (`window.__ModuleLoader__`, `document`) to capture its factory. Then the
 * factory is materialized against stub platform modules and `apply` is driven
 * with a stub client context, so the slot registrations — the part that decides
 * whether the entry appears above Settings — are asserted for real.
 *
 * It also cross-checks every `P.<Name>` the bundle uses against the primitives
 * the installed shell actually exports. A primitive that does not exist on this
 * host would throw at render time and blank the panel, which is exactly the
 * failure this catches before a restart.
 *
 *   node plugins/dsh-skill-center/test/client-smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client', 'client.js')

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

/** Minimal `document` so the style effect can run. */
function fakeDocument() {
  const head = { children: [], appendChild: (node) => head.children.push(node) }
  return {
    head,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  }
}

/**
 * Execute the bundle and return the spec plus the sandbox it runs in.
 *
 * The bundle's functions close over the sandbox's globals (its own realm), so
 * assertions about `document` must read the *sandbox's* document rather than a
 * fresh one built in this realm.
 *
 * @returns the `{ id, factory }` spec and the sandbox.
 */
async function loadBundle() {
  const source = await readFile(clientPath, 'utf8')
  let captured
  const sandbox = {
    console,
    document: fakeDocument(),
    window: {
      __ModuleLoader__: {
        load: (spec) => {
          captured = spec
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client/client.js' })
  assert.ok(captured !== undefined, 'the bundle never called window.__ModuleLoader__.load')
  return { spec: captured, sandbox }
}

/** React stub with the hooks the bundle touches. */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/**
 * Build the stub platform modules the factory requires.
 * @returns the `require` implementation plus a record of requested specifiers.
 */
function makeRequire() {
  const requested = []
  const primitives = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined
        return (props) => ({ type: property, props })
      },
      has: () => true,
    },
  )
  const modules = {
    react: reactStub(),
    'react-dom': { createPortal: (node) => node },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
  return {
    requested,
    require: (specifier) => {
      requested.push(specifier)
      assert.ok(specifier in modules, `bundle required a module outside the platform table: ${specifier}`)
      return modules[specifier]
    },
  }
}

/**
 * Drive the plugin's `apply` against a stub client context.
 * @param plugin - the materialized module exports.
 * @returns the recorded registrations and the style documents appended.
 */
function runApply(plugin, document) {
  const registrations = []
  const slotsInjected = []
  const ctx = {
    effect: (run) => {
      const produced = run()
      // The real client runtime validates effect shapes the same way the host
      // does; a bad shape here would take the whole plugin down on load.
      assert.ok(
        produced === undefined || produced === null || typeof produced === 'function',
        `effect returned an invalid shape (${typeof produced})`,
      )
      return produced
    },
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, register) => {
        slotsInjected.push(slot)
        register()
      },
      register: (options, component) => {
        registrations.push({ options, component })
      },
    },
  }
  plugin.apply(ctx)
  const styleTags = document.head.children
  return {
    registrations,
    slotsInjected,
    styled: styleTags.length,
    styleText: styleTags.map((tag) => tag.textContent).join('\n'),
  }
}

console.log('dsh-skill-center browser smoke test\n')

let bundle
await check('bundle: registers one factory under the package id', async () => {
  const loaded = await loadBundle()
  bundle = { spec: loaded.spec, sandbox: loaded.sandbox }
  assert.equal(bundle.spec.id, 'dsh-skill-center')
  assert.equal(typeof bundle.spec.factory, 'function')
})

await check('bundle: requires only frozen platform modules', () => {
  const { require: requireStub, requested } = makeRequire()
  bundle.module = bundle.spec.factory(requireStub)
  assert.deepEqual(
    [...new Set(requested)].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react-dom'],
  )
})

await check('bundle: exports the service inject list the client runtime reads', () => {
  assert.equal(bundle.module.name, 'dsh-skill-center')
  // Spread: values built inside the vm realm have that realm's Array prototype.
  assert.deepEqual([...bundle.module.inject], ['slots', 'locale'])
  assert.equal(typeof bundle.module.apply, 'function')
})

let applied
await check('bundle: apply fills the seat directly above Settings and the shell overlay', () => {
  applied = runApply(bundle.module, bundle.sandbox.document)
  const { registrations, slotsInjected, styled } = applied
  assert.deepEqual([...slotsInjected], ['sidebar.footer.action', 'shell.overlay'])
  // The sidebar renders footer.action before settings, so this seat is the
  // entry above Settings; anything else would be a silent regression.
  assert.equal(registrations[0].options.name, 'sidebar.footer.action')
  assert.equal(registrations[0].options.id, 'dsh-skill-center')
  assert.equal(registrations[0].options.locale, 'dsh-skill-center')
  assert.equal(typeof registrations[0].options.label, 'function')
  assert.equal(registrations[0].options.label(), 'nav')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(registrations[1].options.name, 'shell.overlay')
  assert.equal(registrations[1].options.id, 'dsh-skill-center-panel')
  assert.equal(typeof registrations[1].component, 'function')
  assert.equal(styled, 1, 'the bundle did not inject its stylesheet')
})

await check('placement: the footer entry is its own row, above the sibling entry', async () => {
  const options = applied.registrations[0].options
  assert.equal(options.order, 9, 'the footer entry order changed')

  // The seat is a nowrap flex row; a sibling that claims the full width
  // (dsh-context's entry does) collapses anything sharing its line, so this
  // entry must be sized by width and must not set `flex` at all.
  const triggerRule = /\.dsc-trigger\{([^}]*)\}/.exec(applied.styleText)
  assert.ok(triggerRule !== null, 'no .dsc-trigger rule was injected')
  assert.equal(/flex\s*:/.test(triggerRule[1]), false, 'the trigger sets flex; on a row seat that zero basis is what collapsed the entry to an empty box')
  assert.match(triggerRule[1], /width:calc\(100% \+ 4px\)/)

  // And the row has to wrap for a full-width entry to get a line of its own.
  assert.match(applied.styleText, /:has\(>\s*div\[data-slot="sidebar\.footer\.action"\]\)\s*\{[^}]*flex-wrap:wrap/)

  const sibling = await siblingFooterOrder()
  if (sibling === undefined) {
    console.log('      (skipped sibling comparison: dsh-context is not installed)')
    return
  }
  assert.notEqual(options.order, sibling.order, 'a tie would let registration order decide the placement')
  assert.ok(options.order < sibling.order, `expected this entry above the sibling (order ${sibling.order})`)
})

await check('placement: the trigger renders a bare button, not a tooltip wrapper', () => {
  const Trigger = applied.registrations[0].component
  const wide = Trigger({ wide: true, t: (key) => key })
  assert.equal(wide.type, 'button', 'the seat is a flex row sized by its items; a wrapper changes what the row measures')
  assert.equal(wide.props.className, 'dsc-trigger')
  assert.equal(wide.props.title, 'nav')
  assert.equal(wide.props['aria-label'], 'nav')
  const rail = Trigger({ wide: false, t: (key) => key })
  assert.equal(rail.props.className, 'dsc-trigger dsc-triggerRail')
})

/**
 * Read the order the installed sibling plugin registers its footer entry with.
 * @returns the order and id, or undefined when dsh-context is not installed.
 */
async function siblingFooterOrder() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'profiles', 'web', 'node_modules', 'dsh-context', 'lib', 'client.js')
  let source
  try {
    source = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const match = /name:\s*"sidebar\.footer\.action",\s*id:\s*"([^"]+)",\s*order:\s*(\d+)/.exec(source)
  return match === null ? undefined : { id: match[1], order: Number(match[2]) }
}

await check('bundle: only primitives this host exports are referenced', async () => {
  const source = await readFile(clientPath, 'utf8')
  const used = [...new Set([...source.matchAll(/\bP\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1]))]
  assert.ok(used.length > 0, 'no primitives referenced at all?')

  const exported = await hostPrimitives()
  if (exported === undefined) {
    console.log(`      (skipped: no installed primitives package found; used: ${used.join(', ')})`)
    return
  }
  const missing = used.filter((name) => !exported.has(name))
  assert.deepEqual(missing, [], `primitives missing on this host: ${missing.join(', ')}`)
})

/**
 * Read the export names of the installed primitives package.
 * @returns the export-name set, or undefined when the package is not installed.
 */
async function hostPrimitives() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(home, 'profiles', 'web', '.dsh-module-fallback', 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'types', 'icons', 'index.d.ts'),
    path.join(home, 'profiles', 'web', '.dsh-module-fallback', 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'types', 'index.d.ts'),
  ]
  const names = new Set()
  let found = false
  for (const candidate of candidates) {
    let text
    try {
      text = await readFile(candidate, 'utf8')
    } catch {
      continue
    }
    found = true
    for (const match of text.matchAll(/export declare (?:const|function) ([A-Za-z0-9_$]+)/g)) names.add(match[1])
    for (const match of text.matchAll(/export \{ ([^}]+) \}/g)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()
        if (name !== '') names.add(name)
      }
    }
  }
  return found ? names : undefined
}

console.log(`\n${checked.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
