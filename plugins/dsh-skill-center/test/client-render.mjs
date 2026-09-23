/**
 * Browser-half render and interaction test — runs on plain Node, no browser.
 *
 * `client-smoke.mjs` proves the bundle loads and registers its seats. This file
 * goes further and actually *renders* the panel, because the render path is
 * where a hand-written bundle with no build step can still be wrong: a
 * mistyped primitive, a prop the host does not pass, a hook called in the wrong
 * order, or a click handler wired to the wrong command.
 *
 * It supplies a deliberately tiny React runtime (just enough hook semantics to
 * support the re-render a state update triggers), stubs `fetch` so every request
 * is recorded, and drives real handlers out of the rendered element tree. That
 * makes the assertions behavioural — "clicking this switch sends this command" —
 * rather than structural.
 *
 *   node plugins/dsh-skill-center/test/client-render.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

// ------------------------------------------------------------------- runtime

/**
 * A React runtime with just enough semantics to render one component and
 * re-render it when its own state changes.
 *
 * Only the component under test is invoked; nested function elements are left
 * in the tree as opaque nodes. That is all this test needs, and it keeps the
 * runtime small enough to trust.
 *
 * @returns the React stub plus a `render` entry point.
 */
function createRuntime() {
  let hooks = []
  let cursor = 0
  const effects = []
  let current = null
  let queued = false
  let latest = null

  const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (current !== null) run(current.render)
    })
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Number.POSITIVE_INFINITY).filter((child) => child !== null && child !== undefined && child !== false) }),
    useState: (initial) => {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [
        hooks[index],
        (next) => {
          const value = typeof next === 'function' ? next(hooks[index]) : next
          if (Object.is(hooks[index], value)) return
          hooks[index] = value
          schedule()
        },
      ]
    },
    useRef: (initial) => {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    // Identity must be stable across renders, or an effect keyed on a callback
    // re-runs forever.
    useCallback: (fn, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
      hooks[index] = { fn, deps }
      return fn
    },
    useEffect: (fn, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      hooks[index] = { deps }
      effects.push(fn)
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useId: () => 'test-id',
  }

  /**
   * Render the component and flush its effects, then keep draining re-renders.
   * @param render - zero-argument render thunk.
   * @returns the latest element tree.
   */
  const run = async (render) => {
    current = { render }
    cursor = 0
    effects.length = 0
    const tree = render()
    for (const effect of effects.splice(0)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup()
    }
    // Let a pending fetch-driven state update land and re-render.
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    return tree
  }

  return {
    React,
    /**
     * Mount a component. Call once: this resets hook state, so it is a fresh
     * mount, not a way to read the current tree — use {@link latest} for that.
     * @param component - the component function.
     * @param props - initial props.
     * @returns the rendered element tree.
     */
    mount: (component, props) =>
      run(() => {
        latest = component(props)
        return latest
      }).then(() => latest),
    /**
     * The most recently rendered tree, without disturbing hook state.
     * @returns the current element tree.
     */
    latest: () => latest,
    /**
     * Render a nested component with its own hook scope.
     *
     * The runtime deliberately leaves nested function elements opaque, but a few
     * of them (the destination picker, the text fields) are worth asserting on
     * directly. This runs one without disturbing the mounted component's hooks.
     *
     * @param component - the nested component function.
     * @param props - its props.
     * @returns the rendered element tree.
     */
    renderChild: (component, props) => {
      const savedHooks = hooks
      const savedCursor = cursor
      hooks = []
      cursor = 0
      try {
        return component(props)
      } finally {
        hooks = savedHooks
        cursor = savedCursor
      }
    },
  }
}

/**
 * Apply the subset of host commands this suite needs, so a mutation actually
 * changes what the next read returns.
 * @param snapshot - the mutable library.
 * @param body - the command payload that was sent.
 */
function applyAction(snapshot, body) {
  const action = body?.action
  if (action === 'skills.enabled') {
    for (const skill of snapshot.skills) {
      if (!body.names.includes(skill.name)) continue
      skill.enabled = body.enabled
      skill.modelInvocable = body.enabled
      skill.userInvocable = body.enabled
    }
    return
  }
  if (action === 'skills.category') {
    for (const skill of snapshot.skills) {
      if (body.names.includes(skill.name)) skill.categoryId = body.categoryId ?? null
    }
    return
  }
  if (action === 'skills.uninstall') {
    snapshot.skills = snapshot.skills.filter((skill) => !body.names.includes(skill.name))
    return
  }
  if (action === 'skills.create' || action === 'skills.import') {
    const names = action === 'skills.create' ? [body.name] : body.names
    for (const name of names) {
      if (snapshot.skills.some((skill) => skill.name === name)) continue
      snapshot.skills.push({
        name,
        description: body.description ?? 'Imported.',
        enabled: true,
        modelInvocable: true,
        userInvocable: true,
        categoryId: body.categoryId ?? null,
      })
    }
    snapshot.skills.sort((left, right) => left.name.localeCompare(right.name))
  }
  // Category commands are left alone on purpose: the assertions above depend on
  // the fixture tree, and the commands themselves are already covered.
}

/** A drag event stand-in carrying only the pieces the handlers touch. */
function dragEvent() {
  return { preventDefault: () => {}, dataTransfer: { setData: () => {}, effectAllowed: '', dropEffect: '' } }
}

/**
 * A dragover event stand-in.
 * @param onPreventDefault - called when the handler accepts the drop target.
 * @returns the event object.
 */
function dragOverEvent(onPreventDefault) {
  return { preventDefault: onPreventDefault, dataTransfer: { dropEffect: '' } }
}

/** A context-menu event stand-in. */
function contextEvent() {
  return { preventDefault: () => {}, clientX: 12, clientY: 12 }
}

/** Let queued state updates and their re-renders land. */
async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------- tree

/**
 * Collect every element in a rendered tree.
 * @param node - element, array, or scalar.
 * @returns the flat element list.
 */
function elements(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(elements)
  const self = node.type === undefined ? [] : [node]
  return [...self, ...elements(node.children ?? [])]
}

/**
 * Collect all text in a rendered tree.
 * @param node - element, array, or scalar.
 * @returns the concatenated text.
 */
function text(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return (node.children ?? []).map(text).join(' ')
}

/**
 * Element name, whether it is a DOM tag, a component, or a stubbed primitive.
 * @param node - element.
 * @returns the best available name.
 */
function nameOf(node) {
  const type = node.type
  if (typeof type === 'string') return type
  return type?.displayName ?? type?.name ?? 'Anonymous'
}

/**
 * Find elements by name.
 * @param tree - rendered tree.
 * @param name - element name.
 * @returns the matches.
 */
function byName(tree, name) {
  return elements(tree).filter((node) => nameOf(node) === name)
}

/**
 * Find the first element carrying an aria-label that contains the text.
 * @param tree - rendered tree.
 * @param label - substring to look for.
 * @returns the match, or undefined.
 */
function byLabel(tree, label) {
  return elements(tree).find((node) => typeof node.props['aria-label'] === 'string' && node.props['aria-label'].includes(label))
}

// ------------------------------------------------------------------ fixtures

/** The snapshot the stubbed host answers reads with. */
const SNAPSHOT = {
  libraryDir: 'C:\\Users\\demo\\.dsh\\skill-center\\library',
  categories: [
    { id: 'tool', name: '工具', children: [{ id: 'ops', name: '运维', children: [] }] },
    { id: 'common', name: '常用', children: [] },
  ],
  skills: [
    { name: 'alpha-skill', description: 'First skill.', enabled: true, modelInvocable: true, userInvocable: true, categoryId: 'tool', path: 'x', bytes: 1, mtimeMs: 1 },
    { name: 'beta-skill', description: 'Second skill.', enabled: false, modelInvocable: false, userInvocable: false, categoryId: 'tool', path: 'y', bytes: 1, mtimeMs: 1 },
    { name: 'gamma-skill', description: 'Loose skill.', enabled: true, modelInvocable: true, userInvocable: false, categoryId: null, path: 'z', bytes: 1, mtimeMs: 1 },
  ],
  warnings: ['broken: missing required "description" in frontmatter'],
}

/** What the stubbed `/api/sources` answers with. */
const SOURCES = {
  sources: [
    {
      id: 'src-claude',
      label: 'Claude Code',
      path: 'C:\\Users\\demo\\.claude\\skills',
      custom: false,
      exists: true,
      truncated: false,
      invalid: [],
      skills: [
        { name: 'alpha-skill', description: 'Already in the library.', imported: true, relative: 'alpha-skill/SKILL.md' },
        { name: 'delta-skill', description: 'From Claude.', imported: false, relative: 'delta-skill/SKILL.md' },
        { name: 'epsilon-skill', description: 'Also from Claude.', imported: false, relative: 'epsilon-skill/SKILL.md' },
      ],
    },
    {
      id: 'src-codex',
      label: 'Codex',
      path: 'C:\\Users\\demo\\.codex\\skills',
      custom: false,
      exists: true,
      truncated: false,
      invalid: [],
      skills: [{ name: 'zeta-skill', description: 'From Codex.', imported: false, relative: 'zeta-skill/SKILL.md' }],
    },
    {
      id: 'src-missing',
      label: 'agents 共享',
      path: 'C:\\Users\\demo\\.agents\\skills',
      custom: false,
      exists: false,
      truncated: false,
      invalid: [],
      skills: [],
    },
    // A directory that exists but holds nothing: switching to it must not
    // collapse the dialog.
    {
      id: 'src-empty',
      label: 'dsh 用户技能',
      path: 'C:\\Users\\demo\\.dsh\\skills',
      custom: false,
      exists: true,
      truncated: false,
      invalid: [],
      skills: [],
    },
  ],
}

/** Minimal `document` for the style tag, the portal, and the listeners. */
function fakeDocument() {
  const head = { children: [], appendChild: (node) => head.children.push(node) }
  return {
    head,
    body: { tagName: 'BODY' },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  }
}

/**
 * Load the bundle and instantiate it against stubs.
 * @param fetchCalls - array that recorded requests are pushed into.
 * @param control - mutable hook for forcing the next response to fail.
 * @returns the plugin module and the captured registrations.
 */
async function boot(fetchCalls, control) {
  const source = await readFile(clientPath, 'utf8')
  let captured

  const document = fakeDocument()
  const sandbox = { console, document, setTimeout, queueMicrotask, window: { __ModuleLoader__: { load: (spec) => { captured = spec } }, addEventListener: () => {}, removeEventListener: () => {} } }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client/client.js' })
  assert.ok(captured !== undefined, 'the bundle never registered a factory')

  sandbox.fetch = async (url, options = {}) => {
    const parsed = options.body === undefined ? undefined : JSON.parse(options.body)
    fetchCalls.push({ url, method: options.method ?? 'GET', body: parsed })
    if (control.failNext !== null) {
      const message = control.failNext
      control.failNext = null
      return { ok: false, status: 400, json: async () => ({ error: message }) }
    }
    if (String(url).endsWith('/api/sources')) return { ok: true, status: 200, json: async () => structuredClone(SOURCES) }
    // The real import answer carries the per-skill outcome alongside the
    // refreshed snapshot; mirror that so the summary has something to show.
    if (parsed?.action === 'skills.import') {
      const imported = parsed.names.map((name) => ({ name, replaced: false }))
      if (control.mutating === true) applyAction(control.library, parsed)
      const base = control.mutating === true ? control.library : SNAPSHOT
      return { ok: true, status: 200, json: async () => ({ ...structuredClone(base), imported, skipped: [] }) }
    }
    // Off by default so every assertion above this point sees the fixture as
    // written. The one test that turns it on is about the UI reflecting a
    // change by itself, which needs a host that actually changes.
    if (control.mutating === true && parsed?.action !== undefined) {
      applyAction(control.library, parsed)
      return { ok: true, status: 200, json: async () => structuredClone(control.library) }
    }
    return { ok: true, status: 200, json: async () => structuredClone(SNAPSHOT) }
  }

  const runtime = createRuntime()
  const primitives = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined
        const stub = (props) => ({ type: stub, props: props ?? {}, children: [] })
        Object.defineProperty(stub, 'displayName', { value: property })
        return stub
      },
    },
  )

  const module$ = captured.factory((specifier) => {
    if (specifier === 'react') return runtime.React
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${specifier}`)
  })

  const registrations = []
  module$.apply({
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (_slot, register) => register(),
      register: (options, component) => registrations.push({ options, component }),
    },
  })

  return { module: module$, registrations, runtime, sandbox }
}

console.log('dsh-skill-center browser render test\n')

const fetchCalls = []
const control = { failNext: null, mutating: false, library: structuredClone(SNAPSHOT) }
const app = await boot(fetchCalls, control)
const Trigger = app.registrations[0].component
const Panel = app.registrations[1].component
const t = (key) => key

let tree
/**
 * The current tree with nested components expanded.
 *
 * The runtime leaves nested function elements opaque, but the dialog's fields
 * and destination picker are exactly what these tests need to drive, and in a
 * real render they would of course be rendered. Expanding here also means the
 * opaque-node shortcut can never hide a broken field.
 *
 * @returns the expanded element tree.
 */
const currentTree = () => expand(app.runtime.latest())

/**
 * Recursively render nested components.
 * @param node - element, array, or scalar.
 * @returns the expanded node.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.flatMap(expand)
  // Stub primitives carry a displayName; real nested components do not.
  if (typeof node.type === 'function' && node.type.displayName === undefined) {
    return expand(app.runtime.renderChild(node.type, node.props))
  }
  return { ...node, children: (node.children ?? []).flatMap(expand) }
}

/** Click a tree row by the label it renders. */
async function selectNode(label) {
  const row = elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).includes(label))
  assert.ok(row !== undefined, `no tree row for ${label}`)
  row.props.onClick()
  await settle()
}

/**
 * Find the open dialog by a string only it contains.
 *
 * The panel root is itself `role="dialog"` and contains every descendant's
 * text, so a role-based lookup would return the panel and then match the
 * toolbar's buttons instead of the dialog's. The class is matched as a whole
 * token because the import dialog carries a second, wider class.
 *
 * @param marker - text unique to the dialog body.
 * @returns the dialog element.
 */
function findDialog(marker) {
  return elements(currentTree()).find(
    (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('dsc-dialog') && text(node).includes(marker),
  )
}

/** Click a button inside an element by its visible label. */
function clickButton(scope, label) {
  const button = byName(scope, 'Button').find((node) => text(node).trim() === label)
  assert.ok(button !== undefined, `no button labelled ${label}`)
  button.props.onClick()
}

/**
 * Whether an element carries a class as a whole token.
 * @param node - element.
 * @param name - class name.
 * @returns whether the class is present.
 */
function hasClass(node, name) {
  return typeof node.props.className === 'string' && node.props.className.split(' ').includes(name)
}

await check('the panel renders for real once the footer entry opens it', async () => {
  const trigger = Trigger({ wide: true, t })
  assert.equal(trigger.props['aria-expanded'], 'false')
  trigger.props.onClick()
  tree = await app.runtime.mount(Panel, { t })
  assert.ok(tree !== null, 'the panel rendered nothing after its own trigger was clicked')
  assert.equal(byName(tree, 'div').length > 0, true)
})

await check('the left pane is a folder tree: uncategorized first, then the nested nodes', () => {
  const rows = elements(tree).filter((node) => node.props.role === 'treeitem')
  const labels = rows.map((node) => text(node).trim()).filter(Boolean)
  // Uncategorized is the fixed first row; 运维 is nested one level in.
  assert.deepEqual(labels, ['uncategorized', '工具', '运维', '常用'])
  const nested = rows.find((node) => text(node).includes('运维'))
  assert.equal(nested.props.style.paddingLeft, '20px', 'nesting must indent the row')
  const topLevel = rows.find((node) => text(node).trim() === '常用')
  assert.equal(topLevel.props.style.paddingLeft, '6px')
})

await check('the right pane lists the selected folder only', async () => {
  // Default selection is uncategorized, which holds only the loose skill.
  assert.equal(text(currentTree()).includes('gamma-skill'), true)
  assert.equal(text(currentTree()).includes('alpha-skill'), false, 'a skill from another folder leaked into the view')

  await selectNode('工具')
  // Selecting 工具 lists its sub-folder as a folder row plus its own skills.
  const rendered = text(currentTree())
  assert.equal(rendered.includes('alpha-skill'), true, 'the selected folder list is empty')
  assert.equal(rendered.includes('beta-skill'), true)
  assert.equal(rendered.includes('gamma-skill'), false, 'a skill from another folder leaked in')
  assert.equal(rendered.includes('运维'), true, 'the sub-folder row is missing')
})

await check('a skill row carries the enablement switch, state and uninstall', () => {
  const switches = elements(currentTree()).filter((node) => node.props.role === 'switch')
  assert.equal(switches.length, 2, 'one switch per listed skill')
  assert.equal(byLabel(currentTree(), 'enable: beta-skill').props['aria-checked'], 'false', 'a disabled skill must read as off')
  assert.equal(byLabel(currentTree(), 'disable: alpha-skill').props['aria-checked'], 'true', 'an enabled skill must read as on')
  assert.ok(byLabel(currentTree(), 'uninstall: alpha-skill'), 'no uninstall affordance on the row')
})

await check('the invocation chips are not surfaced, though the host still reports them', async () => {
  await selectNode('uncategorized')
  // gamma-skill is enabled but not user-invocable: the row deliberately says
  // nothing about it right now.
  assert.equal(text(currentTree()).includes('userHidden'), false, 'the user-invocable chip is still rendered')
  assert.equal(text(currentTree()).includes('modelHidden'), false, 'the model-invocable chip is still rendered')
  // The information itself is still there for whoever wants it back.
  const gamma = SNAPSHOT.skills.find((skill) => skill.name === 'gamma-skill')
  assert.equal(gamma.userInvocable, false)
  assert.equal(gamma.modelInvocable, true)
  await selectNode('工具')
})

await check('clicking the switch sends exactly one enablement command', async () => {
  fetchCalls.length = 0
  const betaSwitch = byLabel(currentTree(), 'enable: beta-skill')
  betaSwitch.props.onClick()
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'skills.enabled', names: ['beta-skill'], enabled: true } },
  ])
})

await check('uninstalling asks first, names the skill, then sends the command', async () => {
  fetchCalls.length = 0
  byLabel(currentTree(), 'uninstall: alpha-skill').props.onClick()
  await settle()

  // A confirm dialog, not an immediate delete.
  assert.equal(fetchCalls.length, 0, 'uninstall fired without confirmation')
  const dialog = findDialog('uninstallBody')
  assert.ok(dialog !== undefined, 'no confirmation dialog appeared')
  assert.equal(text(dialog).includes('alpha-skill'), true, 'the dialog does not name the skill')

  clickButton(dialog, 'uninstall')
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'skills.uninstall', names: ['alpha-skill'] } },
  ])
})

await check('deleting a folder warns that the skills inside survive', async () => {
  fetchCalls.length = 0
  // Right-click the tree row: that is where folder management lives.
  const toolRow = elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).includes('工具'))
  toolRow.props.onContextMenu({ preventDefault: () => {}, clientX: 10, clientY: 10 })
  await settle()
  const menu = elements(currentTree()).find((node) => node.props.role === 'menu')
  assert.ok(menu !== undefined, 'right-click produced no menu')

  const deleteItem = byName(menu, 'button').find((node) => text(node).trim() === 'delete')
  assert.ok(deleteItem !== undefined, 'the folder menu has no delete entry')
  deleteItem.props.onClick()
  await settle()

  const dialog = findDialog('deleteCategoryBody')
  assert.ok(dialog !== undefined, 'deleting a folder asked nothing')
  assert.equal(fetchCalls.length, 0, 'the folder was deleted without confirmation')

  clickButton(dialog, 'delete')
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'categories.delete', id: 'tool' } },
  ])
})

await check('search leaves the tree selection behind and scans the whole library', async () => {
  fetchCalls.length = 0
  const search = elements(currentTree()).find((node) => node.props.type === 'search')
  assert.ok(search !== undefined, 'no search box')
  search.props.onChange({ target: { value: 'skill' } })
  await settle()

  const rendered = text(currentTree())
  // All three skills match, including the one outside the selected folder.
  for (const name of ['alpha-skill', 'beta-skill', 'gamma-skill']) {
    assert.equal(rendered.includes(name), true, `${name} missing from library-wide results`)
  }
  // Each hit says where it lives, because the tree no longer answers that.
  assert.equal(rendered.includes('uncategorized'), true)
  assert.equal(elements(currentTree()).filter((node) => node.props.role === 'switch').length, 3)
})

await check('the footer reports enablement and surfaces library warnings', () => {
  const rendered = text(currentTree())
  assert.equal(rendered.includes('enabled 2/3'), true)
  assert.equal(rendered.includes('1 warnings'), true)
})

// --------------------------------------------------- batch bar, label, drag

await check('the batch bar is permanent, and inert until something is checked', async () => {
  const search = elements(currentTree()).find((node) => node.props.type === 'search')
  search.props.onChange({ target: { value: '' } })
  await settle()
  await selectNode('工具')
  fetchCalls.length = 0

  const readBar = () => elements(currentTree()).find((node) => node.props.className === 'dsc-selbar')
  assert.ok(readBar() !== undefined, 'the batch bar disappears when nothing is checked')
  assert.equal(text(readBar()).includes('selected 0'), true)
  assert.equal(byName(readBar(), 'Button').length, 5, 'expected enable/disable/move/uninstall/clear')
  assert.equal(
    byName(readBar(), 'Button').every((node) => node.props.disabled === true),
    true,
    'batch actions must be inert with nothing checked',
  )

  // Clicking through the (disabled) handlers must not reach the host either.
  byName(readBar(), 'Button').find((node) => text(node).trim() === 'uninstall').props.onClick()
  await settle()
  assert.deepEqual(fetchCalls, [], 'a batch action fired with an empty selection')
  assert.ok(readBar() !== undefined, 'a dialog replaced the permanent bar')

  const box = elements(currentTree()).find((node) => node.props.type === 'checkbox')
  box.props.onChange({ target: {} })
  await settle()
  assert.equal(text(readBar()).includes('selected 1'), true)
  assert.equal(
    byName(readBar(), 'Button').every((node) => node.props.disabled !== true),
    true,
    'batch actions stayed inert with a selection',
  )

  byName(readBar(), 'Button').find((node) => text(node).trim() === 'clearSelection').props.onClick()
  await settle()
  assert.ok(readBar() !== undefined, 'clearing the selection removed the bar')
  assert.equal(text(readBar()).includes('selected 0'), true)
})

await check('the move picker names 未分类 rather than a separate top level', async () => {
  const alphaRow = elements(currentTree()).find((node) => node.props.draggable === true && text(node).includes('alpha-skill'))
  alphaRow.props.onContextMenu(contextEvent())
  await settle()
  const menu = elements(currentTree()).find((node) => node.props.role === 'menu')
  byName(menu, 'button').find((node) => text(node).trim() === 'moveTo').props.onClick()
  await settle()

  const dialog = findDialog('moveHint')
  assert.ok(dialog !== undefined, 'the move dialog did not open')
  // "顶级" would be meaningless here: a skill is either in a folder or it is not.
  assert.equal(text(dialog).includes('root'), false, 'the dialog still offers a separate top level')

  const readRadios = () => elements(findDialog('moveHint')).filter((node) => node.props.role === 'radio')
  assert.deepEqual(readRadios().map((node) => text(node).trim()), ['uncategorized', '工具', '运维', '常用'])
  assert.equal(readRadios()[0].props['aria-checked'], 'true', '未分类 should be the default destination')

  // Picking a folder must actually change what the command sends.
  readRadios()[1].props.onClick()
  await settle()
  fetchCalls.length = 0
  clickButton(findDialog('moveHint'), 'moveTo')
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'skills.category', names: ['alpha-skill'], categoryId: 'tool' } },
  ])
})

await check('new skill collects name, description, body and destination', async () => {
  await selectNode('工具')
  fetchCalls.length = 0
  clickButton(currentTree(), 'newSkill')
  await settle()

  const fields = () => elements(findDialog('skillBody'))
  assert.ok(findDialog('skillBody') !== undefined, 'the create dialog did not open')
  const textInputs = fields().filter((node) => node.props.type === 'text')
  const bodyField = fields().find((node) => node.type === 'textarea')
  assert.equal(textInputs.length, 2, 'expected exactly a name and a description input')
  assert.ok(bodyField !== undefined, 'no multi-line body field')
  assert.equal(fields().some((node) => node.props.className === 'dsc-dialogError'), false)

  // The dialog is deliberately terse: four labelled controls and nothing else —
  // no hint lines under them, and no text inside a field that only repeats its
  // own label. The name field keeps its example, which is the one that helps.
  assert.equal(fields().some((node) => node.props.className === 'dsc-hint'), false, 'the dialog still shows a hint line')
  assert.equal(bodyField.props.placeholder, undefined, 'the body field still shows placeholder text')
  assert.equal(textInputs[1].props.placeholder, undefined, 'the description field repeats its own label as placeholder text')
  assert.equal(textInputs[0].props.placeholder, 'my-new-skill')

  // The destination defaults to the folder being viewed, and stays pickable.
  const radios = () => fields().filter((node) => node.props.role === 'radio')
  assert.deepEqual(radios().map((node) => text(node).trim()), ['uncategorized', '工具', '运维', '常用'])
  assert.equal(text(radios().find((node) => node.props['aria-checked'] === 'true')).trim(), '工具', 'the viewed folder should be the default')
  radios()[0].props.onClick()
  await settle()
  assert.equal(text(radios().find((node) => node.props['aria-checked'] === 'true')).trim(), 'uncategorized')

  fields().filter((node) => node.props.type === 'text')[0].props.onChange({ target: { value: 'my-new-skill' } })
  await settle()
  fields().filter((node) => node.props.type === 'text')[1].props.onChange({ target: { value: 'Does a thing.' } })
  await settle()
  fields().find((node) => node.type === 'textarea').props.onChange({ target: { value: '# My new skill\n\nSteps.\n' } })
  await settle()

  fetchCalls.length = 0
  clickButton(findDialog('skillBody'), 'create')
  await settle()
  assert.deepEqual(fetchCalls, [
    {
      url: '/dsh-skill-center/api/mutate',
      method: 'POST',
      body: { action: 'skills.create', name: 'my-new-skill', description: 'Does a thing.', body: '# My new skill\n\nSteps.\n', categoryId: null },
    },
  ])
  assert.equal(findDialog('skillBody'), undefined, 'a successful create should close the dialog')
})

await check('a rejected create keeps the dialog open and shows why', async () => {
  await selectNode('工具')
  fetchCalls.length = 0
  clickButton(currentTree(), 'newSkill')
  await settle()
  elements(findDialog('skillBody')).filter((node) => node.props.type === 'text')[0].props.onChange({ target: { value: 'alpha-skill' } })
  await settle()

  control.failNext = 'a skill named "alpha-skill" already exists'
  clickButton(findDialog('skillBody'), 'create')
  await settle()

  const dialog = findDialog('skillBody')
  assert.ok(dialog !== undefined, 'the dialog closed on failure, burying the error in the footer')
  assert.equal(text(dialog).includes('already exists'), true, 'the dialog does not say what went wrong')
  // The typed values survive the failure rather than being cleared.
  assert.equal(elements(dialog).filter((node) => node.props.type === 'text')[0].props.value, 'alpha-skill')

  clickButton(dialog, 'cancel')
  await settle()
})

await check('a skill can be dragged onto 未分类 to take it out of its folder', async () => {
  fetchCalls.length = 0
  const readUncat = () => elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).includes('uncategorized'))

  const alphaRow = elements(currentTree()).find((node) => node.props.draggable === true && text(node).includes('alpha-skill'))
  alphaRow.props.onDragStart(dragEvent())

  // The row must accept the drag, or the browser will not fire a drop at all.
  let accepted = false
  readUncat().props.onDragOver({ preventDefault: () => { accepted = true } })
  assert.equal(accepted, true, '未分类 refused a skill drag, so no drop can ever land')
  await settle()
  assert.equal(readUncat().props.className.includes('dsc-treeRowDrop'), true, 'no drop highlight on 未分类')

  readUncat().props.onDrop(dragEvent())
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'skills.category', names: ['alpha-skill'], categoryId: null } },
  ])
})

await check('未分类 refuses a folder drop, since it can never hold one', async () => {
  const toolRow = elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).includes('工具'))
  toolRow.props.onDragStart(dragEvent())

  let accepted = false
  const uncat = elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).includes('uncategorized'))
  uncat.props.onDragOver({ preventDefault: () => { accepted = true } })
  assert.equal(accepted, false, 'a folder was offered 未分类 as a destination')
  toolRow.props.onDragEnd()
})

await check('dragging a folder onto another re-parents it, and its own subtree is closed', async () => {
  await selectNode('工具')
  fetchCalls.length = 0
  const rowFor = (label) => elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).trim() === label)

  rowFor('运维').props.onDragStart(dragEvent())
  await settle()
  // The dragged row is marked, and it cannot be dropped on itself.
  assert.equal(rowFor('运维').props.className.split(' ').includes('dsc-treeRowDragging'), true, 'the dragged row is not marked')
  assert.equal(rowFor('运维').props.className.split(' ').includes('dsc-treeRowLocked'), true, 'a folder is offered itself as a target')
  let lockedAccepted = false
  rowFor('运维').props.onDragOver(dragOverEvent(() => { lockedAccepted = true }))
  assert.equal(lockedAccepted, false, 'a folder accepted a drop into its own subtree')

  // Dropping on its current parent is a legitimate no-op, but must say so.
  rowFor('工具').props.onDragOver(dragOverEvent(() => {}))
  rowFor('工具').props.onDrop(dragEvent())
  await settle()
  assert.deepEqual(fetchCalls, [], 'an already-satisfied drop sent a command anyway')
  assert.equal(text(currentTree()).includes('alreadyChild'), true, 'a drop that changes nothing said nothing')

  // Onto a different folder: that is the re-parent the gesture exists for.
  rowFor('运维').props.onDragStart(dragEvent())
  let accepted = false
  rowFor('常用').props.onDragOver(dragOverEvent(() => { accepted = true }))
  assert.equal(accepted, true, 'the target folder refused a folder drag')
  rowFor('常用').props.onDrop(dragEvent())
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'categories.move', id: 'ops', parentId: 'common' } },
  ])
})

await check('a folder has an explicit move path, with its own subtree excluded', async () => {
  await selectNode('工具')
  fetchCalls.length = 0
  const openMenuFor = async (label) => {
    const row = elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).trim() === label)
    row.props.onContextMenu(contextEvent())
    await settle()
  }

  await openMenuFor('运维')
  const menu = elements(currentTree()).find((node) => node.props.role === 'menu')
  byName(menu, 'button').find((node) => text(node).trim() === 'moveTo').props.onClick()
  await settle()

  const dialog = findDialog('moveCategoryHint')
  assert.ok(dialog !== undefined, 'the folder move dialog did not open')
  const radios = elements(dialog).filter((node) => node.props.role === 'radio')
  // This picker really does offer "top level", and never the folder's own subtree.
  assert.deepEqual(radios.map((node) => text(node).trim()), ['root', '工具', '常用'])

  radios[2].props.onClick()
  await settle()
  fetchCalls.length = 0
  clickButton(findDialog('moveCategoryHint'), 'moveTo')
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'categories.move', id: 'ops', parentId: 'common' } },
  ])
  assert.equal(findDialog('moveCategoryHint'), undefined, 'a successful move should close the dialog')
})

await check('a nested folder can be moved back to the top level', async () => {
  const readMenu = () => elements(currentTree()).find((node) => node.props.role === 'menu')
  const openMenuFor = async (label) => {
    const row = elements(currentTree()).find((node) => node.props.role === 'treeitem' && text(node).trim() === label)
    row.props.onContextMenu(contextEvent())
    await settle()
  }

  // Nested: 运维 sits inside 工具, and its only other drag target is another
  // folder — which would nest it deeper, so it needs an explicit way out.
  await openMenuFor('运维')
  const nestedItems = byName(readMenu(), 'button').map((node) => text(node).trim())
  assert.equal(nestedItems.includes('moveToRoot'), true, `nested folder menu was ${nestedItems.join(', ')}`)

  fetchCalls.length = 0
  byName(readMenu(), 'button').find((node) => text(node).trim() === 'moveToRoot').props.onClick()
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'categories.move', id: 'ops', parentId: null } },
  ])

  // Top level: nothing to move it back from.
  await openMenuFor('工具')
  const topItems = byName(readMenu(), 'button').map((node) => text(node).trim())
  assert.equal(topItems.includes('moveToRoot'), false, `top-level folder menu was ${topItems.join(', ')}`)
  elements(currentTree()).find((node) => node.props.role === 'menu')
})

await check('the import dialog lists sources, and greys out what is already here', async () => {
  await selectNode('工具')
  fetchCalls.length = 0
  clickButton(currentTree(), 'importAction')
  await settle()

  const dialog = findDialog('importTitle')
  assert.ok(dialog !== undefined, 'the import dialog did not open')
  // Sources are chips; the one that is not there is unusable.
  const readDialog = () => findDialog('importTitle')
  const chips = () => elements(readDialog()).filter((node) => hasClass(node, 'dsc-chip') || hasClass(node, 'dsc-chipActive'))
  // Source chips carry a count badge; the add control next to them does not.
  const sourceChips = () => chips().filter((node) => elements(node).some((child) => hasClass(child, 'dsc-chipMeta')))
  assert.deepEqual(sourceChips().map((node) => text(node).trim()), ['Claude Code 3', 'Codex 1', 'agents 共享 importMissing', 'dsh 用户技能 0'])
  assert.equal(sourceChips()[2].props.disabled, true, 'a missing directory is selectable')
  assert.equal(sourceChips()[3].props.disabled, false, 'an empty but existing directory must stay selectable')
  assert.equal(chips().length, 5, 'the add-source control does not sit with the sources')

  // The default source is the first usable one.
  const rows = () =>
    elements(readDialog()).filter((node) => hasClass(node, 'dsc-sourceRow') || hasClass(node, 'dsc-sourceRowTaken'))
  assert.equal(rows().length, 4, 'expected three skills plus the overwrite row')

  const boxes = () => elements(readDialog()).filter((node) => node.props.type === 'checkbox')
  // alpha-skill is already in the library, so it is disabled and badged.
  assert.equal(boxes()[0].props.disabled, true, 'an imported skill is selectable without asking to overwrite')
  assert.equal(text(readDialog()).includes('importTaken'), true, 'no badge marks what is already here')

  // Select-all must skip the taken one rather than try to import it.
  clickButton(readDialog(), 'importSelectAll')
  await settle()
  assert.equal(text(readDialog()).includes('importSelected 2'), true)

  fetchCalls.length = 0
  clickButton(readDialog(), 'importAction')
  await settle()
  assert.deepEqual(fetchCalls, [
    {
      url: '/dsh-skill-center/api/mutate',
      method: 'POST',
      body: { action: 'skills.import', sourceId: 'src-claude', names: ['delta-skill', 'epsilon-skill'], overwrite: false, categoryId: 'tool' },
    },
    { url: '/dsh-skill-center/api/sources', method: 'GET', body: undefined },
  ])

  // The dialog stays open and reports what happened, because an import can
  // partly succeed.
  const after = readDialog()
  assert.ok(after !== undefined, 'the import dialog closed, taking the outcome with it')
  assert.equal(text(after).includes('importResult 2'), true, 'the dialog does not say how many were imported')

  // Asking to overwrite makes the taken skill selectable again.
  const overwriteLabel = rows().find((node) => text(node).includes('importOverwrite'))
  assert.ok(overwriteLabel !== undefined, 'no overwrite toggle')
  elements(overwriteLabel).find((node) => node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  await settle()
  assert.equal(boxes()[0].props.disabled, false, 'overwrite did not unlock the existing skill')

  clickButton(readDialog(), 'cancel')
  await settle()
})

await check('the import dialog switches source, and can add one', async () => {
  await selectNode('工具')
  clickButton(currentTree(), 'importAction')
  await settle()

  // Switching chips swaps the list.
  const chips = () => elements(findDialog('importTitle')).filter((node) => hasClass(node, 'dsc-chip') || hasClass(node, 'dsc-chipActive'))
  const codexChip = chips().find((node) => text(node).includes('Codex'))
  codexChip.props.onClick()
  await settle()
  const switched = findDialog('importTitle')
  assert.equal(text(switched).includes('zeta-skill'), true, 'the skill list did not follow the source')
  assert.equal(text(switched).includes('delta-skill'), false)

  // Adding a directory: the control sits with the sources, and reveals its
  // field on demand rather than living at the bottom of a scrolling dialog.
  const pathField = () => elements(findDialog('importTitle')).find((node) => node.props.placeholder === 'importAddPlaceholder')
  assert.equal(pathField(), undefined, 'the path field is always open instead of behind the toggle')
  chips().find((node) => text(node).includes('importAddSource')).props.onClick()
  await settle()
  assert.ok(pathField() !== undefined, 'the toggle did not reveal the path field')

  const addButton = () => byName(findDialog('importTitle'), 'Button').find((node) => text(node).trim() === 'importAdd')
  assert.equal(addButton().props.disabled, true, 'the add button is live with an empty path')

  pathField().props.onChange({ target: { value: 'D:/work/.claude/skills' } })
  await settle()
  assert.equal(addButton().props.disabled, false)

  fetchCalls.length = 0
  addButton().props.onClick()
  await settle()
  assert.deepEqual(fetchCalls, [
    { url: '/dsh-skill-center/api/mutate', method: 'POST', body: { action: 'sources.add', path: 'D:/work/.claude/skills' } },
    { url: '/dsh-skill-center/api/sources', method: 'GET', body: undefined },
  ])
  // The field closes again once the directory is remembered.
  assert.equal(pathField(), undefined, 'the add row stayed open after a successful add')

  clickButton(findDialog('importTitle'), 'cancel')
  await settle()
})

await check('switching sources never changes the dialog shape', async () => {
  await selectNode('工具')
  clickButton(currentTree(), 'importAction')
  await settle()

  // The dialog is a fixed-size shell; only its inner region may vary.
  const shell = () => findDialog('importTitle')
  const body = () => elements(shell()).find((node) => hasClass(node, 'dsc-sourceBody'))
  const list = () => elements(shell()).find((node) => hasClass(node, 'dsc-sourceList'))
  assert.equal(shell().props.className.split(' ').includes('dsc-dialogWide'), true, 'the import dialog is not the fixed-size variant')
  assert.ok(body() !== undefined, 'there is no single region holding everything source-dependent')
  assert.ok(list() !== undefined, 'the skill list is not rendered for a populated source')

  // Everything whose length tracks the source must live inside that region,
  // or the dialog would resize under the pointer.
  const rowsBefore = elements(body()).filter((node) => hasClass(node, 'dsc-sourceRow')).length
  assert.equal(rowsBefore, 3, 'expected three skill rows for the default source')

  const emptyChip = elements(shell()).find((node) => hasClass(node, 'dsc-chip') && text(node).includes('dsh 用户技能'))
  emptyChip.props.onClick()
  await settle()

  assert.ok(body() !== undefined, 'the flexible region vanished with an empty source')
  assert.ok(list() !== undefined, 'the list box vanished with an empty source, so the dialog would collapse')
  assert.equal(text(shell()).includes('importNone'), true, 'an empty source says nothing')
  // The rest of the dialog is unchanged: same shell class, same controls.
  assert.equal(shell().props.className.split(' ').includes('dsc-dialogWide'), true)
  assert.ok(byName(shell(), 'Button').find((node) => text(node).trim() === 'importAction'), 'the actions moved out of the dialog')
  assert.ok(byName(shell(), 'Button').find((node) => text(node).trim() === 'importSelectAll'), 'the bulk row moved out of the dialog')

  clickButton(shell(), 'cancel')
  await settle()
})

await check('enablement, creation and import all show up without any refresh', async () => {
  // From here the stubbed host actually applies what it is told, so the next
  // read reflects it — the only way to tell "the UI updated itself" apart from
  // "the UI is showing a stale fixture".
  control.mutating = true
  await selectNode('工具')
  fetchCalls.length = 0

  // Toggling the switch flips the switch.
  const offSwitch = byLabel(currentTree(), 'enable: beta-skill')
  assert.equal(offSwitch.props['aria-checked'], 'false')
  offSwitch.props.onClick()
  await settle()
  const onSwitch = byLabel(currentTree(), 'disable: beta-skill')
  assert.ok(onSwitch !== undefined, 'the switch did not follow its own change')
  assert.equal(onSwitch.props['aria-checked'], 'true')
  // Only the command was sent: no reload, no re-open, no page refresh.
  assert.deepEqual(fetchCalls.map((call) => call.url), ['/dsh-skill-center/api/mutate'])

  // Creating a skill puts the row in the list it was filed into.
  clickButton(currentTree(), 'newSkill')
  await settle()
  elements(findDialog('skillBody')).filter((node) => node.props.type === 'text')[0].props.onChange({ target: { value: 'delta-skill' } })
  await settle()
  elements(findDialog('skillBody')).filter((node) => node.props.type === 'text')[1].props.onChange({ target: { value: 'Made here.' } })
  await settle()
  clickButton(findDialog('skillBody'), 'create')
  await settle()
  assert.equal(text(currentTree()).includes('delta-skill'), true, 'a new skill does not appear until something reloads')

  // Importing does too.
  clickButton(currentTree(), 'importAction')
  await settle()
  clickButton(findDialog('importTitle'), 'importSelectAll')
  await settle()
  clickButton(findDialog('importTitle'), 'importAction')
  await settle()
  assert.equal(text(currentTree()).includes('delta-skill'), true)
  assert.equal(text(currentTree()).includes('epsilon-skill'), true, 'imported skills do not appear until something reloads')
  clickButton(findDialog('importTitle'), 'cancel')
  await settle()

  control.mutating = false
})

console.log(`\n${checked.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
