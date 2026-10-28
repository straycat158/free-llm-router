import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Env } from '../src/env.js'
import { handleChatCompletions } from '../src/gateway/server.js'
import { handleResponses } from '../src/gateway/responses.js'
import { prepareChatBody, sanitizeChatBody, sanitizeSystemMessages } from '../src/gateway/payload.js'
import { buddyConversationFromHeaders, cliChatHeaders, referenceChatHeaders, withBuddyRequestHeaders } from '../src/upstream/headers.js'

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
    getSession: async () => undefined,
    bindSession: async () => {},
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

test('出站脱敏不得改写工具调用 ID 和 reasoning_content 的原值', () => {
  const input = { messages: [
    { role: 'assistant', reasoning_content: '思考 11128\n原文', tool_calls: [{ id: 'call_11128', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_11128', content: '错误码 11128' },
    { role: 'user', content: '普通文本含 "id":"11128" 与 "reasoning_content":"11128"' },
  ] }
  const body = sanitizeChatBody(JSON.stringify(input))
  assert.ok(!body.includes('11128'))
  const parsed = JSON.parse(body)
  assert.deepEqual(parsed.messages[0], input.messages[0])
  assert.equal(parsed.messages[1].tool_call_id, 'call_11128')
  assert.equal(parsed.messages[1].content, '错误码 11-128')
  assert.equal(parsed.messages[2].content, '普通文本含 "id":"11-128" 与 "reasoning_content":"11-128"')
})

function toolStream(): Response {
  const frames = [
    { choices: [{ delta: { role: 'assistant', reasoning_content: '原始思考 11128\n' }, finish_reason: null }] },
    { choices: [{ delta: { content: '查询中', tool_calls: [
      { index: 0, id: 'call_11128_完整ID_A', type: 'function', function: { name: 'alpha', arguments: '{"a":' } },
      { index: 1, id: 'call_完整ID_B', type: 'function', function: { name: 'beta', arguments: '{"b":' } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: '2}' } },
      { index: 0, function: { arguments: '1}' } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]
  return new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

for (const provider of ['buddy', 'workbuddy']) {
  for (const stream of [false, true]) {
    test(`${provider} 的 Responses 完整双轮往返（stream=${stream}）与 Chat 出站消息一致`, async (t) => {
      const captured: Array<{ headers: Headers; body: any; signal: AbortSignal }> = []
      t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        captured.push({ headers: new Headers(init.headers), body: JSON.parse(init.body as string), signal: init.signal! })
        return captured.length === 1 ? toolStream() : successfulStream()
      })
      const logs: string[] = []
      t.mock.method(console, 'debug', (...args: unknown[]) => { logs.push(args.join(' ')) })
      const env = mockEnv(provider)
      const initial = [{ role: 'user', content: '查询两个工具' }]
      const first = await handleResponses(new Request('https://router.test/v1/responses', {
        method: 'POST', body: JSON.stringify({ model: `${provider}/fast-model`, instructions: '你是助手', input: initial, stream }),
      }), env)
      assert.equal(first.response.status, 200, await first.response.clone().text())
      const text = await first.response.text()
      const response = stream
        ? text.split('\n').filter((v) => v.startsWith('data: {')).map((v) => JSON.parse(v.slice(6))).find((v) => v.type === 'response.completed').response
        : JSON.parse(text)
      const calls = response.output.filter((v: any) => v.type === 'function_call')
      const ids = ['call_11128_完整ID_A', 'call_完整ID_B']
      assert.deepEqual(calls.map((v: any) => v.call_id), ids)
      assert.deepEqual(calls.map((v: any) => v.arguments), ['{"a":1}', '{"b":2}'])
      const context = new Headers({ 'X-Router-Debug': 'tool-pairing', 'Authorization': 'Bearer fake-client-secret' })
      for (const key of ['X-Conversation-ID', 'X-Conversation-Request-ID']) context.set(key, first.response.headers.get(key)!)
      const controller = new AbortController()
      const second = await handleResponses(new Request('https://router.test/v1/responses', {
        method: 'POST', headers: context, signal: controller.signal,
        body: JSON.stringify({ model: `${provider}/fast-model`, instructions: '你是助手', input: [
          ...initial, ...response.output,
          ...[...ids].reverse().map((call_id) => ({ type: 'function_call_output', call_id, output: '完成' })),
        ], stream }),
      }), env)
      assert.equal(second.response.status, 200, await second.response.clone().text())
      await second.response.text()
      assert.equal(captured.length, 2)
      const messages = captured[1].body.messages
      const expected = [
        { role: 'system', content: '你是助手' }, ...initial,
        { role: 'assistant', content: '查询中', reasoning_content: '原始思考 11128\n', tool_calls: [
          { id: ids[0], type: 'function', function: { name: 'alpha', arguments: '{"a":1}' } },
          { id: ids[1], type: 'function', function: { name: 'beta', arguments: '{"b":2}' } },
        ] },
        ...[...ids].reverse().map((tool_call_id) => ({ role: 'tool', tool_call_id, content: '完成' })),
      ]
      assert.deepEqual(messages, expected)
      for (const key of ['X-Conversation-ID', 'X-Conversation-Request-ID']) {
        assert.equal(captured[0].headers.get(key), captured[1].headers.get(key))
      }
      for (const key of ['X-Conversation-Message-ID', 'X-Root-Request-ID']) {
        assert.notEqual(captured[0].headers.get(key), captured[1].headers.get(key))
      }
      assert.equal(captured[1].headers.get('authorization'), 'Bearer fake-token')
      assert.equal(captured[1].headers.get('X-Router-Debug'), null)
      const logged = JSON.parse(logs[0].slice(logs[0].indexOf('{')))
      assert.deepEqual(logged.inputCalls, ids)
      assert.deepEqual(logged.chatCalls, ids)
      assert.deepEqual(logged.inputResults, [...ids].reverse())
      assert.deepEqual(logged.chatResults, [...ids].reverse())
      t.diagnostic(JSON.stringify({ 供应商: provider, 转换前: logged.inputCalls, 实际出站: messages[2].tool_calls.map((v: any) => v.id) }))

      const chat = await handleChatCompletions(new Request('https://router.test/v1/chat/completions', {
        method: 'POST', body: JSON.stringify({ model: `${provider}/fast-model`, messages: expected }),
      }), env)
      assert.equal(chat.response.status, 200)
      await chat.response.text()
      assert.deepEqual(captured[2].body.messages, messages)
      controller.abort()
      assert.equal(captured[1].signal.aborted, true, '内部 Request 必须保留原始取消信号')
    })
  }
}

test('Responses 损坏的工具配对在发出任何上游请求前返回 400', async (t) => {
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; return successfulStream() })
  const { response } = await handleResponses(new Request('https://router.test/v1/responses', {
    method: 'POST', body: JSON.stringify({ model: 'buddy/fast-model', input: [{ type: 'function_call_output', call_id: 'missing', output: '' }] }),
  }), mockEnv('buddy'))
  assert.equal(response.status, 400)
  assert.match(await response.text(), /没有前序调用/)
  assert.equal(fetched, false)
})

test('显式会话头原样保留；只指定会话 ID 时其它头独立生成', () => {
  const conversation = buddyConversationFromHeaders(new Headers({ 'X-Conversation-ID': 'client-conversation' }))
  const first = referenceChatHeaders({ uid: 'u', accessToken: '', conversation })
  const second = referenceChatHeaders({ uid: 'u', accessToken: '', conversation })
  assert.equal(first['X-Conversation-ID'], 'client-conversation')
  assert.equal(second['X-Conversation-ID'], 'client-conversation')
  for (const key of idNames.slice(1)) assert.notEqual(first[key], second[key])
})

for (const provider of ['buddy', 'workbuddy']) {
  test(`${provider} 的 Responses 显式会话作用域在换号重试时保持稳定`, async (t) => {
    const headers: Headers[] = []
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers))
      if (headers.length === 1) return Response.json({ code: 14017, msg: 'rate limited' }, { status: 429 })
      return successfulStream()
    })
    const { response } = await handleResponses(new Request('https://router.test/v1/responses', {
      method: 'POST', headers: { 'X-Conversation-ID': 'conversation-A', 'X-Conversation-Request-ID': 'loop-B' },
      body: JSON.stringify({ model: `${provider}/fast-model`, input: '你好' }),
    }), mockEnv(provider))
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
    assert.equal(headers.length, 2)
    for (const header of headers) {
      assert.equal(header.get('X-Conversation-ID'), 'conversation-A')
      assert.equal(header.get('X-Conversation-Request-ID'), 'loop-B')
    }
    for (const name of ['X-Conversation-Message-ID', 'X-Root-Request-ID']) {
      assert.notEqual(headers[0].get(name), headers[1].get(name))
    }
  })
}

test('独立 Responses 请求不靠相同提示词粘在一起，已有 user 粘性仍保留', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => successfulStream())
  const env = mockEnv('buddy')
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
  const sessionKeys: string[] = []
  t.mock.method(pool, 'getSession', async (key: string) => { sessionKeys.push(key); return undefined })
  const contexts: string[] = []
  for (const user of [undefined, undefined, 'explicit-user', 'explicit-user']) {
    const { response } = await handleResponses(new Request('https://router.test/v1/responses', {
      method: 'POST', body: JSON.stringify({ model: 'buddy/fast-model', input: '完全相同的提示词', user }),
    }), env)
    assert.equal(response.status, 200)
    contexts.push(response.headers.get('X-Conversation-ID')!)
    await response.text()
  }
  assert.notEqual(contexts[0], contexts[1])
  assert.notEqual(sessionKeys[0], sessionKeys[1])
  assert.match(sessionKeys[2], /^u:/)
  assert.equal(sessionKeys[2], sessionKeys[3])
})

test('其它供应商的 Responses 路径也不发送 WorkBuddy 会话头', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    for (const name of idNames) assert.equal(headers.get(name), null)
    return successfulStream()
  })
  const { response } = await handleResponses(new Request('https://router.test/v1/responses', {
    method: 'POST', body: JSON.stringify({ model: 'opencode/测试模型', input: '你好' }),
  }), mockEnv('opencode'))
  assert.equal(response.status, 200, await response.clone().text())
  await response.text()
})
