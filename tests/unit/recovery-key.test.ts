import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  copyText,
  downloadText,
  generateRecoveryKey,
  isPlausibleRecoveryKey,
  normalizeRecoveryKey,
  readStoredRecoveryKey,
  recoveryHash,
  sha256Hex,
  storeRecoveryKey,
} from '../../src/lib/recovery-key'
import { KEYS } from '../../src/lib/storage'

const CANONICAL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 把熵源替换为给定字节，用于确定性地断言 Base32 编码。 */
function stubEntropyBytes(bytes: number[]): void {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
    array: Uint8Array,
  ): Uint8Array => {
    array.set(bytes.slice(0, array.length))
    return array
  }) as unknown as typeof globalThis.crypto.getRandomValues)
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('generateRecoveryKey', () => {
  it('20 随机字节 → 恰好 32 个 Base32 字符，字符集 A–Z2–7，无填充无分组', () => {
    for (let i = 0; i < 50; i += 1) {
      const key = generateRecoveryKey()
      expect(key).toHaveLength(32)
      expect(key).toMatch(/^[A-Z2-7]{32}$/)
      expect(key).not.toContain('=')
      expect(key).not.toContain('-')
      expect(key).not.toContain(' ')
    }
  })

  it('调用 crypto.getRandomValues 且请求 20 字节（不降级为 Math.random）', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    generateRecoveryKey()
    expect(spy).toHaveBeenCalledTimes(1)
    const request = spy.mock.calls[0][0] as Uint8Array
    expect(request).toBeInstanceOf(Uint8Array)
    expect(request).toHaveLength(20)
  })

  it('确定性地按 RFC 4648 编码（全 0 → 32 个 A）', () => {
    stubEntropyBytes(new Array<number>(20).fill(0))
    expect(generateRecoveryKey()).toBe('A'.repeat(32))
  })

  it('确定性地按 RFC 4648 编码（全 0xff → 32 个 7）', () => {
    stubEntropyBytes(new Array<number>(20).fill(0xff))
    expect(generateRecoveryKey()).toBe('7'.repeat(32))
  })

  it('已知 Base32 向量：输入 "foobar" + 14 个 0 字节', () => {
    const bytes = [...'foobar'].map((char) => char.charCodeAt(0))
    stubEntropyBytes([...bytes, ...new Array<number>(14).fill(0)])
    // 前 5 字节 "fooba" → MZXW6YTB（RFC 4648 向量前缀）；余下位补齐后全 0 → A。
    expect(generateRecoveryKey()).toBe('MZXW6YTBOIAAAAAAAAAAAAAAAAAAAAAA')
  })
})

describe('normalizeRecoveryKey / isPlausibleRecoveryKey', () => {
  it('大写、去空白与 -', () => {
    expect(normalizeRecoveryKey(`  ${CANONICAL.toLowerCase()}  `)).toBe(CANONICAL)
    expect(normalizeRecoveryKey('abcdefgh-ijklmnop\nqrstuvwx\tyz234567')).toBe(CANONICAL)
    expect(normalizeRecoveryKey(CANONICAL)).toBe(CANONICAL)
  })

  it('32 字符且字符集合法 → true（容忍小写/分组/空白）', () => {
    expect(isPlausibleRecoveryKey(CANONICAL)).toBe(true)
    expect(isPlausibleRecoveryKey('ABCDEFGH-IJKLMNOP-QRSTUVWX-YZ234567')).toBe(true)
    expect(isPlausibleRecoveryKey(`  ${CANONICAL.toLowerCase()} `)).toBe(true)
  })

  it('长度或字符集不合法 → false', () => {
    expect(isPlausibleRecoveryKey('')).toBe(false)
    expect(isPlausibleRecoveryKey(CANONICAL.slice(0, 31))).toBe(false)
    expect(isPlausibleRecoveryKey(`${CANONICAL}A`)).toBe(false)
    expect(isPlausibleRecoveryKey(`0189${CANONICAL.slice(4)}`)).toBe(false)
    expect(isPlausibleRecoveryKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ23456 ')).toBe(false)
  })
})

describe('sha256Hex / recoveryHash', () => {
  it('已知向量：空字符串与 "abc"，小写 hex 64 字符', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Hex('恢复密钥')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('确定性：同输入多次调用结果一致，且与 normalizeRecoveryKey 后的哈希一致', async () => {
    const first = await recoveryHash(CANONICAL)
    const second = await recoveryHash(CANONICAL)
    const fromLowercase = await recoveryHash(` ${CANONICAL.toLowerCase()} `)
    const fromJoined = await recoveryHash('ABCDEFGH-IJKLMNOP-QRSTUVWX-YZ234567')
    expect(first).toBe(second)
    expect(fromLowercase).toBe(first)
    expect(fromJoined).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toHaveLength(64)
    expect(first).not.toBe(CANONICAL)
  })

  it('大小写/分组差异得到同一哈希（服务端只存哈希）', async () => {
    const spaced = await recoveryHash('ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567')
    expect(spaced).toBe(await recoveryHash(CANONICAL))
  })
})

describe('storeRecoveryKey / readStoredRecoveryKey', () => {
  it('无副本时返回 null', () => {
    expect(readStoredRecoveryKey()).toBeNull()
  })

  it('存本设备 KEYS.recoveryKey，读回规范化值', () => {
    storeRecoveryKey(` ${CANONICAL.toLowerCase()} `)
    expect(window.localStorage.getItem(KEYS.recoveryKey)).toBe(CANONICAL)
    expect(readStoredRecoveryKey()).toBe(CANONICAL)
    storeRecoveryKey('ABCDEFGH-IJKLMNOP-QRSTUVWX-YZ234567')
    expect(readStoredRecoveryKey()).toBe(CANONICAL)
  })

  it('存储写入失败不抛错（静默降级）', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => storeRecoveryKey(CANONICAL)).not.toThrow()
    spy.mockRestore()
  })
})

describe('copyText', () => {
  it('Clipboard API 可用时直接复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    await expect(copyText(CANONICAL)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith(CANONICAL)
  })

  it('Clipboard API 失败时降级 execCommand，并清理临时 textarea', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })

    await expect(copyText(CANONICAL)).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('两路都不可用 → 返回 false', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true })
    await expect(copyText(CANONICAL)).resolves.toBe(false)
  })
})

describe('downloadText', () => {
  it('Blob + a[download] 触发下载，随后 revokeObjectURL 并移除 a', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recovery-key')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadText('bimail-recovery-key.txt', CANONICAL)

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/plain;charset=utf-8')
    await expect(blob.text()).resolves.toBe(CANONICAL)
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('bimail-recovery-key.txt')
    expect(anchor.href).toContain('blob:recovery-key')
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-key'))
    expect(document.querySelector('a[download]')).toBeNull()
  })
})
