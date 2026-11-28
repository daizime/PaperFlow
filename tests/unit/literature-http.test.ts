import type { LookupAddress, LookupOptions } from 'node:dns'
import { describe, expect, it, vi } from 'vitest'
import {
  createPublicLookup,
  requestLiteratureResponse,
  validateExternalBrowserUrl,
  validateExternalHttpsUrl,
  type PublicAddressResolver
} from '../../src/main/services/literature-http'

const resolveDns = vi.hoisted(() => vi.fn<(hostname: string, options: { all: true }) => Promise<LookupAddress[]>>())
vi.mock('node:dns/promises', () => ({ lookup: resolveDns }))

const syntheticHost = 'academic.example.invalid'
const publicAddresses: LookupAddress[] = [
  { address: '8.8.8.8', family: 4 },
  { address: '2606:4700::1111', family: 6 }
]

function resolveForConnection(resolve: PublicAddressResolver, options: LookupOptions) {
  return new Promise<{ addresses: string | LookupAddress[]; family?: number }>((done, reject) => {
    createPublicLookup(resolve)(syntheticHost, options, (error, addresses, family) => {
      if (error) reject(error)
      else done({ addresses, family })
    })
  })
}

describe('学术链接的公网访问边界（合成 DNS）', () => {
  it.each([
    '127.0.0.1', '169.254.0.1', '100.64.0.1', '224.0.0.1',
    '[::]', '[::1]', '[::ffff:127.0.0.1]', '[fe90::1]', '[fd00::1]', '[2002::1]'
  ])('拒绝非公网地址 %s', address => {
    expect(() => validateExternalHttpsUrl('https://' + address + '/document.pdf')).toThrow(/拒绝访问/)
  })

  it('测试豁免只接受指定的本机 IP、协议和端口且仍拒绝凭据', () => {
    const base = 'http://127.0.0.1:4444'
    expect(validateExternalHttpsUrl(base + '/works', base).origin).toBe(base)
    expect(() => validateExternalHttpsUrl('http://127.0.0.1:4445/works', base)).toThrow(/HTTPS/)
    expect(() => validateExternalHttpsUrl('http://anon@127.0.0.1:4444/works', base)).toThrow(/凭据/)
    const domain = 'http://' + syntheticHost
    expect(() => validateExternalHttpsUrl(domain, domain)).toThrow(/HTTPS/)
    expect(() => validateExternalHttpsUrl('https://localhost./works')).toThrow(/拒绝访问/)
  })

  it('实际连接使用解析器提供的已核验结果并遵循协议族和 all 选项', async () => {
    const resolve = vi.fn<PublicAddressResolver>().mockResolvedValue(publicAddresses)
    await expect(resolveForConnection(resolve, { all: true })).resolves.toEqual({ addresses: publicAddresses })
    await expect(resolveForConnection(resolve, { family: 'IPv6' })).resolves.toEqual({
      addresses: publicAddresses[1].address, family: 6
    })
    expect(resolve.mock.calls).toEqual([[syntheticHost], [syntheticHost]])
  })

  it('即使请求只选 IPv6，也拒绝包含非公网 IPv4 的混合响应', async () => {
    const resolve = vi.fn<PublicAddressResolver>().mockResolvedValue([
      publicAddresses[1], { address: '10.0.0.8', family: 4 }
    ])
    await expect(resolveForConnection(resolve, { family: 6 })).rejects.toThrow(/拒绝访问/)
    await expect(validateExternalBrowserUrl('https://' + syntheticHost, resolve)).rejects.toThrow(/拒绝访问/)
  })

  it('无响应地址或地址族自相矛盾时终止', async () => {
    await expect(resolveForConnection(async () => [], { all: true })).rejects.toThrow(/未能解析/)
    await expect(resolveForConnection(async () => [{ address: '8.8.8.8', family: 6 }], { all: true }))
      .rejects.toThrow(/拒绝访问/)
  })

  it('DNS 查询本身失败时给出中文提示，不外泄系统原始错误文本', async () => {
    const resolve = vi.fn<PublicAddressResolver>().mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND ' + syntheticHost), { code: 'ENOTFOUND' })
    )
    const expected = '未能解析学术链接域名「' + syntheticHost + '」，请检查网络连接后重试。'
    await expect(resolveForConnection(resolve, { all: true })).rejects.toThrow(expected)
    await expect(validateExternalBrowserUrl('https://' + syntheticHost, resolve)).rejects.toThrow(expected)
  })

  it('真实 HTTPS 请求的 socket lookup 拒绝合成的内网解析结果，仅调用一次 DNS', async () => {
    resolveDns.mockClear().mockResolvedValue([{ address: '192.168.1.2', family: 4 }])
    await expect(requestLiteratureResponse(
      new URL('https://' + syntheticHost + '/document.pdf'), {}, AbortSignal.timeout(2000)
    )).rejects.toThrow(/拒绝访问/)
    expect(resolveDns).toHaveBeenCalledExactlyOnceWith(syntheticHost, { all: true })
  })
})
