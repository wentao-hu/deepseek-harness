/**
 * Reading packed npm tarballs and the order file that accompanies them.
 *
 * The release steps after pack treat a directory of tarballs as the unit of
 * work, so they read what a tarball declares rather than what the checkout
 * currently says.
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { capture } from './process.ts'

/** Name of the file recording the order in which a packed family uploads. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/** What a packed tarball calls itself. */
export interface PackedIdentity {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
}

/**
 * Invoke `tar` on a tarball without putting an absolute path in its argv.
 *
 * GNU tar parses a `host:path` remote spec, and on Windows a bare drive path
 * like `D:\...` matches it: the drive letter becomes a hostname and the run
 * fails with `Cannot connect to D: resolve failed`. Passing the file name and
 * giving the directory as the working directory keeps argv free of colons, so
 * the same call works on every platform and tar implementation.
 * @param tarball - absolute tarball path.
 * @param args - tar arguments that precede the tarball operand.
 * @param trailing - arguments that follow the tarball operand, such as member names.
 * @returns The tarball's captured standard output.
 */
export function captureTarball(
  tarball: string,
  args: readonly string[],
  trailing: readonly string[] = [],
): string {
  return capture('tar', [...args, basename(tarball), ...trailing], { cwd: dirname(tarball) })
}
/**
 * List a tarball's members.
 * @param tarball - absolute tarball path.
 * @returns Every path inside the archive.
 */
export function tarballFiles(tarball: string): string[] {
  return captureTarball(tarball, ['-tzf']).split(/\r?\n/u).filter(line => line !== '')
}

/**
 * Read a packed tarball's own manifest.
 * @param tarball - absolute tarball path.
 * @returns The name and version the tarball declares.
 */
export function packedIdentity(tarball: string): PackedIdentity {
  const manifest: unknown = JSON.parse(captureTarball(tarball, ['-xOzf'], ['package/package.json']))
  if (manifest === null || typeof manifest !== 'object') throw new Error(`${tarball} has no manifest`)
  const { name, version } = manifest as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${tarball} manifest lacks name/version`)
  return { name, version }
}

/**
 * Read a packed directory's upload order.
 * @param directory - absolute path of a pack output directory.
 * @returns Tarball filenames in upload order.
 */
export function readPublishOrder(directory: string): string[] {
  return readFileSync(join(directory, PUBLISH_ORDER_FILE), 'utf8').split('\n').filter(line => line !== '')
}
