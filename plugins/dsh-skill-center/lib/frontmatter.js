/**
 * Minimal frontmatter reader for skill bundles.
 *
 * A skill file is `---`-fenced YAML frontmatter followed by a Markdown body.
 * This module deliberately implements only the subset a skill header needs —
 * top-level scalar keys plus block scalars (`|` / `>`) — because the plugin is
 * installed by junction into a profile's `node_modules`, where a real YAML
 * dependency would have to resolve through the link target and cannot be
 * relied on. Nested maps and sequences are skipped rather than modelled;
 * nothing in the skill header contract reads them.
 *
 * @module dsh-skill-center/frontmatter
 */

const FENCE = /^---[ \t]*$/
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/
const BLOCK_HEAD = /^([|>])([+-]?)[ \t]*(?:#.*)?$/
const INDENTED = /^[ \t]/

/**
 * Split a skill file into its frontmatter map and Markdown body.
 * @param text - raw file contents (a UTF-8 BOM is tolerated).
 * @returns the parsed top-level keys, the body, and whether a fence was found.
 */
export function splitFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = source.split(/\r?\n/)
  if (lines.length === 0 || !FENCE.test(lines[0])) {
    return { data: new Map(), body: source, present: false }
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      end = i
      break
    }
  }
  if (end === -1) return { data: new Map(), body: source, present: false }
  return {
    data: parseTopLevel(lines.slice(1, end)),
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
    present: true,
  }
}

/**
 * Read one top-level key as a trimmed string.
 * @param data - frontmatter map from {@link splitFrontmatter}.
 * @param key - key to read.
 * @returns the string value, or undefined when absent or not scalar.
 */
export function readString(data, key) {
  if (!data.has(key)) return undefined
  const value = data.get(key)
  return typeof value === 'string' ? value.trim() : undefined
}

/**
 * Read one top-level key as a strict skill-invocation boolean.
 *
 * The accepted spellings are the ones `@deepseek-ai/dsh-skill-filesystem`
 * accepts (`true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`, case-insensitive).
 * Anything else is reported as invalid so the caller can reject the whole
 * skill, exactly as the native provider does — an unreadable flag must never
 * silently permit an interface the author meant to close.
 *
 * @param data - frontmatter map from {@link splitFrontmatter}.
 * @param key - key to read.
 * @returns `absent`, a parsed `set` value, or `invalid` with the raw text.
 */
export function readBoolean(data, key) {
  if (!data.has(key)) return { state: 'absent' }
  const raw = data.get(key)
  const value = parseBoolean(raw)
  if (value === undefined) return { state: 'invalid', raw: raw === null ? '' : String(raw) }
  return { state: 'set', value }
}

/**
 * Parse one textual boolean.
 * @param raw - raw scalar value.
 * @returns the boolean, or undefined when the spelling is not accepted.
 */
export function parseBoolean(raw) {
  const value = String(raw ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return undefined
}

/**
 * Parse top-level key/value pairs, folding block scalars.
 * @param lines - frontmatter lines between the fences.
 * @returns key to scalar text (or null for a nested/empty value).
 */
function parseTopLevel(lines) {
  const data = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // Indented content belongs to a parent this subset does not model.
    if (INDENTED.test(line)) continue
    const match = KEY_LINE.exec(line)
    if (match === null) continue
    const key = match[1]
    const rest = match[2]
    const block = BLOCK_HEAD.exec(rest)
    if (block !== null) {
      const chunk = []
      let next = i + 1
      for (; next < lines.length; next += 1) {
        const candidate = lines[next]
        if (candidate.trim() === '') {
          chunk.push('')
          continue
        }
        if (!INDENTED.test(candidate)) break
        chunk.push(candidate)
      }
      data.set(key, foldBlock(chunk, block[1] === '>'))
      i = next - 1
      continue
    }
    data.set(key, rest.trim() === '' ? null : parseScalar(rest))
  }
  return data
}

/**
 * Strip the common indent from a block scalar and join it.
 * @param lines - raw block lines.
 * @param folded - whether the scalar folds newlines into spaces (`>`).
 * @returns the scalar text.
 */
function foldBlock(lines, folded) {
  let indent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim() === '') continue
    indent = Math.min(indent, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(indent)) indent = 0
  const stripped = lines.map((line) => (line.trim() === '' ? '' : line.slice(indent)))
  while (stripped.length > 0 && stripped[stripped.length - 1] === '') stripped.pop()
  return folded ? stripped.join(' ').replace(/\s+/g, ' ').trim() : stripped.join('\n')
}

/**
 * Parse one inline scalar, honouring quotes and trailing comments.
 * @param raw - raw value text.
 * @returns the scalar as a string.
 */
function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return ''
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const close = closingQuote(value, quote)
    // Unquoted after all (`"` opening a value that never closes): fall through
    // and treat the text literally rather than swallowing the whole line.
    if (close > 0) return unescape(value.slice(1, close), quote)
  }
  const comment = value.search(/[ \t]#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}

/**
 * Find the quote that closes a quoted scalar, honouring escapes.
 * @param value - trimmed value text starting with the opening quote.
 * @param quote - the quote character (`'` or `"`).
 * @returns the index of the closing quote, or -1.
 */
function closingQuote(value, quote) {
  for (let i = 1; i < value.length; i += 1) {
    const char = value[i]
    if (quote === '"' && char === '\\') {
      i += 1
      continue
    }
    if (char !== quote) continue
    // In single-quoted YAML a doubled quote is an escaped quote, not the end.
    if (quote === "'" && value[i + 1] === "'") {
      i += 1
      continue
    }
    return i
  }
  return -1
}

/**
 * Resolve escape sequences inside a quoted scalar.
 * @param inner - text between the quotes.
 * @param quote - the quote character used.
 * @returns the scalar text.
 */
function unescape(inner, quote) {
  if (quote === "'") return inner.replace(/''/g, "'")
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}
