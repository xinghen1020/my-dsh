/**
 * The skill library's own state: enablement and category placement.
 *
 * Neither fact is written into skill files. The library root is disjoint from
 * every native skill root and skill-center is the only owner of what lives
 * there, so "off", "in this folder", and "folder named that" all belong to this
 * document. It is treated as shared with future versions of this plugin —
 * unknown top-level keys and unknown per-skill keys survive a round trip — and
 * writes are atomic and serialized.
 *
 * Both facts are also *independent*: enablement is the model/user visibility
 * gate, categories are pure organisation. Nothing here ever derives one from
 * the other.
 *
 * @module dsh-skill-center/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CategoryError,
  findCategory,
  insertCategory,
  makeCategoryId,
  moveCategory,
  removeCategory,
  renameCategory,
  sanitizeTree,
} from './categories.js'
import { sourceKey } from './sources.js'

/** State document version written by this plugin. */
export const STATE_VERSION = 3

/** State document written when nothing exists yet. */
export const DEFAULT_STATE = Object.freeze({ version: STATE_VERSION, categories: [], skills: {}, sources: [] })

/**
 * Read and write `<dshHome>/skill-center/state.json`.
 */
export class SkillStateStore {
  /** @type {string} */
  #file
  /** @type {{ warn?: (message: string) => void } | undefined} */
  #logger
  /** @type {Record<string, unknown> | undefined} */
  #state
  /** Tail of the write chain; never rejects, so one failure cannot wedge later writes. */
  #writes = Promise.resolve()

  /**
   * @param file - absolute path to the state document.
   * @param logger - optional sink for recovery warnings.
   */
  constructor(file, logger) {
    this.#file = file
    this.#logger = logger
  }

  /** Absolute path of the state document. */
  get file() {
    return this.#file
  }

  /**
   * Current state, loaded once and then served from memory.
   * @returns the state document.
   */
  async read() {
    if (this.#state === undefined) this.#state = await this.#load()
    return this.#state
  }

  /**
   * The category a skill is filed under.
   * @param name - skill name.
   * @returns the category id, or null for the uncategorized container.
   */
  async categoryOf(name) {
    return categoryOf(await this.read(), name)
  }

  /**
   * The category tree.
   * @returns an array of top-level nodes.
   */
  async categories() {
    return (await this.read()).categories
  }

  // ---------------------------------------------------------------- skills

  /**
   * Record enablement for one or more skills.
   * @param names - skill names, or a single name.
   * @param enabled - whether they are available to the model and the user.
   * @returns the updated state document.
   */
  async setEnabled(names, enabled) {
    const state = await this.read()
    for (const name of asNames(names)) {
      state.skills[name] = { ...(state.skills[name] ?? {}), enabled }
    }
    await this.#save()
    return state
  }

  /**
   * File one or more skills under a category.
   * @param names - skill names, or a single name.
   * @param categoryId - target category id, or null for uncategorized.
   * @returns the updated state document.
   * @throws {CategoryError} when the target category does not exist.
   */
  async setCategory(names, categoryId) {
    const state = await this.read()
    if (categoryId !== null && categoryId !== undefined) {
      if (findCategory(state.categories, categoryId) === undefined) throw new CategoryError('the target category no longer exists')
    }
    for (const name of asNames(names)) {
      const record = { ...(state.skills[name] ?? {}) }
      if (categoryId === null || categoryId === undefined) delete record.categoryId
      else record.categoryId = categoryId
      state.skills[name] = record
    }
    await this.#save()
    return state
  }

  /**
   * Drop every record for skills that no longer exist on disk.
   * @param names - skill names to forget, or a single name.
   * @returns the updated state document.
   */
  async forget(names) {
    const state = await this.read()
    for (const name of asNames(names)) delete state.skills[name]
    await this.#save()
    return state
  }

  // ------------------------------------------------------------ categories

  /**
   * Create a category.
   * @param parentId - parent id, or null for the top level.
   * @param name - display name.
   * @returns the created id and the updated state.
   */
  async createCategory(parentId, name) {
    const state = await this.read()
    const created = insertCategory(state.categories, parentId ?? null, name)
    state.categories = created.tree
    await this.#save()
    return { id: created.id, state }
  }

  /**
   * Rename a category. Skills keep pointing at the same id.
   * @param id - category id.
   * @param name - new display name.
   * @returns the updated state document.
   */
  async renameCategory(id, name) {
    const state = await this.read()
    state.categories = renameCategory(state.categories, id, name)
    await this.#save()
    return state
  }

  /**
   * Delete a category and its subtree. Skills filed anywhere in the subtree
   * fall back to the uncategorized container rather than disappearing.
   * @param id - category id.
   * @returns the removed ids and the updated state.
   */
  async deleteCategory(id) {
    const state = await this.read()
    const removed = removeCategory(state.categories, id)
    state.categories = removed.tree
    const removedSet = new Set(removed.removed)
    for (const [name, record] of Object.entries(state.skills)) {
      if (typeof record?.categoryId === 'string' && removedSet.has(record.categoryId)) {
        state.skills[name] = { ...record }
        delete state.skills[name].categoryId
      }
    }
    await this.#save()
    return { removed: removed.removed, state }
  }

  /**
   * Move a category to a new parent and position.
   * @param id - category id.
   * @param parentId - new parent id, or null for the top level.
   * @param index - position among the new siblings.
   * @returns the updated state document.
   */
  async moveCategory(id, parentId, index) {
    const state = await this.read()
    state.categories = moveCategory(state.categories, id, parentId ?? null, index)
    await this.#save()
    return state
  }

  // --------------------------------------------------------------- sources

  /**
   * The user's own import sources, beyond the built-in ones.
   * @returns source descriptors.
   */
  async sources() {
    return (await this.read()).sources
  }

  /**
   * Remember an import source.
   * @param sourcePath - absolute directory path.
   * @param label - display name.
   * @returns the created id and the updated state.
   */
  async addSource(sourcePath, label) {
    const state = await this.read()
    const key = sourceKey(sourcePath)
    const existing = state.sources.find((entry) => sourceKey(entry.path) === key)
    if (existing !== undefined) return { id: existing.id, state, added: false }
    const id = makeCategoryId()
    state.sources = [...state.sources, { id, label, path: path.resolve(sourcePath) }]
    await this.#save()
    return { id, state, added: true }
  }

  /**
   * Forget an import source. The directory itself is never touched.
   * @param id - source id.
   * @returns the updated state document.
   * @throws {CategoryError} when the source is unknown.
   */
  async removeSource(id) {
    const state = await this.read()
    const next = state.sources.filter((entry) => entry.id !== id)
    if (next.length === state.sources.length) throw new CategoryError('the source no longer exists')
    state.sources = next
    await this.#save()
    return state
  }

  /**
   * Load the document, recovering from a missing or unreadable file.
   * @returns the state document.
   */
  async #load() {
    let text
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(DEFAULT_STATE)
      throw error
    }

    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('state root must be an object')
      }
      const categories = sanitizeTree(parsed.categories)
      return {
        // Spread first: keys added by a later version of this plugin survive.
        ...parsed,
        version: STATE_VERSION,
        categories,
        skills: normalizeSkills(parsed.skills, categories),
        sources: normalizeSources(parsed.sources),
      }
    } catch (error) {
      // Never discard operator data silently: keep the bytes, start clean.
      const backup = `${this.#file}.corrupt-${Date.now()}`
      await rename(this.#file, backup).catch(() => {})
      this.#logger?.warn?.(
        `state file at ${this.#file} is unreadable (${error.message}); kept it as ${backup} and started from defaults`,
      )
      return structuredClone(DEFAULT_STATE)
    }
  }

  /**
   * Write the document atomically, after any write already in flight.
   * @returns a promise that rejects only for this write's own failure.
   */
  #save() {
    const run = this.#writes.then(async () => {
      const body = `${JSON.stringify(this.#state, null, 2)}\n`
      const temporary = `${this.#file}.tmp-${process.pid}`
      await mkdir(path.dirname(this.#file), { recursive: true })
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, this.#file)
    })
    this.#writes = run.catch(() => {})
    return run
  }
}

/**
 * Coerce the sources list: keep well-formed entries, give missing ids a fresh
 * one, and drop duplicates so one directory is never listed twice.
 * @param raw - value read from the document.
 * @returns the normalized sources.
 */
function normalizeSources(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const sources = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.path !== 'string' || entry.path.trim() === '') continue
    const resolved = path.resolve(entry.path)
    const key = sourceKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : path.basename(resolved)
    sources.push({ id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : makeCategoryId(), label, path: resolved })
  }
  return sources
}

/**
 * Coerce a skill-name argument into a list.
 *
 * Accepting a bare string is not just convenience: without it, a forgotten
 * `[name]` would silently iterate the name's characters and write one record
 * per letter, which is a data-corrupting mistake that no type check catches in
 * plain JavaScript.
 *
 * @param names - a name or an array of names.
 * @returns an array of names.
 */
function asNames(names) {
  if (typeof names === 'string') return [names]
  if (!Array.isArray(names)) throw new TypeError('expected a skill name or an array of skill names')
  return names
}

/**
 * Read one skill's enablement. Absent records mean enabled, so importing or
 * hand-copying a skill into the library makes it live without a second step.
 * @param state - state document.
 * @param name - skill name.
 * @returns whether the skill is enabled.
 */
export function isEnabled(state, name) {
  return state?.skills?.[name]?.enabled !== false
}

/**
 * Read one skill's category.
 * @param state - state document.
 * @param name - skill name.
 * @returns the category id, or null for uncategorized.
 */
export function categoryOf(state, name) {
  const value = state?.skills?.[name]?.categoryId
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Coerce the skills record: keep only well-formed entries and drop category
 * pointers that no longer resolve, so a stale id can never hide a skill from
 * the uncategorized container.
 * @param raw - value read from the document.
 * @param categories - sanitized category tree.
 * @returns the normalized skills record.
 */
function normalizeSkills(raw, categories) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const skills = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      skills[name] = {}
      continue
    }
    const record = { ...value }
    if (typeof record.categoryId === 'string' && findCategory(categories, record.categoryId) === undefined) {
      delete record.categoryId
    }
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') delete record.enabled
    skills[name] = record
  }
  return skills
}
