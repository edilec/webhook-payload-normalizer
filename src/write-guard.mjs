/**
 * webhook-payload-normalizer -- the output-destination guard.
 *
 * A tool that writes anything can destroy the wrong file. Measured across this
 * catalog rather than imagined: ten tools accepted a destination that overwrote
 * something they were never asked to touch, and four of them exited 0 saying
 * the write succeeded. This tool was one of them -- a symbolic link at `--out`
 * carried the bundle onto a file outside the job's directory, and the run
 * exited 0.
 *
 * Three holes, and each needs its own check because no one of them catches the
 * others. Guarding one or two is what every tool that lost data had already
 * done.
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help -- it
 *    resolves the link, and resolving is precisely the dangerous act. The link
 *    is refused on sight, by `lstat`, before anything is opened. A link whose
 *    target does not exist yet is refused by the same check, so a dangling link
 *    cannot quietly create a file outside the root either.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and compared against the real root rather than compared
 *    lexically. A lexical prefix check passes for `root/link/out` where `link`
 *    leaves the root.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    the input, so `realpath` and string comparison both say it is a different
 *    file. It is the same file. Only device plus inode sees that.
 *
 * `--out` is not a safe place to put a path the tool has not checked, and "the
 * caller named it" is not a check: the caller named a path, not the file the
 * path resolves to.
 *
 * A refused destination is a configuration error. The caller exits 2 with an
 * empty stdout, because a run that never had a usable destination has nothing
 * to report about one.
 */

import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading.
 *
 * `inputs` are the device/inode identities of the files this run read, already
 * collected as each one was opened; they are compared directly rather than
 * re-resolved, because a path is exactly what cannot answer the question.
 *
 * `root` is the directory the destination must stay inside -- the job file's
 * own directory. It is `null` only for a job handed over as an object with no
 * `baseDir`, where the run declared no directory to be confined to.
 *
 * @param {string} destination Path as the caller wrote it.
 * @param {object} [options]
 * @param {Array<{dev: number, ino: number, label: string}>} [options.inputs]
 * @param {string|null} [options.root] Real path of the permitted root.
 * @param {string} [options.label] Option name to name in a refusal.
 * @returns {Promise<string>} The absolute destination, safe to open.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--out' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the bundle wherever the link `
      + 'points, which is not the path you named, so it is refused. Name the real destination.',
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(`${label} names a directory that does not exist.`)
  }

  if (root !== null) {
    const base = await realpath(resolve(root))
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves to ${parent}, which is outside the job's directory. `
        + 'A link or a ".." segment on the way there does not widen it.',
      )
    }
  }

  if (existing === null) return target

  // Same file as an input? Compare identity, not paths.
  for (const input of inputs) {
    if (isSameFile(input, existing)) {
      throw new DestinationError(
        `${label} is the same file as ${input.label} -- they share device ${existing.dev} and `
        + `inode ${existing.ino}, so a hard link does not make them different files. `
        + 'This tool never rewrites what it reads.',
      )
    }
  }
  return target
}

/**
 * Whether two stat results name the same file.
 *
 * `realpath` resolves symlinks, but a **hard link** has no target: two names
 * for one inode both resolve to themselves, so a real-path comparison says they
 * are different files and a tool that trusted it would overwrite its own input.
 * Device plus inode is the identity that survives hard links, and it is the
 * comparison this tool refuses a destination on.
 */
export function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}
