/**
 * Import sources — read-only skill roots outside the library.
 *
 * A source is a directory a *different* tool keeps its skills in (`~/.claude`,
 * `~/.codex`, `~/.agents`, the harness's own user root). Skill-center never
 * writes to a source, never watches it, and never lets it govern enablement;
 * importing copies a skill in, after which the two copies are independent.
 *
 * Discovery is deeper than the library's one level on purpose: conventions in
 * the wild disagree about nesting. Claude Code keeps `<root>/<name>/SKILL.md`;
 * Codex keeps `<root>/.system/<name>/SKILL.md`. So a source is walked to a
 * bounded depth, every directory holding a `SKILL.md` is a skill, and a skill's
 * own subtree is not descended into (its `references/`, `scripts/` and `assets/`
 * are content, not more skills). Flat `<root>/<name>.md` files are accepted only
 * at the top level, mirroring the library's own layout rule.
 *
 * @module dsh-skill-center/sources
 */

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { InvalidSkillError, SKILL_NAME, readSkillFile } from './library.js'

/** How deep to look for a skill directory, counting the root as 0. */
export const MAX_DEPTH = 4

/** How many directory entries one source scan may visit before giving up. */
export const MAX_ENTRIES = 4000

/** How many skills one source scan may collect before giving up. */
export const MAX_SKILLS = 2000

/** Directory names never worth descending into. */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * The sources offered without any configuration.
 *
 * Deliberately the small, user-level set: these are the directories that exist
 * on an ordinary machine and hold tens of skills, so listing them stays cheap.
 * A big cache or a project directory is added by the user instead, because a
 * scan of it is neither small nor always wanted.
 *
 * @param dshHome - the harness home directory.
 * @returns source descriptors without ids (ids are derived from the path).
 */
export function defaultSources(dshHome) {
  const home = os.homedir()
  return [
    { label: 'Claude Code', path: path.join(home, '.claude', 'skills') },
    { label: 'Codex', path: path.join(home, '.codex', 'skills') },
    { label: 'agents 共享', path: path.join(home, '.agents', 'skills') },
    { label: 'dsh 用户技能', path: path.join(dshHome, 'skills') },
  ]
}

/**
 * The comparison key for a source directory.
 *
 * Windows paths are case-insensitive and POSIX paths are not, so collapsing case
 * everywhere would fuse two genuinely different directories on Linux — and
 * comparing verbatim would list one directory twice on Windows.
 *
 * @param sourcePath - any path spelling.
 * @returns the key to dedupe and hash by.
 */
export function sourceKey(sourcePath) {
  const resolved = path.resolve(sourcePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Derive a stable id from a source path.
 *
 * A digest rather than a readable slug: a slug has to collapse punctuation and
 * case, and two different directories must never share an id.
 *
 * @param sourcePath - absolute directory path.
 * @returns the id.
 */
export function sourceIdOf(sourcePath) {
  return createHash('sha1').update(sourceKey(sourcePath)).digest('hex').slice(0, 12)
}

/**
 * Expand the spellings a person actually types for a directory.
 *
 * `~` (and `~\` on Windows) expands against the home directory, and a
 * surrounding pair of quotes is dropped because Explorer's "Copy as path" hands
 * you `"C:\dir"` — quotes included. Neither is cleverness for its own sake: both
 * are the difference between a path being accepted and the user being told
 * their perfectly good path is wrong.
 *
 * @param raw - the path as typed.
 * @returns the path with `~` expanded and quotes removed.
 */
export function expandPath(raw) {
  let value = String(raw ?? '').trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim()
  }
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Validate a caller-supplied source directory.
 *
 * The browser sends a path here, so this is the one place a client-supplied
 * filesystem location is accepted. It must resolve to an absolute path and must
 * not point inside the library — a source is by definition somewhere else.
 *
 * @param raw - candidate path.
 * @param libraryDir - the library root, to refuse self-import.
 * @returns the resolved absolute path.
 * @throws {SourceError} when the path is unusable.
 */
export function resolveSourcePath(raw, libraryDir) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new SourceError('a directory path is required')
  const value = expandPath(raw)
  if (!path.isAbsolute(value)) throw new SourceError('the path must be absolute — a leading ~ is expanded for you')
  const resolved = path.resolve(value)
  const library = path.resolve(libraryDir)
  if (resolved === library || resolved.startsWith(library + path.sep)) {
    throw new SourceError('the skill library cannot be used as an import source')
  }
  return resolved
}

/**
 * Test for an existing directory.
 * @param target - absolute path.
 * @returns whether a directory is there.
 */
export async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** Raised when a source operation cannot be carried out. */
export class SourceError extends Error {
  /** @param message - user-facing reason. */
  constructor(message) {
    super(message)
    this.name = 'SourceError'
  }
}

/**
 * Scan one source root for importable skills.
 *
 * Never throws for a missing root or an unreadable entry: a source that is not
 * there is an empty source, and one bad directory must not take the whole list
 * down. Invalid skills are reported instead of skipped silently, because "the
 * file exists but the catalog will not take it" is exactly what a user needs to
 * be told when an import appears to do nothing.
 *
 * @param root - absolute source directory.
 * @param options - caps, overridable so the bounded walk can be exercised.
 * @returns skills, the reasons some entries were rejected, and truncation flags.
 */
export async function scanSource(root, options = {}) {
  const skills = []
  const invalid = []
  const state = {
    visited: 0,
    truncated: false,
    maxDepth: options.maxDepth ?? MAX_DEPTH,
    maxEntries: options.maxEntries ?? MAX_ENTRIES,
    maxSkills: options.maxSkills ?? MAX_SKILLS,
  }

  await walk(root, 0, state, skills, invalid)
  skills.sort((left, right) => left.name.localeCompare(right.name))
  invalid.sort((left, right) => left.relative.localeCompare(right.relative))
  return { skills, invalid, truncated: state.truncated }
}

/**
 * Walk a directory, collecting skill bundles.
 * @param dir - directory to walk.
 * @param depth - current depth, root being 0.
 * @param state - shared counters and caps.
 * @param skills - collector for usable skills.
 * @param invalid - collector for rejected entries.
 */
async function walk(dir, depth, state, skills, invalid) {
  if (state.truncated || depth > state.maxDepth) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // A directory holding SKILL.md is itself a skill; its contents are not walked.
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md')) {
    await collect(path.join(dir, 'SKILL.md'), dir, state, skills, invalid)
    return
  }

  for (const entry of entries) {
    if (state.truncated) return
    if (entry.name.startsWith('.') && entry.name !== '.system') continue
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    state.visited += 1
    if (state.visited > state.maxEntries || skills.length >= state.maxSkills) {
      state.truncated = true
      return
    }
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), depth + 1, state, skills, invalid)
      continue
    }
    // Flat files count as skills only where the library would accept one.
    if (depth === 0 && entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      await collect(path.join(dir, entry.name), dir, state, skills, invalid)
    }
  }
}

/**
 * Read one candidate and record it.
 * @param file - path to the candidate skill file.
 * @param root - the source root, for relative paths.
 * @param state - shared counters.
 * @param skills - collector for usable skills.
 * @param invalid - collector for rejected entries.
 */
async function collect(file, root, state, skills, invalid) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const fallback = path.basename(file).toLowerCase() === 'skill.md' ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file))
  try {
    const skill = await readSkillFile(file, fallback)
    if (!SKILL_NAME.test(skill.name)) {
      invalid.push({ relative, reason: `invalid skill name ${JSON.stringify(skill.name)}` })
      return
    }
    skills.push({ name: skill.name, description: skill.description, file, directory: skill.directory, relative })
  } catch (error) {
    if (error instanceof InvalidSkillError) {
      invalid.push({ relative, reason: error.message })
      return
    }
    invalid.push({ relative, reason: error?.message ?? 'unreadable' })
  }
}

/**
 * Describe every source: what it is, whether it is there, and what it holds.
 * @param configured - sources from the store, each `{ id, label, path }`.
 * @param defaults - built-in sources, each `{ label, path }`.
 * @param libraryDir - root of the library, used to mark what is already imported.
 * @param importedNames - names already present in the library.
 * @returns one descriptor per source, built-ins first.
 */
export async function describeSources(configured, defaults, libraryDir, importedNames) {
  const seen = new Set()
  const list = []
  for (const entry of [...defaults, ...configured]) {
    const key = sourceKey(entry.path)
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ id: entry.id ?? sourceIdOf(entry.path), label: entry.label ?? path.basename(entry.path), path: path.resolve(entry.path), custom: entry.id !== undefined })
  }

  const described = []
  for (const source of list) {
    if (!(await isDirectory(source.path))) {
      described.push({ ...source, exists: false, skills: [], invalid: [], truncated: false })
      continue
    }
    const { skills, invalid, truncated } = await scanSource(source.path)
    described.push({
      ...source,
      exists: true,
      truncated,
      invalid,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        relative: skill.relative,
        imported: importedNames.has(skill.name),
      })),
    })
  }
  return described
}
