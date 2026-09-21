import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number): string {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    if (process.platform === 'win32') throw new Error('npm_execpath is required to run pnpm on Windows')
    return run('pnpm', args, cwd, timeout)
  }
  return /\.[cm]?js$/iu.test(entrypoint)
    ? run(process.execPath, [entrypoint, ...args], cwd, timeout)
    : run(entrypoint, args, cwd, timeout)
}

describe('published PDF.js licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps every bundled license in the packed PDF chunk', ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      // 二次开发：npm ≥11 的 `pack --json` 返回数组（旧版本返回单个对象），两种都要认，
      // 否则在这台机器上会以 `packed.files` 为 undefined 失败。
      const packedOutput = JSON.parse(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] } | { filename: string; files: { path: string }[] }[]
      const packed = Array.isArray(packedOutput) ? packedOutput[0]! : packedOutput
      // 同上：npm ≥11 的 `filename` 只是文件名（旧版本是含目录的路径），tarball 落在 --pack-destination。
      const tarball = resolve(output, packed.filename)
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      const client = run('tar', ['-xOf', tarball, 'package/lib/client.js'], packageRoot, task.timeout)
      const pdf = run('tar', ['-xOf', tarball, 'package/lib/client.pdf.js'], packageRoot, task.timeout)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.pdf.js'])
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
