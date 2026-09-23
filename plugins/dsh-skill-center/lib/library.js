/**
 * Skill-library disk layout.
 *
 * The library mirrors the layout `@deepseek-ai/dsh-skill-filesystem` accepts at
 * its own roots: a skill is either `<library>/<name>/SKILL.md` (a bundle, where
 * relative resources sit next to the file) or a flat `<library>/<name>.md`.
 * Discovery is one level deep on purpose, matching the native provider.
 *
 * @module dsh-skill-center/library
 */

import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readBoolean, readString, splitFrontmatter } from './frontmatter.js'

/** Public skill-name grammar: lower-case kebab-case. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Raised when a file is present but not a usable skill. */
export class InvalidSkillError extends Error {
  /** @param message - why the file cannot be used. */
  constructor(message) {
    super(message)
    this.name = 'InvalidSkillError'
  }
}

/** Raised when a library mutation cannot be carried out. */
export class LibraryError extends Error {
  /** @param message - user-facing reason. */
  constructor(message) {
    super(message)
    this.name = 'LibraryError'
  }
}

/**
 * Scan the library root for skills.
 *
 * A missing root is a valid empty library, not an error. Unusable entries are
 * reported as warnings instead of throwing, so one malformed file cannot take
 * the whole catalog (or the settings panel) down with it.
 *
 * @param libraryDir - absolute library root.
 * @returns usable skills sorted by name, plus human-readable warnings.
 */
export async function scanLibrary(libraryDir) {
  const skills = []
  const warnings = []
  let entries
  try {
    entries = await readdir(libraryDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { skills, warnings }
    throw error
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const bundle = entry.isDirectory()
    if (!bundle && !(entry.isFile() && entry.name.toLowerCase().endsWith('.md'))) continue
    const file = bundle
      ? path.join(libraryDir, entry.name, 'SKILL.md')
      : path.join(libraryDir, entry.name)
    const fallback = bundle ? entry.name : entry.name.slice(0, entry.name.length - path.extname(entry.name).length)
    try {
      skills.push(await readSkillFile(file, fallback))
    } catch (error) {
      if (error?.code === 'ENOENT') continue // directory without SKILL.md, or a dangling entry
      warnings.push(`${fallback}: ${error.message}`)
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  return { skills, warnings }
}

/**
 * Read and validate one skill file.
 * @param file - absolute path to the skill file.
 * @param fallbackName - name to use when the frontmatter omits `name`.
 * @returns the skill descriptor.
 * @throws {InvalidSkillError} when the frontmatter is unusable.
 */
export async function readSkillFile(file, fallbackName) {
  const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
  const { data, body } = splitFrontmatter(text)

  const name = readString(data, 'name') ?? fallbackName
  if (!SKILL_NAME.test(name)) {
    throw new InvalidSkillError(`invalid skill name ${JSON.stringify(name)} (expected lower-case kebab-case)`)
  }

  const description = readString(data, 'description')
  if (description === undefined || description === '') {
    throw new InvalidSkillError('missing required "description" in frontmatter')
  }

  const modelFlag = readBoolean(data, 'disable-model-invocation')
  if (modelFlag.state === 'invalid') {
    throw new InvalidSkillError(`"disable-model-invocation" is not a boolean: ${JSON.stringify(modelFlag.raw)}`)
  }
  const userFlag = readBoolean(data, 'user-invocable')
  if (userFlag.state === 'invalid') {
    throw new InvalidSkillError(`"user-invocable" is not a boolean: ${JSON.stringify(userFlag.raw)}`)
  }

  const whenToUse = readString(data, 'whenToUse') ?? readString(data, 'when-to-use')

  return {
    name,
    description,
    ...(whenToUse === undefined || whenToUse === '' ? {} : { whenToUse }),
    /** Whether the skill file itself allows model invocation. */
    fileModelInvocable: modelFlag.state === 'set' ? !modelFlag.value : true,
    /** Whether the skill file itself allows user invocation. */
    fileUserInvocable: userFlag.state === 'set' ? userFlag.value : true,
    file,
    directory: path.dirname(file),
    body,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
    /** Set when the frontmatter name and the directory name disagree. */
    nameMismatch: readString(data, 'name') !== undefined && readString(data, 'name') !== fallbackName,
  }
}

/**
 * Resolve where a skill of this name would live, refusing anything that is not
 * a direct child of the library.
 *
 * Every destructive or creative filesystem operation goes through here. The
 * name arriving from the browser is untrusted input, and the guard is a
 * positive check (the resolved parent must be the library itself) rather than a
 * blocklist of traversal spellings.
 *
 * @param libraryDir - absolute library root.
 * @param name - skill name.
 * @returns the bundle directory and the flat file path, both absolute.
 * @throws {LibraryError} when the name is not a plain skill name.
 */
export function skillPaths(libraryDir, name) {
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
    throw new LibraryError(`invalid skill name ${JSON.stringify(name)} (expected lower-case kebab-case)`)
  }
  const root = path.resolve(libraryDir)
  const bundle = path.resolve(root, name)
  const flat = path.resolve(root, `${name}.md`)
  if (path.dirname(bundle) !== root || path.dirname(flat) !== root) {
    throw new LibraryError(`skill name ${JSON.stringify(name)} does not resolve inside the library`)
  }
  return { bundle, flat }
}

/**
 * Remove a skill from the library, bundle or flat file.
 *
 * Irreversible, so the caller owns confirming it with the user. Idempotent: a
 * name that is already gone reports `removed: []` rather than failing, which
 * keeps a partially applied batch retryable.
 *
 * @param libraryDir - absolute library root.
 * @param name - skill name.
 * @returns which of the two shapes were deleted.
 * @throws {LibraryError} when the name is not a plain skill name.
 */
export async function uninstallSkill(libraryDir, name) {
  const { bundle, flat } = skillPaths(libraryDir, name)
  const removed = []
  if (await exists(bundle)) {
    await rm(bundle, { recursive: true, force: true })
    removed.push('bundle')
  }
  if (await exists(flat)) {
    await rm(flat, { force: true })
    removed.push('file')
  }
  return { name, removed }
}

/**
 * Copy one skill from a source directory into the library.
 *
 * "Import" is a copy, not a link: after this the source and the library copy are
 * independent, and editing one never affects the other. A bundle is copied whole
 * — `references/`, `scripts/` and `assets/` included — because those files are
 * what the skill's own instructions point at.
 *
 * The skill is filed under its *effective* name (the frontmatter name, falling
 * back to the directory name), so the library never contains a directory whose
 * name disagrees with the name the catalog will report.
 *
 * @param libraryDir - absolute library root.
 * @param sourceSkill - descriptor produced by a source scan.
 * @param options - `overwrite` replaces an existing library copy instead of failing.
 * @returns the imported name and whether an earlier copy was replaced.
 * @throws {LibraryError} when the name is unusable or a copy already exists.
 */
export async function importSkill(libraryDir, sourceSkill, options = {}) {
  const name = sourceSkill?.name
  const { bundle, flat } = skillPaths(libraryDir, name)
  const overwrite = options.overwrite === true
  const present = (await exists(bundle)) || (await exists(flat))
  if (present && !overwrite) {
    throw new LibraryError(`a skill named ${JSON.stringify(name)} is already in the library`)
  }
  if (present) {
    // Clear both shapes first: leaving one behind would merge the copy into it.
    await rm(bundle, { recursive: true, force: true })
    await rm(flat, { force: true })
  }

  if (path.basename(sourceSkill.file).toLowerCase() === 'skill.md') {
    await cp(sourceSkill.directory, bundle, { recursive: true })
  } else {
    await copyFile(sourceSkill.file, flat)
  }
  return { name, replaced: present }
}

/**
 * Scaffold a new skill bundle and return it in the shape a scan would produce.
 *
 * The written file always carries a description: skill-center's own reader (and
 * the native one) rejects a skill without one, so a scaffold that omitted it
 * would vanish from the catalog the moment it was created.
 *
 * @param libraryDir - absolute library root.
 * @param name - skill name.
 * @param description - one-line routing description.
 * @param body - optional Markdown body; a placeholder is written when omitted.
 * @returns the descriptor of the created skill.
 * @throws {LibraryError} when the name is invalid or already taken.
 */
export async function createSkill(libraryDir, name, description, body) {
  const { bundle, flat } = skillPaths(libraryDir, name)
  if ((await exists(bundle)) || (await exists(flat))) {
    throw new LibraryError(`a skill named ${JSON.stringify(name)} already exists`)
  }
  const summary = typeof description === 'string' ? description.trim().replace(/\s+/g, ' ') : ''
  const text = summary === '' ? 'TODO — describe when this skill applies.' : summary
  await mkdir(bundle, { recursive: true })
  const file = path.join(bundle, 'SKILL.md')
  await writeFile(file, renderScaffold(name, text, normalizeBody(body)), 'utf8')
  return readSkillFile(file, name)
}

/**
 * Normalize a caller-supplied skill body.
 *
 * Line endings are unified so the file is stable across platforms, and a
 * leading frontmatter block is dropped: the panel has dedicated fields for the
 * header, so pasting a whole `SKILL.md` into the body field must not leave a
 * second header stranded inside the body.
 *
 * @param raw - body as it arrived from the caller.
 * @returns the body text, without a leading or trailing blank run.
 */
function normalizeBody(raw) {
  if (typeof raw !== 'string') return ''
  const { body, present } = splitFrontmatter(raw.replace(/\r\n?/g, '\n'))
  return (present ? body : raw.replace(/\r\n?/g, '\n')).replace(/^\n+/, '').replace(/\s+$/, '')
}

/**
 * Render the scaffold of a new skill.
 * @param name - skill name.
 * @param description - frontmatter description (already non-empty).
 * @param body - normalized body; empty means write the placeholder.
 * @returns the complete file contents.
 */
function renderScaffold(name, description, body) {
  const content =
    body === ''
      ? `# ${name}\n\nDescribe what this skill does, then the steps to follow.`
      : body
  return [
    '---',
    `name: ${name}`,
    // Quote and escape so a description containing `:` or `#` still parses.
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    content,
    '',
  ].join('\n')
}

/**
 * Test for an existing path without treating other errors as absence.
 * @param target - absolute path.
 * @returns whether something exists there.
 */
async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
