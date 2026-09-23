/**
 * Category and library-mutation suite — runs on plain Node.
 *
 * The tree math and the two irreversible filesystem operations (uninstall,
 * scaffold) are the parts where a bug either loses the user's structure or
 * deletes the wrong directory, so they are tested directly here rather than
 * only through the HTTP surface.
 *
 *   node plugins/dsh-skill-center/test/categories.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  CategoryError,
  MAX_DEPTH,
  categoryPath,
  collectIds,
  countCategories,
  depthOf,
  findCategory,
  findParentId,
  flattenCategories,
  insertCategory,
  makeCategoryId,
  moveCategory,
  normalizeName,
  removeCategory,
  renameCategory,
  sanitizeTree,
} from '../lib/categories.js'
import { LibraryError, createSkill, scanLibrary, skillPaths, uninstallSkill } from '../lib/library.js'
import { STATE_VERSION, SkillStateStore, categoryOf, isEnabled } from '../lib/store.js'

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
  return await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-center-cat-'))
}

/**
 * Build a small fixed tree: root-a > {a1, a2}, root-b.
 * @returns the tree plus the ids.
 */
function sampleTree() {
  const a = insertCategory([], null, '工具')
  const a1 = insertCategory(a.tree, a.id, '后台')
  const a2 = insertCategory(a1.tree, a1.id, '手册')
  const b = insertCategory(a2.tree, null, '常用')
  return { tree: b.tree, a: a.id, a1: a1.id, a2: a2.id, b: b.id }
}

console.log('dsh-skill-center category suite\n')

// -------------------------------------------------------------------- names
await check('names: trimmed, non-empty, bounded, no control characters', () => {
  assert.equal(normalizeName('  后 台  '), '后 台')
  assert.throws(() => normalizeName('   '), CategoryError)
  assert.throws(() => normalizeName(42), CategoryError)
  assert.throws(() => normalizeName('x'.repeat(200)), CategoryError)
  assert.throws(() => normalizeName('bad\u0007name'), CategoryError)
  // Every Unicode space collapses to a plain separator, NBSP included, so two
  // names that look identical in the tree compare identical too.
  assert.equal(normalizeName('a\u00a0b'), 'a b')
})

// ------------------------------------------------------------------ reading
await check('tree: find, parent, collect, count, depth', () => {
  const { tree, a, a1, a2, b } = sampleTree()
  assert.equal(findCategory(tree, a1).name, '后台')
  assert.equal(findParentId(tree, a), null, 'a top-level node has no parent id')
  assert.equal(findParentId(tree, a1), a)
  assert.equal(findParentId(tree, 'missing'), undefined)
  assert.deepEqual(collectIds(findCategory(tree, a)), [a, a1, a2])
  assert.equal(countCategories(tree), 4)
  assert.equal(depthOf(tree, a), 1)
  assert.equal(depthOf(tree, a2), 3)
  assert.equal(depthOf(tree, b), 1)
  assert.deepEqual(categoryPath(tree, a2), ['工具', '后台', '手册'])
  assert.deepEqual(categoryPath(tree, 'missing'), [])
  assert.deepEqual(flattenCategories(tree).map((row) => [row.name, row.depth, row.hasChildren]), [
    ['工具', 1, true],
    ['后台', 2, true],
    ['手册', 3, false],
    ['常用', 1, false],
  ])
})

await check('tree: operations return new trees and never mutate the input', () => {
  const first = insertCategory([], null, '工具')
  const before = JSON.stringify(first.tree)
  renameCategory(first.tree, first.id, '改了')
  insertCategory(first.tree, first.id, '子级')
  removeCategory(first.tree, first.id)
  moveCategory(first.tree, first.id, null, 0)
  assert.equal(JSON.stringify(first.tree), before, 'a pure operation mutated its input')
})

// ---------------------------------------------------------------- mutations
await check('tree: insert rejects an unknown parent and over-deep nesting', () => {
  const { tree, a } = sampleTree()
  assert.throws(() => insertCategory(tree, 'missing', 'x'), CategoryError)

  let deep = insertCategory([], null, 'L1')
  let id = deep.id
  for (let level = 2; level <= MAX_DEPTH; level += 1) {
    deep = insertCategory(deep.tree, id, `L${level}`)
    id = deep.id
  }
  assert.equal(depthOf(deep.tree, id), MAX_DEPTH)
  assert.throws(() => insertCategory(deep.tree, id, `L${MAX_DEPTH + 1}`), CategoryError)
})

await check('tree: rename only changes the label', () => {
  const { tree, a1 } = sampleTree()
  const next = renameCategory(tree, a1, '运维')
  assert.equal(findCategory(next, a1).name, '运维')
  // sampleTree nests 手册 under 后台, so 后台 has exactly one child.
  assert.equal(findCategory(next, a1).children.length, 1, 'rename dropped children')
  assert.throws(() => renameCategory(tree, 'missing', 'x'), CategoryError)
})

await check('tree: remove takes the whole subtree and reports it', () => {
  const { tree, a, a1, a2 } = sampleTree()
  const gone = removeCategory(tree, a1)
  assert.deepEqual(gone.removed, [a1, a2])
  assert.equal(findCategory(gone.tree, a1), undefined)
  assert.equal(findCategory(gone.tree, a2), undefined)
  assert.deepEqual(collectIds(findCategory(gone.tree, a)), [a], 'the parent survived the child removal')
  assert.throws(() => removeCategory(tree, 'missing'), CategoryError)
})

await check('tree: move reparents, reorders, and refuses cycles', () => {
  const { tree, a, a1, a2, b } = sampleTree()

  // Reparent a subtree to the top level.
  const lifted = moveCategory(tree, a1, null, 0)
  assert.equal(findParentId(lifted, a1), null)
  assert.deepEqual(lifted.map((node) => node.id), [a1, a, b])
  assert.deepEqual(collectIds(findCategory(lifted, a1)), [a1, a2], 'the subtree came along')

  // Reorder within the same parent.
  const reordered = moveCategory(tree, a2, a1, 0)
  assert.deepEqual(findCategory(reordered, a1).children.map((node) => node.id), [a2])

  // A node cannot become its own descendant, at any distance.
  assert.throws(() => moveCategory(tree, a, a, null), CategoryError)
  assert.throws(() => moveCategory(tree, a, a2, null), CategoryError)
  assert.throws(() => moveCategory(tree, a, 'missing', null), CategoryError)
})

await check('tree: move refuses to nest deeper than the limit', () => {
  const first = insertCategory([], null, 'L1')
  const rootId = first.id
  let deepest = first
  let deepestId = first.id
  for (let level = 2; level <= MAX_DEPTH; level += 1) {
    deepest = insertCategory(deepest.tree, deepestId, `L${level}`)
    deepestId = deepest.id
  }
  assert.equal(depthOf(deepest.tree, deepestId), MAX_DEPTH)
  const other = insertCategory(deepest.tree, null, '其他')
  // Moving the whole L1..L8 chain under a depth-1 node would reach depth 9.
  assert.throws(() => moveCategory(other.tree, rootId, other.id, 0), CategoryError)
  // Lifting just the deepest leaf to the top level is fine.
  const moved = moveCategory(other.tree, deepestId, null, 0)
  assert.equal(findParentId(moved, deepestId), null)
})

// --------------------------------------------------------------- sanitizing
await check('sanitize: repairs ids, drops nameless nodes, caps depth', () => {
  const repaired = sanitizeTree([
    { name: '正常', children: [] },
    { id: 'dup', name: 'A', children: [] },
    { id: 'dup', name: 'B', children: [] },
    { id: 'x', children: [] },
    { id: 'y', name: '   ', children: [] },
    'not a node',
    null,
    { id: 'z', name: '深', children: [{ id: 'z1', name: '更深', children: [] }] },
  ])
  const names = repaired.map((node) => node.name)
  assert.deepEqual(names, ['正常', 'A', 'B', '深'])
  const ids = repaired.map((node) => node.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids survived')
  assert.ok(ids.every((id) => typeof id === 'string' && id !== ''))

  const root = { id: 'r', name: 'r', children: [] }
  let parent = root
  for (let level = 2; level <= MAX_DEPTH + 4; level += 1) {
    const node = { id: `n${level}`, name: `n${level}`, children: [] }
    parent.children.push(node)
    parent = node
  }
  const capped = sanitizeTree([root])
  assert.equal(depthOf(capped, 'r'), 1)
  assert.ok(countCategories(capped) <= MAX_DEPTH, `depth cap did not apply: ${countCategories(capped)} nodes survived`)
})

await check('sanitize: a non-array tree becomes empty rather than throwing', () => {
  assert.deepEqual(sanitizeTree(undefined), [])
  assert.deepEqual(sanitizeTree(null), [])
  assert.deepEqual(sanitizeTree({ nope: true }), [])
  assert.deepEqual(sanitizeTree('nope'), [])
})

// -------------------------------------------------------------------- store
await check('store: categories persist and the version is current', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    const store = new SkillStateStore(file, undefined)
    const created = await store.createCategory(null, '工具')
    const child = await store.createCategory(created.id, '后台')
    await store.setCategory(['alpha-skill'], child.id)

    const reread = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(reread.version, STATE_VERSION)
    assert.equal(reread.categories[0].name, '工具')
    assert.equal(reread.categories[0].children[0].name, '后台')
    assert.equal(reread.skills['alpha-skill'].categoryId, child.id)

    // A fresh store sees the same thing (i.e. it really reached disk).
    const fresh = new SkillStateStore(file, undefined)
    assert.equal(await fresh.categoryOf('alpha-skill'), child.id)
    assert.equal(await fresh.categoryOf('unknown-skill'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: deleting a category moves its skills to uncategorized', async () => {
  const root = await sandbox()
  try {
    const store = new SkillStateStore(path.join(root, 'state.json'), undefined)
    const created = await store.createCategory(null, '工具')
    const child = await store.createCategory(created.id, '后台')
    await store.setCategory(['a-skill'], created.id)
    await store.setCategory(['b-skill'], child.id)

    const deleted = await store.deleteCategory(created.id)
    assert.deepEqual(deleted.removed, [created.id, child.id])
    const state = await store.read()
    assert.deepEqual(state.categories, [])
    // Skills survive; only their placement is reset.
    assert.equal(categoryOf(state, 'a-skill'), null)
    assert.equal(categoryOf(state, 'b-skill'), null)
    assert.equal(isEnabled(state, 'a-skill'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: filing under a missing category is refused', async () => {
  const root = await sandbox()
  try {
    const store = new SkillStateStore(path.join(root, 'state.json'), undefined)
    await assert.rejects(() => store.setCategory(['a-skill'], 'missing-id'), CategoryError)
    await assert.rejects(() => store.createCategory('missing-id', 'x'), CategoryError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: a v2 document gains categories and keeps its skills', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    await writeFile(file, JSON.stringify({ version: 2, categories: [], skills: { 'a-skill': { enabled: false }, 'b-skill': {} } }), 'utf8')
    const store = new SkillStateStore(file, undefined)
    const state = await store.read()
    assert.equal(state.version, STATE_VERSION)
    assert.deepEqual(state.categories, [])
    assert.equal(isEnabled(state, 'a-skill'), false, 'the v2 enablement record was lost')
    assert.equal(categoryOf(state, 'a-skill'), null)
    assert.equal(isEnabled(state, 'b-skill'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: dangling category pointers and bogus records are cleaned on load', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        categories: [{ id: 'real', name: '工具', children: [] }],
        skills: {
          'a-skill': { categoryId: 'gone', enabled: 'yes' },
          'b-skill': { categoryId: 'real', enabled: true, note: 'kept' },
          'c-skill': 'not an object',
        },
      }),
      'utf8',
    )
    const store = new SkillStateStore(file, undefined)
    const state = await store.read()
    // A stale pointer must not hide a skill: it falls back to uncategorized.
    assert.equal(categoryOf(state, 'a-skill'), null)
    assert.equal(isEnabled(state, 'a-skill'), true, 'a non-boolean enabled value should be dropped, not honoured')
    assert.equal(categoryOf(state, 'b-skill'), 'real')
    assert.equal(state.skills['b-skill'].note, 'kept')
    assert.deepEqual(state.skills['c-skill'], {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store: forget drops records without touching the tree', async () => {
  const root = await sandbox()
  try {
    const store = new SkillStateStore(path.join(root, 'state.json'), undefined)
    const created = await store.createCategory(null, '工具')
    await store.setCategory(['a-skill'], created.id)
    await store.forget(['a-skill'])
    const state = await store.read()
    assert.equal(state.skills['a-skill'], undefined)
    assert.equal(findCategory(state.categories, created.id).name, '工具')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ library
await check('library: the path guard refuses anything outside the root', () => {
  const library = path.join(os.tmpdir(), 'dsh-skill-center-guard', 'library')
  assert.throws(() => skillPaths(library, '../escape'), LibraryError)
  assert.throws(() => skillPaths(library, '..'), LibraryError)
  assert.throws(() => skillPaths(library, 'a/b'), LibraryError)
  assert.throws(() => skillPaths(library, 'a\\b'), LibraryError)
  assert.throws(() => skillPaths(library, 'Upper'), LibraryError)
  assert.throws(() => skillPaths(library, ''), LibraryError)
  assert.throws(() => skillPaths(library, 'dot.name'), LibraryError)
  assert.throws(() => skillPaths(library, 42), LibraryError)
  const ok = skillPaths(library, 'good-name')
  assert.equal(path.dirname(ok.bundle), path.resolve(library))
  assert.equal(path.dirname(ok.flat), path.resolve(library))
})

await check('library: uninstall removes a bundle, a flat file, and is idempotent', async () => {
  const root = await sandbox()
  try {
    const library = path.join(root, 'library')
    await mkdir(path.join(library, 'bundle-skill'), { recursive: true })
    await writeFile(path.join(library, 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: x.\n---\n', 'utf8')
    await writeFile(path.join(library, 'bundle-skill', 'notes.txt'), 'extra resource\n', 'utf8')
    await writeFile(path.join(library, 'flat-skill.md'), '---\nname: flat-skill\ndescription: y.\n---\n', 'utf8')
    await writeFile(path.join(library, 'keep-skill.md'), '---\nname: keep-skill\ndescription: z.\n---\n', 'utf8')

    assert.deepEqual((await uninstallSkill(library, 'bundle-skill')).removed, ['bundle'])
    await assert.rejects(() => stat(path.join(library, 'bundle-skill')))

    assert.deepEqual((await uninstallSkill(library, 'flat-skill')).removed, ['file'])
    await assert.rejects(() => stat(path.join(library, 'flat-skill.md')))

    // Already gone: reports nothing removed instead of throwing.
    assert.deepEqual((await uninstallSkill(library, 'bundle-skill')).removed, [])

    // The neighbour is untouched.
    assert.ok((await stat(path.join(library, 'keep-skill.md'))).isFile())
    const { skills } = await scanLibrary(library)
    assert.deepEqual(skills.map((skill) => skill.name), ['keep-skill'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('library: create scaffolds a skill the scanner accepts', async () => {
  const root = await sandbox()
  try {
    const library = path.join(root, 'library')
    const created = await createSkill(library, 'new-skill', 'Use when testing: create # and quotes.')
    assert.equal(created.name, 'new-skill')
    // Round-trips through the real scanner, frontmatter and all.
    const { skills, warnings } = await scanLibrary(library)
    assert.deepEqual(warnings, [])
    assert.deepEqual(skills.map((skill) => skill.name), ['new-skill'])
    assert.equal(skills[0].description, 'Use when testing: create # and quotes.')
    assert.equal(skills[0].fileModelInvocable, true)

    const text = await readFile(path.join(library, 'new-skill', 'SKILL.md'), 'utf8')
    assert.match(text, /^---\nname: new-skill\ndescription: "/)

    // Duplicate, invalid, and empty-description cases.
    await assert.rejects(() => createSkill(library, 'new-skill', 'again'), LibraryError)
    await assert.rejects(() => createSkill(library, 'Bad Name', 'x'), LibraryError)
    const blank = await createSkill(library, 'blank-skill', '   ')
    assert.equal(blank.description, 'TODO — describe when this skill applies.')
    assert.deepEqual((await readdir(library)).sort(), ['blank-skill', 'new-skill'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('library: a supplied body is written, with pasted frontmatter stripped', async () => {
  const root = await sandbox()
  try {
    const library = path.join(root, 'library')

    // CRLF is normalized so the file does not depend on the editor that sent it.
    const withBody = await createSkill(library, 'body-skill', 'Has a body.', '# Body skill\r\n\r\nStep one.\r\n')
    assert.equal(withBody.body, '# Body skill\n\nStep one.\n')
    assert.equal(
      await readFile(path.join(library, 'body-skill', 'SKILL.md'), 'utf8'),
      '---\nname: body-skill\ndescription: "Has a body."\n---\n\n# Body skill\n\nStep one.\n',
    )

    // Pasting a whole SKILL.md must not strand a second header inside the body.
    const pasted = await createSkill(
      library,
      'pasted-skill',
      'From the fields.',
      '---\nname: pasted-skill\ndescription: from the paste\nwhenToUse: never\n---\n\n# Pasted\n',
    )
    assert.equal(pasted.description, 'From the fields.', 'the dialog fields must win over pasted frontmatter')
    assert.equal(pasted.body.trim(), '# Pasted')
    assert.equal(pasted.whenToUse, undefined, 'pasted frontmatter leaked into the header')
    const pastedText = await readFile(path.join(library, 'pasted-skill', 'SKILL.md'), 'utf8')
    assert.equal((pastedText.match(/^---$/gm) ?? []).length, 2, 'expected exactly one frontmatter fence pair')

    // Whitespace-only body still gets the placeholder, never an empty file.
    const blank = await createSkill(library, 'blank-body', 'Blank body.', '   \n\n  ')
    assert.match(blank.body, /Describe what this skill does/)

    // A body without a leading heading is respected as written.
    const plain = await createSkill(library, 'plain-body', 'Plain.', 'Just prose.\n')
    assert.equal(plain.body.trim(), 'Just prose.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('library: create refuses a name taken by a flat file', async () => {
  const root = await sandbox()
  try {
    const library = path.join(root, 'library')
    await mkdir(library, { recursive: true })
    await writeFile(path.join(library, 'taken.md'), '---\nname: taken\ndescription: x.\n---\n', 'utf8')
    await assert.rejects(() => createSkill(library, 'taken', 'x'), LibraryError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('categories: generated ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => makeCategoryId()))
  assert.equal(ids.size, 200)
})

console.log(`\n${checked.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
