import test from 'node:test'
import assert from 'node:assert/strict'
import {isStudioOrigin} from './studio-origin.ts'

test('public Studio requests survive the hosting proxy origin change', () => {
  for (const origin of ['https://getworka.com','https://www.getworka.com','https://worka-production.up.railway.app']) {
    assert.equal(isStudioOrigin(origin,'http://0.0.0.0:8080','same-origin'),true)
  }
  assert.equal(isStudioOrigin('http://localhost:3100','http://localhost:3100','same-origin'),true)
})

test('foreign, lookalike, insecure and cross-site origins remain blocked', () => {
  for (const origin of ['https://evil.example','https://getworka.com.evil.example','http://getworka.com','null','https://getworka.com/']) {
    assert.equal(isStudioOrigin(origin,'http://0.0.0.0:8080','same-origin'),false)
  }
  assert.equal(isStudioOrigin('https://getworka.com','https://getworka.com','cross-site'),false)
  assert.equal(isStudioOrigin(null,'https://getworka.com','cross-site'),false)
})
