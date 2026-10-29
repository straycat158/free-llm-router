/**
 * 自定义 API Key（子密钥）的单测。
 *
 * ## 为什么这些断言值得写
 *
 * 这个模块的每一处都是「静默失效」的高危区：
 * - IP/CIDR 匹配写错 → **要么误拒（密钥用不了），要么误放（白名单形同虚设）**，
 *   两种都不会报错；
 * - 配额判定的边界（`0` = 不限 vs `0` = 全禁）写反 → 密钥要么永远用不了、
 *   要么完全不限；
 * - 窗口重置没做 → 上一窗口用满之后密钥**永久失效**。
 *
 * 这些都是「看着对、行为不对」，只能靠断言锁住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  type ApiKeyRecord,
  checkQuota,
  defaultApiKeyLimits,
  emptyApiKeyUsage,
  generateApiKey,
  encryptApiKey,
  revealApiKey,
  hashApiKey,
  ipAllowed,
  ipMatchesRule,
  isIpLiteral,
  isWindowExpired,
  keyPrefix,
  modelAllowed,
  newApiKeyId,
  normalizeApiKeyLimits,
  normalizeApiKeyRecord,
  resetUsageWindow,
  toApiKeyView,
} from '../src/store/apikeys.ts'
import { encryptCredential } from '../src/store/crypto.ts'

// ─────────────────────── 密钥生成 ───────────────────────

test('生成的密钥格式为 sk-… 且长度固定', () => {
  const k = generateApiKey()
  assert.ok(k.startsWith('sk-'), '应以 sk- 开头')
  assert.equal(k.length, 3 + 40, 'sk- + 40 字符')
  assert.ok(/^sk-[A-Za-z0-9]{40}$/.test(k), '只含 base62 字符')
})

test('⚠️ 两次生成的密钥必须不同（CSPRNG，不是固定串）', () => {
  const set = new Set<string>()
  for (let i = 0; i < 200; i += 1) set.add(generateApiKey())
  assert.equal(set.size, 200, '200 次生成应全部唯一')
})

test('⚠️ 哈希稳定且不可逆（同一输入同哈希，不同输入不同哈希）', async () => {
  const a = await hashApiKey('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const b = await hashApiKey('sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const c = await hashApiKey('sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(a, b, '同输入必须同哈希（否则查不到密钥）')
  assert.notEqual(a, c, '不同输入必须不同哈希')
  assert.ok(!a.includes('sk-'), '⚠️ 哈希里不得残留明文片段')
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a), 'base64url 编码（无 +/= 等需要转义的字符）')
})

test('展示前缀可辨认但不等于明文', () => {
  const k = 'sk-ABCDEF1234567890abcdef1234567890abcdef12'
  const p = keyPrefix(k)
  assert.equal(p, 'sk-ABCDEF', '前缀 = sk- + 前 6 位')
  assert.ok(k.startsWith(p) && p !== k, '⚠️ 前缀必须是明文的一部分，但不能等于明文')
  assert.ok(p.length < 12, '⚠️ 前缀不能过长（否则爆破面变大）')
})

test('id 生成：8 字节 hex，唯一', () => {
  const set = new Set<string>()
  for (let i = 0; i < 200; i += 1) set.add(newApiKeyId())
  assert.equal(set.size, 200)
  assert.ok(/^[0-9a-f]{16}$/.test(newApiKeyId()))
})

// ─────────────────────── IP / CIDR ───────────────────────

test('IPv4 精确匹配', () => {
  assert.ok(ipMatchesRule('1.2.3.4', '1.2.3.4'))
  assert.ok(!ipMatchesRule('1.2.3.5', '1.2.3.4'))
  // ⚠️ 常见实现缺陷：字符串前缀匹配会把 1.2.3.40 当成命中 1.2.3.4
  assert.ok(!ipMatchesRule('1.2.3.40', '1.2.3.4'), '⚠️ 不得退化成字符串前缀匹配')
})

test('IPv4 CIDR 匹配', () => {
  assert.ok(ipMatchesRule('10.1.2.3', '10.0.0.0/8'))
  assert.ok(!ipMatchesRule('11.1.2.3', '10.0.0.0/8'))
  assert.ok(ipMatchesRule('192.168.1.5', '192.168.1.0/24'))
  assert.ok(!ipMatchesRule('192.168.2.5', '192.168.1.0/24'))
  // /32 = 精确匹配
  assert.ok(ipMatchesRule('1.2.3.4', '1.2.3.4/32'))
  assert.ok(!ipMatchesRule('1.2.3.5', '1.2.3.4/32'))
})

test('⚠️ /0 匹配一切（包括超出掩码位运算范围的边界）', () => {
  assert.ok(ipMatchesRule('1.2.3.4', '0.0.0.0/0'))
  assert.ok(ipMatchesRule('255.255.255.255', '0.0.0.0/0'))
})

test('⚠️ /32 不得被 JS 位移回绕（1<<32 === 1 的经典陷阱）', () => {
  // 若用 `(0xffffffff << (32-32))` = `(0xffffffff << 0)` 是对的，
  // 但 `(1 << 32) >>> 0` 会回绕成 1 —— 所以 /32 必须单独走全等分支。
  assert.ok(ipMatchesRule('8.8.8.8', '8.8.8.8/32'))
  assert.ok(!ipMatchesRule('8.8.8.9', '8.8.8.8/32'))
  assert.ok(!ipMatchesRule('8.8.8.8', '8.8.8.9/32'))
})

test('IPv6 精确与 CIDR 匹配', () => {
  assert.ok(ipMatchesRule('2001:db8::1', '2001:db8::1'))
  assert.ok(!ipMatchesRule('2001:db8::2', '2001:db8::1'))
  assert.ok(ipMatchesRule('2001:db8::1', '2001:db8::/32'))
  assert.ok(!ipMatchesRule('2001:db9::1', '2001:db8::/32'))
  assert.ok(ipMatchesRule('::1', '::1'))
})

test('⚠️ 协议族不得跨族匹配（IPv4 规则不匹配 IPv6 地址，反之亦然）', () => {
  // 这是 CIDR 实现最常见的缺陷来源
  assert.ok(!ipMatchesRule('2001:db8::1', '0.0.0.0/0'), 'IPv6 地址不该匹配 IPv4 的 /0')
  assert.ok(!ipMatchesRule('1.2.3.4', '::/0'), 'IPv4 地址不该匹配 IPv6 的 /0')
  assert.ok(!ipMatchesRule('1.2.3.4', '::1'))
})

test('⚠️ 非法 IP 写法必须被拒，不得宽松解析成合法值', () => {
  assert.ok(!isIpLiteral('1.2.3'), '缺一段')
  assert.ok(!isIpLiteral('1.2.3.4.5'), '多一段')
  assert.ok(!isIpLiteral('1.2.3.256'), '超范围')
  assert.ok(!isIpLiteral('1.2.3.'), '空段')
  assert.ok(!isIpLiteral('01.2.3.4'), '⚠️ 前导零应拒绝（Number("01") 会静默变成 1）')
  assert.ok(!isIpLiteral('a.b.c.d'))
  assert.ok(!isIpLiteral(''))
  // 合法值要能过（防止把断言写成「全部拒绝」）
  assert.ok(isIpLiteral('1.2.3.4'))
  assert.ok(isIpLiteral('2001:db8::1'))
})

test('允许列表：⚠️ 空列表 = 允许全部（不是全禁）', () => {
  assert.ok(ipAllowed('1.2.3.4', []), '⚠️ 空白名单必须是「不限」——否则新密钥一开始就用不了')
  assert.ok(ipAllowed('', []), '不限时空 IP 也应通过')
})

test('允许列表非空时：空 IP 必须被拒（fail-closed）', () => {
  // 拿不到来源 IP（异常代理）时不能默许 —— 那是白名单失效的方向
  assert.ok(!ipAllowed('', ['1.2.3.4']), '⚠️ 白名单非空时拿不到 IP 应拒绝')
  assert.ok(ipAllowed('1.2.3.4', ['1.2.3.4', '10.0.0.0/8']))
  assert.ok(!ipAllowed('9.9.9.9', ['1.2.3.4', '10.0.0.0/8']))
})

// ─────────────────────── 模型白名单 ───────────────────────

test('模型白名单：空 = 全部', () => {
  assert.ok(modelAllowed('buddy/glm-5.3-flash', []))
})

test('模型白名单支持完整 id 与裸名（裸名跨供应商生效）', () => {
  assert.ok(modelAllowed('buddy/glm-5.3-flash', ['buddy/glm-5.3-flash']), '完整 id 精确匹配')
  assert.ok(!modelAllowed('other/glm-5.3-flash', ['buddy/glm-5.3-flash']), '⚠️ 完整 id 不应跨供应商匹配')
  assert.ok(modelAllowed('other/glm-5.3-flash', ['glm-5.3-flash']), '⚠️ 裸名应跨供应商匹配')
  assert.ok(!modelAllowed('buddy/other-model', ['glm-5.3-flash']))
})

test('⚠️ 裸模型名（客户端常这么传）也能匹配裸名规则', () => {
  assert.ok(modelAllowed('glm-5.3-flash', ['glm-5.3-flash']))
  assert.ok(!modelAllowed('glm-5.3-flash', ['something-else']))
})

// ─────────────────── 限制规范化 ───────────────────

test('⚠️ normalizeApiKeyLimits：windowHours=0 必须保留（不是被默认值吃掉）', () => {
  // `0` 是合法值（= 累计不重置）。写成 `Number(x) || 24` 会把它静默换成 24 ——
  // 正是 AGENTS.md 记录的「parseInt(x) || 默认值」那类缺陷。
  const lim = normalizeApiKeyLimits({ windowHours: 0 })
  assert.equal(lim.windowHours, 0, '⚠️ 0 必须保留（= 不重置）')
})

test('normalizeApiKeyLimits：负数与非法值回落默认，不产生负上限', () => {
  // ⚠️ 负上限会让**所有**请求被判超限 —— 用户看到的只是「密钥坏了」
  const lim = normalizeApiKeyLimits({ maxRequests: -5, maxTokens: 'abc', windowHours: -1 })
  assert.equal(lim.maxRequests, 0, '负数应回落 0（= 不限）')
  assert.equal(lim.maxTokens, 0)
  assert.equal(lim.windowHours, 24, '非法值回落默认 24')
})

test('normalizeApiKeyLimits：非对象 / 缺字段都给安全默认', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const lim = normalizeApiKeyLimits(bad)
    assert.equal(lim.maxRequests, 0)
    assert.deepEqual(lim.models, [])
    assert.deepEqual(lim.allowedIps, [])
  }
  assert.deepEqual(normalizeApiKeyLimits({ models: ['a', '', '  ', 42, 'b'] }).models, ['a', 'b'])
})

test('⚠️ normalizeApiKeyRecord：缺 hash/id 的损坏记录必须被丢弃', () => {
  assert.equal(normalizeApiKeyRecord(null), undefined)
  assert.equal(normalizeApiKeyRecord({ name: 'x' }), undefined, '缺 id/hash')
  assert.equal(normalizeApiKeyRecord({ id: 'a' }), undefined, '缺 hash')
  // 正常记录能过
  const ok = normalizeApiKeyRecord({ id: 'a', hash: 'h', name: 'n', limits: {} })
  assert.ok(ok !== undefined)
  assert.equal(ok.enabled, true, '⚠️ 缺 enabled 时按启用（新建的密钥就该能用）')
  assert.equal(ok.limits.windowHours, 24, '缺 limits 时补默认')
})

test('⚠️ normalizeApiKeyRecord：显式 enabled:false 必须保留', () => {
  const rec = normalizeApiKeyRecord({ id: 'a', hash: 'h', enabled: false })
  assert.equal(rec.enabled, false)
})

// ─────────────────── 配额判定 ───────────────────

function rec(overrides = {}): ApiKeyRecord {
  return {
    id: 'id1', name: 'n', hash: 'h', prefix: 'sk-abc', createdAt: 0,
    lastUsedAt: 0, enabled: true, limits: defaultApiKeyLimits(), ...overrides,
  }
}

test('未设上限时一切放行', () => {
  const v = checkQuota(rec(), emptyApiKeyUsage(), '1.2.3.4', 'm', 1000)
  assert.equal(v.ok, true)
})

test('⚠️ 停用 / 过期必须被拒（且理由可区分）', () => {
  const d = checkQuota(rec({ enabled: false }), emptyApiKeyUsage(), '1.2.3.4', 'm', 1000)
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'disabled')

  const e = checkQuota(rec({ limits: { ...defaultApiKeyLimits(), expiresAt: 500 } }), emptyApiKeyUsage(), '1.2.3.4', 'm', 1000)
  assert.equal(e.ok, false)
  assert.equal(e.reason, 'expired')
})

test('⚠️ 过期边界：expiresAt 正好等于 now 时算过期', () => {
  const r = rec({ limits: { ...defaultApiKeyLimits(), expiresAt: 1000 } })
  assert.equal(checkQuota(r, emptyApiKeyUsage(), 'i', 'm', 999).ok, true, '未到点可用')
  assert.equal(checkQuota(r, emptyApiKeyUsage(), 'i', 'm', 1000).ok, false, '到点即过期（>=）')
})

test('IP 不在白名单 → 拒，理由为 ip', () => {
  const r = rec({ limits: { ...defaultApiKeyLimits(), allowedIps: ['10.0.0.0/8'] } })
  const v = checkQuota(r, emptyApiKeyUsage(), '9.9.9.9', 'm', 1000)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'ip')
})

test('模型不在白名单 → 拒，理由为 model', () => {
  const r = rec({ limits: { ...defaultApiKeyLimits(), models: ['glm-5.3-flash'] } })
  const v = checkQuota(r, emptyApiKeyUsage(), '1.2.3.4', 'other', 1000)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'model')
})

test('⚠️ 模型为空串时不适用模型白名单（/v1/models 没有 model 参数）', () => {
  // 否则用户「连模型列表都拉不到」，体验极差且难归因
  const r = rec({ limits: { ...defaultApiKeyLimits(), models: ['glm-5.3-flash'] } })
  assert.equal(checkQuota(r, emptyApiKeyUsage(), '1.2.3.4', '', 1000).ok, true)
})

test('请求数达上限 → 拒（>=，不是 >）', () => {
  const r = rec({ limits: { ...defaultApiKeyLimits(), maxRequests: 5 } })
  const u = { ...emptyApiKeyUsage(), requests: 5 }
  const v = checkQuota(r, u, 'i', 'm', 1000)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'requests')
  // 差一次仍可用
  assert.equal(checkQuota(r, { ...u, requests: 4 }, 'i', 'm', 1000).ok, true)
})

test('token 达上限 → 拒（输入 + 输出合计）', () => {
  const r = rec({ limits: { ...defaultApiKeyLimits(), maxTokens: 1000 } })
  const u = { ...emptyApiKeyUsage(), inputTokens: 600, outputTokens: 400 }
  const v = checkQuota(r, u, 'i', 'm', 1000)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'tokens')
  assert.equal(checkQuota(r, { ...u, outputTokens: 399 }, 'i', 'm', 1000).ok, true)
})

// ─────────────────── 窗口重置 ───────────────────

test('⚠️ windowHours=0（累计）永不因时间重置', () => {
  const lim = { ...defaultApiKeyLimits(), windowHours: 0 }
  const u = { ...emptyApiKeyUsage(), windowStart: 1, requests: 99 }
  // 即使过了十年也不重置
  assert.equal(isWindowExpired(u, lim, 1 + 10 * 365 * 24 * 3600 * 1000), false)
})

test('⚠️ 24 小时窗口：到点必须重置（否则密钥永久失效）', () => {
  const lim = { ...defaultApiKeyLimits(), windowHours: 24 }
  const start = 1_000_000
  const u = { ...emptyApiKeyUsage(), windowStart: start, requests: 100 }
  const day = 24 * 3600 * 1000
  assert.equal(isWindowExpired(u, lim, start + day - 1), false, '未到点不重置')
  assert.equal(isWindowExpired(u, lim, start + day), true, '⚠️ 到点必须重置')
  assert.equal(isWindowExpired(u, lim, start + day + 1), true)
})

test('⚠️ 从未统计过（windowStart=0）时：滚动窗口不重置，累计窗口重置', () => {
  const rolling = { ...defaultApiKeyLimits(), windowHours: 24 }
  assert.equal(isWindowExpired(emptyApiKeyUsage(), rolling, 1000), false, '首次不应算过期')
  const total = { ...defaultApiKeyLimits(), windowHours: 0 }
  assert.equal(isWindowExpired(emptyApiKeyUsage(), total, 1000), true, '累计模式下首次要建窗口')
})

test('resetUsageWindow 清零计数但保留诊断信息', () => {
  const u = {
    windowStart: 1, requests: 50, inputTokens: 10, outputTokens: 20,
    rejected: 3, lastAt: 999, lastIp: '1.2.3.4', lastModel: 'm',
  }
  const r = resetUsageWindow(u, 5000)
  assert.equal(r.requests, 0)
  assert.equal(r.inputTokens, 0)
  assert.equal(r.rejected, 0)
  assert.equal(r.windowStart, 5000, '新窗口起点必须是 now')
  // ⚠️ 诊断信息要留住：它是排查「上一窗口发生了什么」的唯一线索
  assert.equal(r.lastAt, 999)
  assert.equal(r.lastIp, '1.2.3.4')
  assert.equal(r.lastModel, 'm')
})

test('⚠️ 重置后配额立刻恢复可用（端到端语义）', () => {
  const lim = { ...defaultApiKeyLimits(), windowHours: 24, maxRequests: 5 }
  const r = rec({ limits: lim })
  const used = { ...emptyApiKeyUsage(), windowStart: 1000, requests: 5 }
  const now = 1000 + 24 * 3600 * 1000
  assert.equal(checkQuota(r, used, 'i', 'm', now).ok, false, '重置前是超限的')
  const fresh = resetUsageWindow(used, now)
  assert.equal(checkQuota(r, fresh, 'i', 'm', now).ok, true, '⚠️ 重置后必须可用')
})

// ─────────────────── 视图剥离 hash ───────────────────

test('🔴 toApiKeyView 绝不得带出 hash（否则列表接口会泄漏）', () => {
  const r = rec({ hash: 'SECRET-HASH-VALUE' })
  const v = toApiKeyView(r, emptyApiKeyUsage())
  const serialized = JSON.stringify(v)
  assert.ok(!serialized.includes('SECRET-HASH-VALUE'), '⚠️ 视图里不得出现 hash')
  assert.ok(!('hash' in v), '⚠️ 视图对象不得有 hash 字段')
  // 该有的要有
  assert.equal(v.id, r.id)
  assert.equal(v.prefix, r.prefix)
  assert.ok('usage' in v && 'limits' in v)
})

test('API Key 密文可再次解密，列表只提供查看能力标记', async () => {
  const key = generateApiKey()
  const encryptedKey = await encryptApiKey('测试加密密钥', key)
  const record = rec({ encryptedKey, hash: await hashApiKey(key) })
  assert.ok(!encryptedKey.includes(key), '持久化材料不得包含明文')
  assert.equal(await revealApiKey('测试加密密钥', record), key)
  const view = toApiKeyView(record, emptyApiKeyUsage())
  assert.equal(view.canReveal, true)
  assert.ok(!('encryptedKey' in view))
  assert.ok(!JSON.stringify(view).includes(encryptedKey))
  assert.ok(!JSON.stringify(view).includes(key))
  assert.equal(normalizeApiKeyRecord(record)?.encryptedKey, encryptedKey)
})

test('历史哈希密钥保持有效且明确标记无法恢复', async () => {
  const record = rec()
  assert.equal(await revealApiKey(undefined, record), undefined)
  assert.equal(toApiKeyView(record, emptyApiKeyUsage()).canReveal, false)
  assert.equal(checkQuota(record, emptyApiKeyUsage(), '', '', Date.now()).ok, true)
})

test('API Key 加密每次使用独立 IV，未配置 secret 时不降级保存', async () => {
  const key = generateApiKey()
  assert.notEqual(await encryptApiKey('测试密钥', key), await encryptApiKey('测试密钥', key))
  await assert.rejects(encryptApiKey(undefined, key), /CREDENTIAL_KEY/)
  await assert.rejects(encryptApiKey('  ', key), /CREDENTIAL_KEY/)
})

test('错误加密密钥、损坏密文、重置前材料与其它用途密文均拒绝回显', async () => {
  const key = generateApiKey()
  const encryptedKey = await encryptApiKey('正确密钥', key)
  const record = rec({ hash: await hashApiKey(key), encryptedKey })
  await assert.rejects(revealApiKey('错误密钥', record))
  await assert.rejects(revealApiKey('正确密钥', { ...record, encryptedKey: '损坏密文' }))
  await assert.rejects(revealApiKey('正确密钥', { ...record, hash: await hashApiKey(generateApiKey()) }), /不匹配/)
  const other = await encryptCredential('正确密钥', { purpose: 'credential', key })
  await assert.rejects(revealApiKey('正确密钥', { ...record, encryptedKey: other }), /不匹配/)
})
