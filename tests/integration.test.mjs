import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const bin = process.platform === 'win32' ? 'node_modules/wrangler/bin/wrangler.js' : 'node_modules/.bin/wrangler'
const port = 8799 + Math.floor(Math.random() * 1000)
const args = [bin, 'pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', String(port)]
if (process.env.WRANGLER_PERSIST_TO) args.push('--persist-to', process.env.WRANGLER_PERSIST_TO)
const child = spawn(process.execPath, args, { stdio: 'ignore', env: { ...process.env, JWT_SECRET: 'local-test-secret-at-least-32-bytes-long' } })
const base = `http://127.0.0.1:${port}`
try {
  let ready = false
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base); ready = r.ok; if (ready) break } catch { await delay(500) }
  }
  assert.ok(ready, 'Pages dev server starts')
  const email = `test-${crypto.randomUUID()}@example.test`
  let response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'test-pass-1234' }) })
  assert.equal(response.status, 201, await response.clone().text())
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie)
  response = await fetch(`${base}/api/auth/me`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).user.email, email)
  response = await fetch(`${base}/api/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'expense', amount: 12.34, currency: 'USD', category: 'Makan', date: '2026-11-27', note: '=1+1' }) })
  assert.equal(response.status, 201, await response.clone().text())
  const tx = await response.json()
  response = await fetch(`${base}/api/transactions?month=2026-11`, { headers: { cookie } })
  assert.equal(response.status, 200)
  const transactions = await response.json()
  assert.equal(transactions.total, 1)
  const ownTransaction = transactions.transactions.find(row => row.id === tx.id)
  assert.equal(ownTransaction.amountMinor, 1234)
  response = await fetch(`${base}/api/summary?month=2026-11`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.ok((await response.json()).categories.some(row => row.totalMinor === 1234))
  response = await fetch(`${base}/api/export.csv?month=2026-11`, { headers: { cookie } })
  assert.match(await response.text(), /"'=1\+1"/)
  response = await fetch(`${base}/api/budgets/2026-11/Makan`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ amount: 50, currency: 'USD' }) })
  assert.equal(response.status, 200, await response.clone().text())
  response = await fetch(`${base}/api/budgets?month=2026-11`, { headers: { cookie } })
  assert.equal((await response.json()).budgets.length, 1)
  response = await fetch(`${base}/api/budgets/2026-11/Makan`, { method: 'DELETE', headers: { cookie } })
  assert.equal(response.status, 200)
  response = await fetch(`${base}/api/transactions/${tx.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'expense', amount: 20, currency: 'USD', category: 'Makan', date: '2026-11-27', note: 'updated' }) })
  assert.equal(response.status, 200)
  response = await fetch(`${base}/api/transactions/${tx.id}`, { method: 'DELETE', headers: { cookie } })
  assert.equal(response.status, 200)
  const otherResponse = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `other-${crypto.randomUUID()}@example.test`, password: 'test-pass-1234' }) })
  assert.equal(otherResponse.status, 201)
  const otherCookie = otherResponse.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.equal((await (await fetch(`${base}/api/transactions?month=2026-11`, { headers: { cookie: otherCookie } })).json()).total, 0)
  console.log('PeX API integration checks passed')
} finally {
  child.kill()
}
