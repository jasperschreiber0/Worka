import test from 'node:test'
import assert from 'node:assert/strict'
import { withExecutionLease } from './execution-lease.ts'

test('concurrent dispatch starts one worker, then allows a later continuation', async () => {
  let owner: unknown = null
  let started = 0
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const client = { async rpc(name: string, args: Record<string, unknown>) {
    if (name === 'claim_estimation_execution') {
      if (owner) return { data: false, error: null }
      owner = args.p_token
      return { data: true, error: null }
    }
    if (owner === args.p_token) owner = null
    return { data: null, error: null }
  } }
  const work = async () => { started++; await pending }
  const first = withExecutionLease(client, 'job', 'file', 'builder', work)
  const second = await withExecutionLease(client, 'job', 'file', 'builder', work)
  assert.equal(second, false)
  assert.equal(started, 1)
  finish()
  assert.equal(await first, true)
  assert.equal(await withExecutionLease(client, 'job', 'file', 'builder', async () => { started++ }), true)
  assert.equal(started, 2)
})

test('claim failure is closed and worker exceptions release only their token', async () => {
  let called = false
  await assert.rejects(withExecutionLease({ rpc: async () => ({ data: null, error: 'offline' }) }, 'j', 'f', 'b', async () => { called = true }))
  assert.equal(called, false)
  const tokens: unknown[] = []
  await assert.rejects(withExecutionLease({ rpc: async (_name, args) => {
    tokens.push(args.p_token)
    return { data: true, error: null }
  } }, 'j', 'f', 'b', async () => { throw new Error('worker failed') }), /worker failed/)
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0], tokens[1])
})
