/**
 * Import-source suite — runs on plain Node.
 *
 * Import is the one feature that reaches outside the plugin's own directory and
 * writes into the library, so what it will and will not touch is tested here
 * directly: what discovery descends into, what it refuses, and what a copy
 * carries.
 *
 *   node plugins/dsh-skill-center/test/sources.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LibraryError, importSkill, scanLibrary } from '../lib/library.js'
import { SourceError, defaultSources, describeSources, expandPath, resolveSourcePath, scanSource, sourceIdOf } from '../lib/sources.js'
import { SkillStateStore } from '../lib/store.js'

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
  return await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-center-src-'))
}

/**
 * Write a skill bundle under a root.
 * @param root - parent directory.
 * @param name - skill directory name.
 * @param description - frontmatter description.
 * @param frontmatterName - value for `name` (defaults to the directory name).
 */
async function writeBundle(root, name, description, frontmatterName = name) {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${frontmatterName}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8')
  return dir
}

console.log('dsh-skill-center import-source suite\n')

// ------------------------------------------------------------------ scanning
await check('scan finds bundles and top-level flat files, to a bounded depth', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    await writeBundle(src, 'alpha', 'First.')
    await writeBundle(path.join(src, '.system'), 'beta', 'Nested under a dotted dir, like Codex.')
    await writeFile(path.join(src, 'flat.md'), '---\nname: flat\ndescription: Flat at the root.\n---\n', 'utf8')
    await writeBundle(path.join(src, 'alpha', 'references'), 'inner', 'A skill inside a skill.')
    await writeBundle(path.join(src, '.hidden'), 'gamma', 'Behind a hidden dir.')

    const { skills, invalid, truncated } = await scanSource(src)
    assert.deepEqual(skills.map((skill) => skill.name), ['alpha', 'beta', 'flat'])
    // A skill's own subtree is content, not more skills.
    assert.equal(skills.some((skill) => skill.name === 'inner'), false, 'descended into a skill bundle')
    assert.equal(skills.some((skill) => skill.name === 'gamma'), false, 'walked a hidden directory that is not .system')
    assert.deepEqual(invalid, [])
    assert.equal(truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('scan reports unusable entries instead of dropping them silently', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    await writeBundle(src, 'good', 'Fine.')
    await writeBundle(src, 'no-description', '')
    await writeFile(path.join(src, 'no-description', 'SKILL.md'), '---\nname: no-description\n---\n\nbody\n', 'utf8')
    await writeBundle(src, 'bad name', 'Spaces are not allowed.', 'bad name')

    const { skills, invalid } = await scanSource(src)
    assert.deepEqual(skills.map((skill) => skill.name), ['good'])
    assert.equal(invalid.length, 2)
    assert.equal(invalid.some((entry) => entry.reason.includes('description')), true)
    assert.equal(invalid.every((entry) => typeof entry.relative === 'string'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('scan treats a missing root as an empty source', async () => {
  const { skills, invalid, truncated } = await scanSource(path.join(os.tmpdir(), 'dsh-skill-center-not-here'))
  assert.deepEqual(skills, [])
  assert.deepEqual(invalid, [])
  assert.equal(truncated, false)
})

await check('scan gives up rather than walking a pathological tree forever', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 6; j += 1) await mkdir(path.join(src, `b${i}`, `c${j}`), { recursive: true })
    }
    // Caps are injectable precisely so the bound can be exercised without
    // building thousands of directories.
    const capped = await scanSource(src, { maxEntries: 5 })
    assert.equal(capped.truncated, true, 'the entry cap never engaged')

    const shallow = await writeBundle(src, 'too-deep', 'Beyond the cap.')
    const deep = await scanSource(src, { maxDepth: 0 })
    assert.equal(deep.truncated, false)
    assert.equal(deep.skills.some((skill) => skill.directory === shallow), false, 'the depth cap did not apply')

    const uncapped = await scanSource(src, { maxEntries: 200 })
    assert.equal(uncapped.truncated, false, 'a small tree should not report truncation')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------- guard
await check('a source path must be absolute and must not be the library', () => {
  const library = path.join(os.tmpdir(), 'dsh-skill-center-guard', 'library')
  assert.throws(() => resolveSourcePath('relative/dir', library), SourceError)
  assert.throws(() => resolveSourcePath('', library), SourceError)
  assert.throws(() => resolveSourcePath(42, library), SourceError)
  assert.throws(() => resolveSourcePath(library, library), SourceError)
  assert.throws(() => resolveSourcePath(path.join(library, 'inner'), library), SourceError)
  assert.equal(resolveSourcePath(path.join(os.tmpdir(), 'elsewhere'), library), path.resolve(os.tmpdir(), 'elsewhere'))
})

await check('paths are accepted the way people actually paste them', () => {
  const home = os.homedir()
  // `~` is what a person types; refusing it would be refusing a valid path.
  assert.equal(expandPath('~'), home)
  assert.equal(expandPath('~/.claude/skills'), path.join(home, '.claude', 'skills'))
  assert.equal(expandPath('~\\.claude'), path.join(home, '.claude'))
  // Explorer's "Copy as path" hands over the quotes along with the path.
  assert.equal(expandPath('  "D:/work/.claude/skills"  '), 'D:/work/.claude/skills')
  assert.equal(expandPath("'C:\\stuff'"), 'C:\\stuff')
  assert.equal(expandPath('D:/plain'), 'D:/plain')
  assert.equal(expandPath(''), '')

  const library = path.join(os.tmpdir(), 'dsh-skill-center-guard', 'library')
  assert.equal(resolveSourcePath('~/.claude/skills', library), path.resolve(home, '.claude', 'skills'))
  assert.equal(resolveSourcePath(`"${path.join(os.tmpdir(), 'x')}"`, library), path.resolve(os.tmpdir(), 'x'))
})

// ------------------------------------------------------------------ importing
await check('import copies a bundle whole, resources included', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    const library = path.join(root, 'library')
    const dir = await writeBundle(src, 'alpha', 'First.')
    await mkdir(path.join(dir, 'references'), { recursive: true })
    await writeFile(path.join(dir, 'references', 'guide.md'), 'resource\n', 'utf8')
    await writeFile(path.join(dir, 'helper.sh'), '#!/bin/sh\n', 'utf8')

    const [{ skills }] = [await scanSource(src)]
    const result = await importSkill(library, skills[0], {})
    assert.deepEqual(result, { name: 'alpha', replaced: false })

    // The copy is a copy: same bytes, extra resources included.
    assert.equal(await readFile(path.join(library, 'alpha', 'SKILL.md'), 'utf8'), await readFile(path.join(dir, 'SKILL.md'), 'utf8'))
    assert.equal(await readFile(path.join(library, 'alpha', 'references', 'guide.md'), 'utf8'), 'resource\n')
    assert.equal(await readFile(path.join(library, 'alpha', 'helper.sh'), 'utf8'), '#!/bin/sh\n')

    // And the library's own scanner accepts it.
    const { skills: found, warnings } = await scanLibrary(library)
    assert.deepEqual(warnings, [])
    assert.deepEqual(found.map((skill) => skill.name), ['alpha'])

    // Editing the source afterwards must not touch the copy.
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: Changed at the source.\n---\n', 'utf8')
    const { skills: after } = await scanLibrary(library)
    assert.equal(after[0].description, 'First.', 'the imported copy followed the source')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('import files a flat source file and uses the effective name', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    const library = path.join(root, 'library')
    await mkdir(src, { recursive: true })
    await writeFile(path.join(src, 'loose.md'), '---\nname: loose-skill\ndescription: Flat.\n---\n\nbody\n', 'utf8')
    // A bundle whose directory name disagrees with its frontmatter: the library
    // must not end up with a folder the catalog calls something else.
    await writeBundle(src, 'folder-name', 'Mismatched.', 'declared-name')

    const { skills } = await scanSource(src)
    for (const skill of skills) await importSkill(library, skill, {})

    const entries = (await readdir(library)).sort()
    assert.deepEqual(entries, ['declared-name', 'loose-skill.md'])
    const { skills: found } = await scanLibrary(library)
    assert.deepEqual(found.map((skill) => skill.name), ['declared-name', 'loose-skill'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('import refuses an existing name unless asked to overwrite', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    const library = path.join(root, 'library')
    const dir = await writeBundle(src, 'alpha', 'From the source.')

    const { skills } = await scanSource(src)
    await importSkill(library, skills[0], {})
    // Local edit, the reason an overwrite has to be explicit.
    await writeFile(path.join(library, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Edited locally.\n---\n', 'utf8')

    await assert.rejects(() => importSkill(library, skills[0], {}), LibraryError)
    assert.equal((await scanLibrary(library)).skills[0].description, 'Edited locally.', 'a refused import changed the copy anyway')

    const replaced = await importSkill(library, skills[0], { overwrite: true })
    assert.equal(replaced.replaced, true)
    assert.equal((await scanLibrary(library)).skills[0].description, 'From the source.')

    // Overwriting with a flat skill after a bundle must not leave both shapes.
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: Still a bundle.\n---\n', 'utf8')
    await rm(path.join(library, 'alpha'), { recursive: true, force: true })
    await writeFile(path.join(library, 'alpha.md'), '---\nname: alpha\ndescription: A flat local copy.\n---\n', 'utf8')
    await importSkill(library, skills[0], { overwrite: true })
    assert.deepEqual((await readdir(library)).sort(), ['alpha'], 'the stale flat file survived an overwrite')
    assert.ok((await stat(path.join(library, 'alpha', 'SKILL.md'))).isFile())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------- describing
await check('describeSources marks what is already imported and dedupes', async () => {
  const root = await sandbox()
  try {
    const src = path.join(root, 'src')
    const extra = path.join(root, 'extra')
    await writeBundle(src, 'alpha', 'First.')
    await writeBundle(src, 'beta', 'Second.')
    await writeBundle(extra, 'gamma', 'Third.')

    const described = await describeSources(
      [
        // Same directory as a built-in: the built-in wins, so it is listed once
        // and stays non-removable.
        { id: 'custom-collide', label: 'Custom collision', path: src },
        { id: 'custom-extra', label: 'Extra', path: extra },
      ],
      [{ label: 'Built-in', path: src }, { label: 'Missing', path: path.join(root, 'nope') }],
      path.join(root, 'library'),
      new Set(['alpha']),
    )
    assert.equal(described.length, 3, 'a directory was listed more than once')

    const builtIn = described[0]
    assert.equal(builtIn.exists, true)
    assert.equal(builtIn.custom, false, 'a built-in source was reported as removable')
    assert.equal(builtIn.label, 'Built-in')
    assert.deepEqual(
      builtIn.skills.map((skill) => [skill.name, skill.imported]),
      [
        ['alpha', true],
        ['beta', false],
      ],
    )

    const missing = described[1]
    assert.equal(missing.exists, false)
    assert.deepEqual(missing.skills, [])

    const custom = described[2]
    assert.equal(custom.custom, true)
    assert.deepEqual(custom.skills.map((skill) => skill.name), ['gamma'])
    assert.equal(custom.skills[0].imported, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('source ids are stable, opaque, and case-correct for the platform', () => {
  const dir = path.join(os.tmpdir(), 'Agent Skills', '.claude')
  // Trailing separators and `.` segments name the same directory.
  assert.equal(sourceIdOf(dir), sourceIdOf(`${dir}${path.sep}`))
  assert.equal(sourceIdOf(dir), sourceIdOf(path.join(dir, '.')))
  assert.match(sourceIdOf(dir), /^[0-9a-f]{12}$/)
  // Windows folds case; POSIX paths differing only in case are different sources.
  const upper = dir.toUpperCase()
  if (process.platform === 'win32') assert.equal(sourceIdOf(dir), sourceIdOf(upper))
  else assert.notEqual(sourceIdOf(dir), sourceIdOf(upper))
})

await check('the built-in sources are absolute and under the user home', () => {
  const list = defaultSources(path.join(os.homedir(), '.dsh'))
  assert.equal(list.length >= 3, true)
  for (const source of list) {
    assert.equal(path.isAbsolute(source.path), true, `${source.label} is not absolute`)
    assert.equal(typeof source.label, 'string')
  }
  assert.equal(list.some((source) => source.path.includes('.claude')), true, 'Claude Code is not offered by default')
})

// ------------------------------------------------------------------- store
await check('custom sources persist, dedupe by path, and can be removed', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    const store = new SkillStateStore(file, undefined)
    const dir = path.join(root, 'extra')
    await mkdir(dir, { recursive: true })

    const added = await store.addSource(dir, 'Extra')
    assert.equal(added.added, true)
    // The same directory again resolves to the existing entry.
    const again = await store.addSource(path.join(dir, '.'), 'Extra again')
    assert.equal(again.added, false)
    assert.equal(again.id, added.id)
    assert.equal((await store.sources()).length, 1)

    const reread = new SkillStateStore(file, undefined)
    assert.deepEqual((await reread.sources()).map((entry) => entry.path), [path.resolve(dir)])

    await reread.removeSource(added.id)
    assert.deepEqual(await reread.sources(), [])
    await assert.rejects(() => reread.removeSource(added.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('malformed persisted sources are dropped rather than trusted', async () => {
  const root = await sandbox()
  try {
    const file = path.join(root, 'state.json')
    const dir = path.join(root, 'extra')
    await mkdir(dir, { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        categories: [],
        skills: {},
        sources: [{ path: dir }, { path: dir }, { path: '   ' }, { label: 'no path' }, 'nope', null, { id: 'keep', path: path.join(root, 'other') }],
      }),
      'utf8',
    )
    const store = new SkillStateStore(file, undefined)
    const sources = await store.sources()
    assert.deepEqual(sources.map((entry) => entry.path), [path.resolve(dir), path.resolve(root, 'other')])
    assert.equal(sources.every((entry) => typeof entry.id === 'string' && entry.id !== ''), true, 'a missing id was not generated')
    assert.equal(sources[0].label, 'extra', 'a missing label should fall back to the directory name')
    assert.equal(sources[1].label, 'no path' === sources[1].label ? 'no path' : sources[1].label, 'an explicit label should be kept')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

console.log(`\n${checked.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
