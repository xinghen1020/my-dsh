/**
 * Category tree — pure functions over a nested folder structure.
 *
 * A category is the user's own organisation of the skill library, modelled on
 * a favourites folder tree: nodes nest freely, every node has a stable id and a
 * display name, and deletion takes the whole subtree. Skills point at a node by
 * id (`null` meaning the fixed "uncategorized" container), so nothing here
 * knows about skills — it only shapes the tree those pointers resolve against.
 *
 * Everything in this module is pure: functions take a tree, return a new tree,
 * and never mutate their input. The trees are tiny, so cloning beats the
 * bookkeeping that in-place edits would need. Operations that cannot be carried
 * out throw {@link CategoryError} with a message that is safe to show a user.
 *
 * @module dsh-skill-center/categories
 */

import { randomUUID } from 'node:crypto'

/** Deepest nesting allowed, counting a top-level node as depth 1. */
export const MAX_DEPTH = 8

/** Longest accepted category name. */
export const MAX_NAME_LENGTH = 120

/** Raised when a category operation cannot be carried out. */
export class CategoryError extends Error {
  /** @param message - user-facing reason. */
  constructor(message) {
    super(message)
    this.name = 'CategoryError'
  }
}

/**
 * Create a fresh category id.
 * @returns a UUID.
 */
export function makeCategoryId() {
  return randomUUID()
}

/**
 * Validate and normalize a category name.
 * @param raw - candidate name.
 * @returns the trimmed name.
 * @throws {CategoryError} when the name is unusable.
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') throw new CategoryError('category name must be a string')
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name === '') throw new CategoryError('category name must not be empty')
  if (name.length > MAX_NAME_LENGTH) throw new CategoryError(`category name must be at most ${MAX_NAME_LENGTH} characters`)
  // Control characters would corrupt the tree document and the UI.
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new CategoryError('category name must not contain control characters')
  return name
}

/**
 * Read a tree back, repairing what can be repaired and dropping what cannot.
 *
 * This runs on every load, so a hand-edited or truncated `state.json` degrades
 * to a usable tree instead of taking the panel down: a node missing an id gets
 * a fresh one, a duplicate id gets a fresh one, a node without a usable name is
 * dropped, and nesting past {@link MAX_DEPTH} is flattened away.
 *
 * @param raw - value read from the state document.
 * @returns an array of well-formed top-level nodes.
 */
export function sanitizeTree(raw) {
  const seen = new Set()
  const walk = (value, depth) => {
    if (!Array.isArray(value) || depth > MAX_DEPTH) return []
    const nodes = []
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      let name
      try {
        name = normalizeName(entry.name)
      } catch {
        continue
      }
      let id = typeof entry.id === 'string' && entry.id !== '' && !seen.has(entry.id) ? entry.id : makeCategoryId()
      seen.add(id)
      nodes.push({ id, name, children: walk(entry.children, depth + 1) })
    }
    return nodes
  }
  return walk(raw, 1)
}

/**
 * Clone a tree so callers can mutate the copy freely.
 * @param tree - sanitized tree.
 * @returns a deep copy.
 */
function clone(tree) {
  return tree.map((node) => ({ id: node.id, name: node.name, children: clone(node.children) }))
}

/**
 * Find a node by id.
 * @param tree - tree to search.
 * @param id - category id.
 * @returns the node, or undefined.
 */
export function findCategory(tree, id) {
  for (const node of tree) {
    if (node.id === id) return node
    const found = findCategory(node.children, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Find the id of a node's parent.
 * @param tree - tree to search.
 * @param id - category id.
 * @returns the parent id, `null` for a top-level node, or undefined when absent.
 */
export function findParentId(tree, id) {
  const walk = (nodes, parentId) => {
    for (const node of nodes) {
      if (node.id === id) return parentId
      const found = walk(node.children, node.id)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(tree, null)
}

/**
 * Collect a node's id together with every descendant id.
 * @param node - subtree root.
 * @returns the ids, root first.
 */
export function collectIds(node) {
  const ids = [node.id]
  for (const child of node.children) ids.push(...collectIds(child))
  return ids
}

/**
 * Count the nodes in a tree.
 * @param tree - tree to measure.
 * @returns the node count.
 */
export function countCategories(tree) {
  let total = 0
  for (const node of tree) total += 1 + countCategories(node.children)
  return total
}

/**
 * Depth of a node, counting a top-level node as 1.
 * @param tree - tree to search.
 * @param id - category id.
 * @returns the depth, or 0 when absent.
 */
export function depthOf(tree, id) {
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (node.id === id) return depth
      const found = walk(node.children, depth + 1)
      if (found !== 0) return found
    }
    return 0
  }
  return walk(tree, 1)
}

/**
 * Create a category under an existing node or at the top level.
 * @param tree - current tree.
 * @param parentId - parent id, or null for the top level.
 * @param name - display name.
 * @param id - id to assign (injectable for deterministic tests).
 * @returns the new tree and the created id.
 * @throws {CategoryError} when the parent is unknown or nesting would be too deep.
 */
export function insertCategory(tree, parentId, name, id = makeCategoryId()) {
  const clean = normalizeName(name)
  const next = clone(tree)
  if (parentId === null || parentId === undefined) {
    next.push({ id, name: clean, children: [] })
    return { tree: next, id }
  }
  const parent = findCategory(next, parentId)
  if (parent === undefined) throw new CategoryError('the target category no longer exists')
  if (depthOf(next, parentId) >= MAX_DEPTH) throw new CategoryError(`categories can nest at most ${MAX_DEPTH} levels deep`)
  parent.children.push({ id, name: clean, children: [] })
  return { tree: next, id }
}

/**
 * Rename a category. Only the label changes; skills keep pointing at the id.
 * @param tree - current tree.
 * @param id - category id.
 * @param name - new display name.
 * @returns the new tree.
 * @throws {CategoryError} when the category is unknown.
 */
export function renameCategory(tree, id, name) {
  const clean = normalizeName(name)
  const next = clone(tree)
  const node = findCategory(next, id)
  if (node === undefined) throw new CategoryError('the category no longer exists')
  node.name = clean
  return next
}

/**
 * Remove a category and its whole subtree.
 * @param tree - current tree.
 * @param id - category id.
 * @returns the new tree and every id that was removed.
 * @throws {CategoryError} when the category is unknown.
 */
export function removeCategory(tree, id) {
  const node = findCategory(tree, id)
  if (node === undefined) throw new CategoryError('the category no longer exists')
  const removed = collectIds(node)
  const strip = (nodes) =>
    nodes.filter((entry) => entry.id !== id).map((entry) => ({ id: entry.id, name: entry.name, children: strip(entry.children) }))
  return { tree: strip(tree), removed }
}

/**
 * Move a category to a new parent and position.
 *
 * Refuses to move a node into its own subtree — the tree must stay acyclic, and
 * a cycle would make every later traversal non-terminating.
 *
 * @param tree - current tree.
 * @param id - category being moved.
 * @param parentId - new parent id, or null for the top level.
 * @param index - insertion position among the new siblings; appended when omitted.
 * @returns the new tree.
 * @throws {CategoryError} when the move is impossible.
 */
export function moveCategory(tree, id, parentId, index) {
  if (id === parentId) throw new CategoryError('a category cannot contain itself')
  // Measure before detaching: after the detach the node is no longer findable.
  const movingHeight = subtreeHeight(tree, id)
  const detached = removeCategory(tree, id)
  const next = detached.tree
  if (parentId !== null && parentId !== undefined) {
    if (detached.removed.includes(parentId)) throw new CategoryError('a category cannot be moved inside itself')
    const parent = findCategory(next, parentId)
    if (parent === undefined) throw new CategoryError('the target category no longer exists')
    if (depthOf(next, parentId) + movingHeight > MAX_DEPTH) {
      throw new CategoryError(`categories can nest at most ${MAX_DEPTH} levels deep`)
    }
  }
  const moved = findCategory(tree, id)
  const node = { id: moved.id, name: moved.name, children: clone(moved.children) }
  const siblings = parentId === null || parentId === undefined ? next : findCategory(next, parentId).children
  const at = typeof index === 'number' && Number.isInteger(index) ? Math.max(0, Math.min(index, siblings.length)) : siblings.length
  siblings.splice(at, 0, node)
  return next
}

/**
 * Height of a subtree, counting a leaf as 1.
 * @param tree - tree containing the node.
 * @param id - node id.
 * @returns the height, or 0 when absent.
 */
function subtreeHeight(tree, id) {
  const node = findCategory(tree, id)
  if (node === undefined) return 0
  let height = 1
  for (const child of node.children) height = Math.max(height, 1 + subtreeHeight([child], child.id))
  return height
}

/**
 * Flatten a tree into render order.
 * @param tree - tree to flatten.
 * @param depth - starting depth (top level is 1).
 * @returns one entry per node with its depth.
 */
export function flattenCategories(tree, depth = 1) {
  const rows = []
  for (const node of tree) {
    rows.push({ id: node.id, name: node.name, depth, hasChildren: node.children.length > 0 })
    rows.push(...flattenCategories(node.children, depth + 1))
  }
  return rows
}

/**
 * Build the display path of a category, root first.
 * @param tree - tree to search.
 * @param id - category id.
 * @returns the ancestor names including this node, or an empty array.
 */
export function categoryPath(tree, id) {
  const walk = (nodes, trail) => {
    for (const node of nodes) {
      const next = [...trail, node.name]
      if (node.id === id) return next
      const found = walk(node.children, next)
      if (found.length > 0) return found
    }
    return []
  }
  return walk(tree, [])
}
