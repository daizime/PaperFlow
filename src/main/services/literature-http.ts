import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as requestHttp, type IncomingMessage } from 'node:http'
import { request as requestHttps } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

export type PublicAddressResolver = (hostname: string) => Promise<LookupAddress[]>

const DENIED_ADDRESS = '拒绝访问本机、内网或保留地址。'

// 将 IANA 非公网地址、广播和组播排除在学术请求之外。
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
] as const) {
  blocked.addSubnet(address, prefix, 'ipv6')
}

// 只使用当前的 IPv6 全球单播范围，排除映射、链路本地和转换地址。
const globalUnicastV6 = new BlockList()
globalUnicastV6.addSubnet('2000::', 3, 'ipv6')
const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

const resolveAddresses: PublicAddressResolver = hostname => lookup(hostname, { all: true })

function unbracket(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '')
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  return family === 6 && !address.includes('%') &&
    globalUnicastV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

function isConfiguredLoopback(url: URL, allowInsecureTestBase?: string): boolean {
  if (!allowInsecureTestBase || !['http:', 'https:'].includes(url.protocol)) return false
  const address = unbracket(url.hostname)
  const version = isIP(address)
  if (version === 0 || !loopback.check(address, version === 4 ? 'ipv4' : 'ipv6')) return false
  try {
    const testBase = new URL(allowInsecureTestBase)
    return url.origin === testBase.origin && !testBase.username && !testBase.password
  } catch {
    return false
  }
}

/** 校验 URL 结构和字面地址。域名另由调用方在 DNS 或实际连接时复核。 */
export function validateExternalHttpsUrl(rawUrl: string, allowInsecureTestBase?: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('外部链接格式无效。')
  }
  if (url.username || url.password) throw new Error('外部链接不允许携带内嵌凭据。')
  if (isConfiguredLoopback(url, allowInsecureTestBase)) return url
  if (url.protocol !== 'https:') throw new Error('仅支持访问 HTTPS 安全学术链接。')

  const host = unbracket(url.hostname).replace(/\.$/, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw new Error(DENIED_ADDRESS)
  }
  return url
}

async function getPublicAddresses(hostname: string, resolve: PublicAddressResolver): Promise<LookupAddress[]> {
  let addresses: LookupAddress[]
  try {
    addresses = await resolve(hostname)
  } catch {
    // 系统解析错误（如 ENOTFOUND / EAI_AGAIN）是英文原始文本，统一换成可读提示。
    throw new Error(`未能解析学术链接域名「${hostname}」，请检查网络连接后重试。`)
  }
  if (addresses.length === 0) throw new Error('未能解析学术链接域名。')
  if (addresses.some(({ address, family }) => family !== isIP(address) || !isPublicAddress(address))) {
    throw new Error(DENIED_ADDRESS)
  }
  return addresses
}

/** 操作系统连接直接使用返回的同批已核验地址，不再独立解析域名。 */
export function createPublicLookup(resolve: PublicAddressResolver = resolveAddresses): LookupFunction {
  return (hostname, options, callback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    void getPublicAddresses(hostname, resolve).then(addresses => {
      const eligible = family ? addresses.filter(address => address.family === family) : addresses
      if (eligible.length === 0) {
        callback(new Error('未找到匹配协议族的公网地址。'), '')
      } else if (options.all) {
        callback(null, eligible)
      } else {
        callback(null, eligible[0].address, eligible[0].family)
      }
    }, error => {
      callback(error instanceof Error ? error : new Error('未能解析学术链接域名。'), '')
    })
  }
}

/** 仅检查交给系统浏览器的首个地址。浏览器自己的解析与重定向不由应用代理。 */
export async function validateExternalBrowserUrl(
  rawUrl: string,
  resolve: PublicAddressResolver = resolveAddresses
): Promise<URL> {
  const url = validateExternalHttpsUrl(rawUrl)
  if (isIP(unbracket(url.hostname)) !== 0) return url
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('解析学术链接域名超时。')), 5000)
  })
  try {
    await Promise.race([getPublicAddresses(url.hostname, resolve), timeout])
    return url
  } finally {
    clearTimeout(timer)
  }
}

function createResponse(message: IncomingMessage): Response {
  const status = message.statusCode
  if (status === undefined || status < 200 || status > 599) throw new Error('远端返回了无效的 HTTP 状态。')
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (value) for (const entry of value) headers.append(name, entry)
  }
  if ([204, 205, 304].includes(status)) {
    message.resume()
    return new Response(null, { status, headers })
  }

  let stream: Readable = message
  const encoding = headers.get('content-encoding')?.trim().toLowerCase()
  if (encoding && encoding !== 'identity') {
    const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
      : encoding === 'br' ? createBrotliDecompress()
        : encoding === 'deflate' ? createInflate()
          : null
    if (!decoder) throw new Error('远端使用了不受支持的响应压缩格式。')
    message.on('error', error => decoder.destroy(error))
    decoder.once('close', () => { if (!message.readableEnded) message.destroy() })
    stream = message.pipe(decoder)
    headers.delete('content-encoding')
    headers.delete('content-length')
  }

  const body = Readable.toWeb(stream, { type: 'bytes' }) as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

export async function requestLiteratureResponse(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  allowInsecureTestBase?: string
): Promise<Response> {
  const destination = validateExternalHttpsUrl(url.toString(), allowInsecureTestBase)
  const request = destination.protocol === 'http:' ? requestHttp : requestHttps
  return new Promise((resolve, reject) => {
    // 使用原 URL 保留 Host 和 TLS 域名校验。禁用池化，确保每次连接核验 DNS。
    const req = request(destination, {
      agent: false,
      ...(destination.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
      headers: { 'Accept-Encoding': 'identity', ...headers },
      signal,
      lookup: createPublicLookup()
    }, message => {
      try {
        resolve(createResponse(message))
      } catch (error) {
        message.destroy()
        reject(error)
      }
    })
    req.once('error', reject)
    req.end()
  })
}
