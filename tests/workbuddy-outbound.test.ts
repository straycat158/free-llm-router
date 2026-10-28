import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Env } from '../src/env.js'
import { handleChatCompletions } from '../src/gateway/server.js'
import { handleResponses } from '../src/gateway/responses.js'
import { prepareChatBody, sanitizeSystemMessages } from '../src/gateway/payload.js'
import { cliChatHeaders, referenceChatHeaders, withBuddyRequestHeaders } from '../src/upstream/headers.js'

const idNames = [
  'X-Conversation-ID', 'X-Conversation-Request-ID',
  'X-Conversation-Message-ID', 'X-Root-Request-ID',
]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function collectIds(headers: Headers, seen: Set<string>): void {
  for (const name of idNames) {
    const value = headers.get(name) ?? ''
    assert.match(value, uuid, `${name} 必须是实时生成的 UUID`)
    assert.ok(!seen.has(value), `${name} 不得与当前请求或之前请求的 ID 重复`)
    seen.add(value)
  }
}

test('buddy/workbuddy 两套请求头在每次构造时生成四个独立 UUID', () => {
  const seen = new Set<string>()
  for (const variant of ['buddy', 'workbuddy'] as const) {
    for (let i = 0; i < 3; i++) {
      const input = { uid: 'u1', accessToken: 'token', variant }
      collectIds(new Headers(referenceChatHeaders(input)), seen)
      collectIds(new Headers(cliChatHeaders({
        ...input, machineId: 'machine', sessionId: 'session',
        conversationId: 'old-conversation', conversationRequestId: 'old-request',
      })), seen)
    }
  }
  assert.equal(seen.size, 48)
})

test('最终请求头的 UA 兜底兼容大小写，且清除重复 UA 和旧会话值', () => {
  for (const ua of [undefined, '', ' \t ', 'DeepSeek-Harness/1', 'deepseek_harness', 'DeepSeek Harness', 'deepseekharness']) {
    const input = {
      Authorization: 'Bearer token',
      'x-conversation-id': '旧会话',
      ...(ua === undefined ? {} : { 'uSeR-aGeNt': ua }),
    }
    const before = structuredClone(input)
    const output = withBuddyRequestHeaders(input)
    const headers = new Headers(output)
    assert.equal(headers.get('user-agent'), 'curl/8.0.1')
    assert.equal(headers.get('authorization'), 'Bearer token')
    collectIds(headers, new Set())
    assert.deepEqual(input, before, '不修改传入的请求头对象')
    assert.equal(Object.keys(output).filter((key) => key.toLowerCase() === 'user-agent').length, 1)
  }
  for (const ua of ['curl/8.0.1', 'node', 'axios', 'Go-http-client/1.1', '自定义客户端']) {
    assert.equal(withBuddyRequestHeaders({ 'user-agent': ua })['User-Agent'], ua)
  }
  assert.equal(withBuddyRequestHeaders({
    'User-Agent': 'node', 'user-agent': 'DEEPSEEK-HARNESS',
  })['User-Agent'], 'curl/8.0.1', '大小写重复头里的黑名单值也必须清掉')
})

test('仅替换 system 的字符串和文本块，保留其它消息、字段及入站对象', () => {
  const messages = [
    { role: 'system', name: '保留', content: 'DeepSeek Harness / deepseekHARNESS / DEEPSEEK\t\nHarness' },
    { role: 'system', content: [
      { type: 'text', text: '前缀 DeepSeek  Harness 后缀', extra: true },
      { type: 'image_url', image_url: { url: 'DeepSeek Harness' } },
      { type: '其它', text: 'DeepSeek Harness' }, null,
    ] },
    { role: 'user', content: 'DeepSeek Harness' },
    { role: 'assistant', content: [{ type: 'text', text: 'DeepSeek Harness' }] },
    { role: 'tool', content: 'DeepSeek Harness' },
    { role: 'system', content: null },
    { role: 'system', content: 123 }, null,
  ]
  const before = structuredClone(messages)
  const output = sanitizeSystemMessages(messages) as typeof messages
  assert.deepEqual(messages, before)
  assert.deepEqual(output[0], { role: 'system', name: '保留', content: 'DeepSeek\u200BHarness / DeepSeek\u200BHarness / DeepSeek\u200BHarness' })
  const blocks = output[1]!.content as Array<Record<string, unknown> | null>
  assert.deepEqual(blocks[0], { type: 'text', text: '前缀 DeepSeek\u200BHarness 后缀', extra: true })
  assert.deepEqual(blocks.slice(1), (messages[1]!.content as unknown[]).slice(1))
  assert.deepEqual(output.slice(2), messages.slice(2))
  assert.deepEqual(sanitizeSystemMessages(output), output, '重复准备不会叠加零宽空格')
})

test('developer 转换为 system 后再净化，工具描述及其它字段保持原文', () => {
  const input = {
    model: 'fast-model',
    messages: [{ role: 'developer', content: 'DeepSeek Harness' }, { role: 'user', content: 'DeepSeek Harness' }],
    tools: [{ type: 'function', function: { name: 'tool', description: 'DeepSeek Harness' } }],
    metadata: { label: 'DeepSeek Harness' },
  }
  const before = structuredClone(input)
  const output = JSON.parse(prepareChatBody(input).body)
  assert.deepEqual(output.messages, [
    { role: 'system', content: 'DeepSeek\u200BHarness' },
    { role: 'user', content: 'DeepSeek Harness' },
  ])
  assert.deepEqual(output.tools, input.tools)
  assert.deepEqual(output.metadata, input.metadata)
  assert.deepEqual(input, before)
})

/** 只模拟账号池状态；所有上游 fetch 均由各用例捕获，不使用真实凭据或额度。 */
function mockEnv(provider: string): Env {
  const accounts = [{ uid: 'u1', provider }, { uid: 'u2', provider }]
  const pool = {
    getProviderSettings: async () => ({ disabled: [] }),
    wafGateActive: async () => false,
    listAccounts: async () => accounts,
    pick: async ({ exclude }: { exclude: string[] }) => accounts.find((a) => !exclude.includes(a.uid)),
    getCredential: async (uid: string) => ({
      provider, uid, accessToken: 'fake-token', refreshToken: '', expiresAt: 0, extras: {},
    }),
    noteSuccess: async () => {},
    recordUsage: async () => {},
    applyFailure: async () => {},
  }
  return { ACCOUNT_POOL: { idFromName: (name: string) => name, get: () => pool } } as unknown as Env
}

function successfulStream(): Response {
  return new Response([
    'data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{
      index: 0, delta: { role: 'assistant', content: '成功' }, finish_reason: null,
    }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]', '',
  ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
}

for (const provider of ['buddy', 'workbuddy']) {
  for (const api of ['chat/completions', 'responses']) {
    for (const stream of [false, true]) {
      test(`${provider} 的 ${api}（stream=${stream}）实际出站内容经过修补`, async (t) => {
        let captured = false
        t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
          assert.ok(url.endsWith('/v2/chat/completions'))
          const headers = new Headers(init.headers)
          collectIds(headers, new Set())
          assert.ok(headers.get('user-agent')?.trim())
          assert.doesNotMatch(headers.get('user-agent')!, /deepseek[-_ ]?harness/i)
          const body = JSON.parse(init.body as string)
          assert.equal(body.messages[0].role, 'system')
          assert.equal(body.messages[0].content, 'DeepSeek\u200BHarness')
          assert.equal(body.messages[1].content, 'DeepSeek Harness')
          assert.equal(body.stream, true)
          assert.equal(body.model, 'fast-model')
          captured = true
          return successfulStream()
        })
        const body = api === 'responses'
          ? { model: `${provider}/fast-model`, instructions: 'DeepSeek Harness', input: 'DeepSeek Harness', stream }
          : { model: `${provider}/fast-model`, messages: [
              { role: 'system', content: 'DeepSeek Harness' }, { role: 'user', content: 'DeepSeek Harness' },
            ], stream }
        const request = new Request(`https://router.test/v1/${api}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': 'DeepSeek-Harness' },
          body: JSON.stringify(body),
        })
        const handler = api === 'responses' ? handleResponses : handleChatCompletions
        const { response } = await handler(request, mockEnv(provider))
        assert.equal(response.status, 200, await response.clone().text())
        assert.match(await response.text(), /成功/)
        assert.ok(captured, '必须确实发出上游请求')
      })
    }
  }
  test(`${provider} 换号重试时重新生成四个 ID`, async (t) => {
    const seen = new Set<string>()
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      collectIds(new Headers(init.headers), seen)
      if (++calls === 1) return Response.json({ code: 14017, msg: 'rate limited' }, { status: 429 })
      return successfulStream()
    })
    const { response } = await handleChatCompletions(new Request('https://router.test/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: `${provider}/fast-model`, messages: [{ role: 'user', content: '你好' }] }),
    }), mockEnv(provider))
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
    assert.equal(calls, 2)
    assert.equal(seen.size, 8)
  })
}

test('其它供应商的实际出站 system 内容及会话头不受影响', async (t) => {
  let captured = false
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    for (const name of idNames) assert.equal(headers.get(name), null)
    assert.equal(JSON.parse(init.body as string).messages[0].content, 'DeepSeek Harness')
    captured = true
    return successfulStream()
  })
  const { response } = await handleChatCompletions(new Request('https://router.test/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'opencode/测试模型', messages: [{ role: 'system', content: 'DeepSeek Harness' }] }),
  }), mockEnv('opencode'))
  assert.equal(response.status, 200, await response.clone().text())
  await response.text()
  assert.ok(captured)
})
