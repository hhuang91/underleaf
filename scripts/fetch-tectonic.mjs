// Downloads the Tectonic TeX engine that is bundled with packaged builds.
//
//   node scripts/fetch-tectonic.mjs                         (this machine)
//   node scripts/fetch-tectonic.mjs --platform darwin --arch x64,arm64
//   node scripts/fetch-tectonic.mjs --force                 (download again)
//
// Binaries come from the official GitHub release and are checked against the
// SHA-256 digests pinned below before anything is written to disk. They end
// up in resources/bin/<os>-<arch>/, where electron-builder and the dev build
// pick them up.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const VERSION = '0.17.0'
const BASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}`
const LICENSE_URL = `https://raw.githubusercontent.com/tectonic-typesetting/tectonic/tectonic%40${VERSION}/LICENSE`

/** Release assets by "<node platform>-<node arch>"; `dir` matches electron-builder's ${os}-${arch}. */
const ASSETS = {
  'win32-x64': {
    file: `tectonic-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
    exe: 'tectonic.exe',
    dir: 'win-x64'
  },
  'darwin-x64': {
    file: `tectonic-${VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80',
    exe: 'tectonic',
    dir: 'mac-x64'
  },
  'darwin-arm64': {
    file: `tectonic-${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667',
    exe: 'tectonic',
    dir: 'mac-arm64'
  },
  'linux-x64': {
    file: `tectonic-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7',
    exe: 'tectonic',
    dir: 'linux-x64'
  },
  'linux-arm64': {
    file: `tectonic-${VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8',
    exe: 'tectonic',
    dir: 'linux-arm64'
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Returns the contents of the regular file called `name` in a .tar archive. */
function fromTar(tar, name) {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0
    const data = tar.subarray(offset + 512, offset + 512 + size)
    // Type '0' (or NUL in old archives) is a regular file. Everything else is
    // skipped: directories, links, and pax/GNU extension records, whose names
    // can end in the same file name as the entry they describe.
    const type = header[156]
    if ((type === 48 || type === 0) && path.posix.basename(entry) === name) return Buffer.from(data)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

/** True when `binary` starts like an executable for the given Node platform name. */
function looksLikeExecutable(binary, platform) {
  if (binary.length < 1024 * 1024) return false
  const magic = binary.readUInt32BE(0)
  if (platform === 'win32') return binary[0] === 0x4d && binary[1] === 0x5a // "MZ"
  if (platform === 'darwin') {
    // Mach-O (64-bit, either byte order) or a universal binary
    return magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcafebabe
  }
  return magic === 0x7f454c46 // "\x7fELF"
}

/** Returns the contents of the entry called `name` in a .zip archive. */
function fromZip(zip, name) {
  const yauzl = createRequire(import.meta.url)('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      zipfile.on('entry', (entry) => {
        if (path.posix.basename(entry.fileName) !== name) return zipfile.readEntry()
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr)
          const chunks = []
          stream.on('data', (c) => chunks.push(c))
          stream.on('end', () => resolve(Buffer.concat(chunks)))
          stream.on('error', reject)
        })
      })
      zipfile.on('end', () => resolve(null))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

async function fetchOne(key, force) {
  const asset = ASSETS[key]
  if (!asset) throw new Error(`No Tectonic build is available for ${key}. Supported: ${Object.keys(ASSETS).join(', ')}`)
  const dir = path.join(root, 'resources', 'bin', asset.dir)
  const target = path.join(dir, asset.exe)
  const marker = path.join(dir, 'VERSION')

  if (!force) {
    const have = await fs.readFile(marker, 'utf8').catch(() => '')
    const exists = await fs.stat(target).then((s) => s.isFile(), () => false)
    if (exists && have.trim() === `${VERSION} ${asset.sha256}`) {
      console.log(`tectonic ${VERSION} for ${key} is already present`)
      return
    }
  }

  console.log(`Downloading ${asset.file} ...`)
  const archive = await download(`${BASE}/${asset.file}`)
  const digest = crypto.createHash('sha256').update(archive).digest('hex')
  if (digest !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.file}\n  expected ${asset.sha256}\n  received ${digest}`)
  }

  const binary = asset.file.endsWith('.zip')
    ? await fromZip(archive, asset.exe)
    : fromTar(zlib.gunzipSync(archive), asset.exe)
  if (!binary) throw new Error(`${asset.exe} was not found inside ${asset.file}`)
  if (!looksLikeExecutable(binary, key.split('-')[0])) {
    throw new Error(`${asset.exe} from ${asset.file} does not look like an executable (${binary.length} bytes)`)
  }

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(target, binary, { mode: 0o755 })
  await fs.chmod(target, 0o755).catch(() => undefined)
  await fs.writeFile(marker, `${VERSION} ${asset.sha256}\n`)
  // Ship the engine's licence text next to the binary.
  await download(LICENSE_URL)
    .then((text) => fs.writeFile(path.join(dir, 'LICENSE-tectonic.txt'), text))
    .catch((err) => console.warn(`Could not fetch the Tectonic licence text: ${err.message}`))
  console.log(`Wrote ${path.relative(root, target)} (${(binary.length / 1e6).toFixed(1)} MB, sha256 verified)`)
}

const platform = option('platform', process.platform)
const arches = option('arch', process.arch).split(',').map((a) => a.trim()).filter(Boolean)
const force = process.argv.includes('--force')

for (const arch of arches) await fetchOne(`${platform}-${arch}`, force)
