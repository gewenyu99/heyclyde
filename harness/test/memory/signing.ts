/**
 * Test support for R31's signed client files: throwaway RSA-3072 keys and signatures made the way deploy.sh makes them
 * (`openssl dgst -sha256 -sign`, the one command LibreSSL and OpenSSL both have), and a self-signed certificate for
 * 127.0.0.1, since self-update refuses a server that isn't https. Nothing here touches Wen's real signing key.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../helpers.ts'

export type KeyPair = { priv: string; pub: string }

const OPENSSL = process.env.MEMORY_TEST_OPENSSL || 'openssl'
const openssl = (args: string[]) => execFileSync(OPENSSL, args, { stdio: ['ignore', 'pipe', 'pipe'] })

/** A fresh RSA-3072 key pair in its own temp dir: priv.pem and pub.pem. */
export function newKey(): KeyPair {
  const dir = tempDir('memory-sign-')
  const priv = join(dir, 'priv.pem')
  const pub = join(dir, 'pub.pem')
  openssl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', priv])
  openssl(['pkey', '-in', priv, '-pubout', '-out', pub])
  return { priv, pub }
}

let trusted: KeyPair | undefined
let other: KeyPair | undefined
let third: KeyPair | undefined
/** The key a test computer trusts. One per test process, since a 3072 bit key takes a moment. */
export const trustedKey = () => (trusted ??= newKey())
/** A key nobody trusts: a file signed with it must be refused. */
export const otherKey = () => (other ??= newKey())
/** A second key for rotation. */
export const nextKey = () => (third ??= newKey())

/** The base64 of the RSA-SHA256 signature of this text, one line, the way the server serves a .sig. */
export function sign(key: KeyPair, content: string): string {
  const dir = tempDir('memory-sig-')
  const file = join(dir, 'content')
  writeFileSync(file, content)
  openssl(['dgst', '-sha256', '-sign', key.priv, '-out', join(dir, 'sig'), file])
  return readFileSync(join(dir, 'sig')).toString('base64')
}

/** Whether the base64 signature verifies this text under the public key, by the command memory-hook runs. */
export function verifies(pub: string, content: string, signature: string): boolean {
  const dir = tempDir('memory-verify-')
  const file = join(dir, 'content')
  writeFileSync(file, content)
  writeFileSync(join(dir, 'sig'), Buffer.from(signature.trim(), 'base64'))
  try {
    openssl(['dgst', '-sha256', '-verify', pub, '-signature', join(dir, 'sig'), file])
    return true
  } catch {
    return false
  }
}

const CNF = `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = localhost
[v3]
subjectAltName = IP:127.0.0.1, DNS:localhost
basicConstraints = CA:FALSE
`

let cert: { key: string; cert: string; certPath: string } | undefined
/** A self-signed certificate for 127.0.0.1. Hand certPath to curl as CURL_CA_BUNDLE to trust it. */
export function localTls(): { key: string; cert: string; certPath: string } {
  if (cert) return cert
  const dir = tempDir('memory-tls-')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'openssl.cnf'), CNF)
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '3',
    '-config', join(dir, 'openssl.cnf'), '-extensions', 'v3'])
  cert = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), certPath: join(dir, 'cert.pem') }
  return cert
}
