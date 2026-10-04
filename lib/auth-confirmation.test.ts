import test from 'node:test'
import assert from 'node:assert/strict'
import {finishConfirmation, confirmationFailure} from './auth-confirmation.ts'

test('confirmation opens Studio only after successful code exchange', async () => {
  let received = ''
  assert.equal(await finishConfirmation(new URLSearchParams({code:'test-code'}), async code => {
    received = code
    return {error:null}
  }), '/studio')
  assert.equal(received, 'test-code')
})

test('confirmation rejects expired codes, provider errors and unavailable auth', async () => {
  const params = new URLSearchParams({code:'expired'})
  assert.equal(await finishConfirmation(params, async () => ({error:new Error('Expired')})), confirmationFailure)
  assert.equal(await finishConfirmation(params, async () => {throw new Error('Offline')}), confirmationFailure)
  const invalidInputs: Record<string,string>[] = [{}, {error:'access_denied',code:'test'}, {code:'x'.repeat(4097)}]
  for (const invalid of invalidInputs) {
    assert.equal(await finishConfirmation(new URLSearchParams(invalid), async () => {assert.fail('Must not exchange invalid input')}), confirmationFailure)
  }
})

test('confirmation cannot redirect users to an external website', async () => {
  for (const next of ['https://evil.example','//evil.example','/\\evil.example']) {
    assert.equal(await finishConfirmation(new URLSearchParams({code:'test',next}),async () => ({error:null})), '/studio')
  }
  assert.equal(await finishConfirmation(new URLSearchParams({code:'test',next:'/studio?view=plan'}),async () => ({error:null})), '/studio?view=plan')
})
