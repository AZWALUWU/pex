import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import { amountToMinor, currencies, escapeCsvCell, expenseCategories, incomeCategories, validCategory, validateDate, type Currency } from '../lib/domain'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { userId: string; email: string }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().basePath('/api')
const cookieName = 'pex_session'
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/
const emailSchema = z.string().trim().toLowerCase().email().max(254)
const passwordSchema = z.string().min(8).max(128)
const saltHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

async function derivePassword(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, key, 256)
  return saltHex(new Uint8Array(bits))
}

type Context = { env: Bindings; req: { url: string; header: (name: string) => string | undefined; json: <T = unknown>() => Promise<T>; query: (name: string) => string | undefined; param: (name: string) => string }; get: (key: 'userId' | 'email') => string; set: (key: 'userId' | 'email', value: string) => void; json: (data: unknown, status?: number) => Response }
async function authenticate(c: Context, next: () => Promise<void>) {
  const id = getCookie(c, cookieName)
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Silakan masuk kembali.' }, 401)
  const session = await c.env.DB.prepare('SELECT users.id AS user_id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?').bind(id, Math.floor(Date.now() / 1000)).first<{ user_id: string; email: string }>()
  if (!session) return c.json({ error: 'Sesi berakhir. Silakan masuk kembali.' }, 401)
  c.set('userId', session.user_id)
  c.set('email', session.email)
  await next()
}

app.get('/auth/me', async (c, next) => {
  const id = getCookie(c, cookieName)
  if (!id) return c.json({ user: null })
  try {
    await authenticate(c, next)
    return c.res
  } catch {
    return c.json({ user: null })
  }
})
app.use('/auth/logout', authenticate)
app.use('/auth/password', authenticate)
app.use('/auth/sessions', authenticate)
app.use('/auth/account', authenticate)
app.use('/settings', authenticate)
app.use('/transactions', authenticate)
app.use('/transactions/*', authenticate)
app.use('/budgets', authenticate)
app.use('/budgets/*', authenticate)
app.use('/summary', authenticate)
app.use('/export.csv', authenticate)
app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Permintaan gagal diproses.' }, 500)
})

app.post('/auth/register', async c => {
  const limited = await rateLimit(c.env.DB, 'register', c.req.header('CF-Connecting-IP') ?? 'unknown', 6, 600)
  if (!limited) return c.json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' }, 429)
  const body = z.object({ email: emailSchema, password: passwordSchema }).safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'Masukkan email yang valid dan kata sandi 8-128 karakter.' }, 400)
  const id = crypto.randomUUID()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  try {
    await c.env.DB.prepare('INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)').bind(id, body.data.email, await derivePassword(body.data.password, salt), saltHex(salt)).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) return c.json({ error: 'Email sudah terdaftar.' }, 409)
    throw error
  }
  return createSession(c, id, body.data.email, 201)
})

app.post('/auth/login', async c => {
  const limited = await rateLimit(c.env.DB, 'login', c.req.header('CF-Connecting-IP') ?? 'unknown', 10, 600)
  if (!limited) return c.json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' }, 429)
  const body = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'Email atau kata sandi tidak valid.' }, 400)
  const user = await c.env.DB.prepare('SELECT id, email, password_hash, password_salt FROM users WHERE email = ?').bind(body.data.email).first<{ id: string; email: string; password_hash: string; password_salt: string }>()
  if (!user || await derivePassword(body.data.password, Uint8Array.from(user.password_salt.match(/.{2}/g) ?? [], byte => parseInt(byte, 16))) !== user.password_hash) return c.json({ error: 'Email atau kata sandi salah.' }, 401)
  return createSession(c, user.id, user.email)
})

app.get('/auth/me', c => c.json({ user: { id: c.get('userId'), email: c.get('email') } }))
app.post('/auth/logout', async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(getCookie(c, cookieName)).run()
  deleteCookie(c, cookieName, { path: '/', secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' })
  return c.json({ success: true })
})
app.post('/auth/sessions/revoke-others', async c => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(c.get('userId'), getCookie(c, cookieName)).run()
  return c.json({ success: true })
})
app.put('/auth/password', async c => {
  const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'Kata sandi baru harus 8-128 karakter.' }, 400)
  const user = await c.env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(c.get('userId')).first<{ password_hash: string; password_salt: string }>()
  if (!user || await derivePassword(body.data.currentPassword, Uint8Array.from(user.password_salt.match(/.{2}/g) ?? [], byte => parseInt(byte, 16))) !== user.password_hash) return c.json({ error: 'Kata sandi saat ini salah.' }, 401)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(await derivePassword(body.data.newPassword, salt), saltHex(salt), c.get('userId')).run()
  return c.json({ success: true })
})
app.delete('/auth/account', async c => {
  const body = z.object({ password: z.string().min(1).max(128), confirm: z.enum(['HAPUS', 'DELETE']) }).safeParse(await c.req.json().catch(() => null))
  if (!body.success || body.data.confirm !== 'HAPUS' && body.data.confirm !== 'DELETE') return c.json({ error: 'Konfirmasi penghapusan tidak valid.' }, 400)
  const user = await c.env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(c.get('userId')).first<{ password_hash: string; password_salt: string }>()
  if (!user || await derivePassword(body.data.password, Uint8Array.from(user.password_salt.match(/.{2}/g) ?? [], byte => parseInt(byte, 16))) !== user.password_hash) return c.json({ error: 'Kata sandi salah.' }, 401)
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.get('userId')).run()
  deleteCookie(c, cookieName, { path: '/', secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' })
  return c.json({ success: true })
})

app.get('/settings', async c => {
  const row = await c.env.DB.prepare('SELECT default_currency AS currency, preferred_language AS language, theme FROM users WHERE id = ?').bind(c.get('userId')).first()
  return c.json(row)
})
app.put('/settings', async c => {
  const body = z.object({ currency: z.enum(currencies).optional(), language: z.enum(['id', 'en']).optional(), theme: z.enum(['light', 'dark', 'system']).optional() }).refine(x => Object.keys(x).length > 0).safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'Pengaturan tidak valid.' }, 400)
  const sets: string[] = [], values: unknown[] = []
  if (body.data.currency) { sets.push('default_currency = ?'); values.push(body.data.currency) }
  if (body.data.language) { sets.push('preferred_language = ?'); values.push(body.data.language) }
  if (body.data.theme) { sets.push('theme = ?'); values.push(body.data.theme) }
  values.push(c.get('userId'))
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ success: true })
})

const transactionInput = z.object({ type: z.enum(['income', 'expense']), amount: z.number().finite().positive(), currency: z.enum(currencies), category: z.string(), date: z.string(), note: z.string().max(500).default('') }).refine(x => validCategory(x.type, x.category) && validateDate(x.date), { message: 'Kategori atau tanggal tidak valid.' })
app.get('/transactions', async c => {
  const month = c.req.query('month')
  if (!month || !monthPattern.test(month)) return c.json({ error: 'Bulan harus berformat YYYY-MM.' }, 400)
  const page = Math.max(1, Math.min(10000, Number(c.req.query('page') ?? 1) || 1))
  const type = c.req.query('type')
  const category = c.req.query('category')
  const filters = ['user_id = ?', "substr(date, 1, 7) = ?"], params: unknown[] = [c.get('userId'), month]
  if (type === 'income' || type === 'expense') { filters.push('type = ?'); params.push(type) }
  if (category) { filters.push('category = ?'); params.push(category) }
  const where = filters.join(' AND ')
  const [count, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM transactions WHERE ${where}`).bind(...params).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT id, type, amount_minor AS amountMinor, currency, category, date, note FROM transactions WHERE ${where} ORDER BY date DESC, created_at DESC, id DESC LIMIT 20 OFFSET ?`).bind(...params, (page - 1) * 20).all(),
  ])
  return c.json({ transactions: rows.results, total: count?.total ?? 0, page, pageSize: 20 })
})
app.post('/transactions', async c => {
  const body = transactionInput.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Transaksi tidak valid.' }, 400)
  let amountMinor: number
  try { amountMinor = amountToMinor(body.data.amount, body.data.currency) } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Jumlah tidak valid.' }, 400) }
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO transactions (id, user_id, type, amount_minor, currency, category, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, c.get('userId'), body.data.type, amountMinor, body.data.currency, body.data.category, body.data.date, body.data.note).run()
  return c.json({ id }, 201)
})
app.put('/transactions/:id', async c => {
  const body = transactionInput.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'Transaksi tidak valid.' }, 400)
  let amountMinor: number
  try { amountMinor = amountToMinor(body.data.amount, body.data.currency) } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Jumlah tidak valid.' }, 400) }
  const result = await c.env.DB.prepare('UPDATE transactions SET type = ?, amount_minor = ?, currency = ?, category = ?, date = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').bind(body.data.type, amountMinor, body.data.currency, body.data.category, body.data.date, body.data.note, c.req.param('id'), c.get('userId')).run()
  if (!result.meta.changes) return c.json({ error: 'Transaksi tidak ditemukan.' }, 404)
  return c.json({ success: true })
})
app.delete('/transactions/:id', async c => {
  const result = await c.env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('userId')).run()
  if (!result.meta.changes) return c.json({ error: 'Transaksi tidak ditemukan.' }, 404)
  return c.json({ success: true })
})

app.get('/budgets', async c => {
  const month = c.req.query('month')
  if (!month || !monthPattern.test(month)) return c.json({ error: 'Bulan harus berformat YYYY-MM.' }, 400)
  const [budgets, spent] = await Promise.all([
    c.env.DB.prepare('SELECT id, category, amount_minor AS amountMinor, currency FROM budgets WHERE user_id = ? AND month = ? ORDER BY category').bind(c.get('userId'), month).all(),
    c.env.DB.prepare("SELECT category, currency, SUM(amount_minor) AS spentMinor FROM transactions WHERE user_id = ? AND substr(date, 1, 7) = ? AND type = 'expense' GROUP BY category, currency").bind(c.get('userId'), month).all(),
  ])
  return c.json({ budgets: budgets.results, spent: spent.results })
})
app.put('/budgets/:month/:category', async c => {
  const month = c.req.param('month'), category = c.req.param('category'), userId = c.get('userId')
  const body = z.object({ amount: z.number().finite().positive(), currency: z.enum(currencies) }).safeParse(await c.req.json().catch(() => null))
  if (!monthPattern.test(month) || !(expenseCategories as readonly string[]).includes(category) || !body.success) return c.json({ error: 'Anggaran tidak valid.' }, 400)
  let amountMinor: number
  try { amountMinor = amountToMinor(body.data.amount, body.data.currency) } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Jumlah tidak valid.' }, 400) }
  const mixed = await c.env.DB.prepare('SELECT 1 FROM budgets WHERE user_id = ? AND month = ? AND currency != ? LIMIT 1').bind(userId, month, body.data.currency).first()
  if (mixed) return c.json({ error: 'Semua anggaran dalam bulan yang sama harus memakai mata uang yang sama.' }, 400)
  await c.env.DB.prepare('INSERT INTO budgets (id, user_id, month, category, amount_minor, currency) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, month, category) DO UPDATE SET amount_minor = excluded.amount_minor, currency = excluded.currency').bind(crypto.randomUUID(), userId, month, category, amountMinor, body.data.currency).run()
  return c.json({ success: true })
})
app.delete('/budgets/:month/:category', async c => {
  await c.env.DB.prepare('DELETE FROM budgets WHERE user_id = ? AND month = ? AND category = ?').bind(c.get('userId'), c.req.param('month'), c.req.param('category')).run()
  return c.json({ success: true })
})

app.get('/summary', async c => {
  const month = c.req.query('month')
  if (!month || !monthPattern.test(month)) return c.json({ error: 'Bulan harus berformat YYYY-MM.' }, 400)
  const start = `${month}-01`, end = `${month}-31`
  const [totals, categories, trend, budgets] = await Promise.all([
    c.env.DB.prepare('SELECT type, currency, SUM(amount_minor) AS totalMinor FROM transactions WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY type, currency').bind(c.get('userId'), start, end).all(),
    c.env.DB.prepare("SELECT category, currency, SUM(amount_minor) AS totalMinor FROM transactions WHERE user_id = ? AND type = 'expense' AND date BETWEEN ? AND ? GROUP BY category, currency ORDER BY totalMinor DESC").bind(c.get('userId'), start, end).all(),
    c.env.DB.prepare("SELECT substr(date, 1, 7) AS month, type, currency, SUM(amount_minor) AS totalMinor FROM transactions WHERE user_id = ? AND date >= ? AND date < ? GROUP BY month, type, currency ORDER BY month").bind(c.get('userId'), `${shiftMonth(month, -5)}-01`, `${shiftMonth(month, 1)}-01`).all(),
    c.env.DB.prepare('SELECT id, category, currency, amount_minor AS amountMinor FROM budgets WHERE user_id = ? AND month = ?').bind(c.get('userId'), month).all(),
  ])
  return c.json({ month, totals: totals.results, categories: categories.results, trend: trend.results, budgets: budgets.results })
})
app.get('/export.csv', async c => {
  const month = c.req.query('month')
  if (!month || !monthPattern.test(month)) return c.json({ error: 'Bulan harus berformat YYYY-MM.' }, 400)
  const rows = await c.env.DB.prepare('SELECT type, amount_minor, currency, category, date, note FROM transactions WHERE user_id = ? AND substr(date, 1, 7) = ? ORDER BY date, created_at').bind(c.get('userId'), month).all<{ type: string; amount_minor: number; currency: string; category: string; date: string; note: string }>()
  const lines = [['type', 'amount_minor', 'currency', 'category', 'date', 'note'], ...rows.results.map(row => [row.type, row.amount_minor, row.currency, row.category, row.date, row.note])]
  return new Response(`\uFEFF${lines.map(line => line.map(escapeCsvCell).join(',')).join('\r\n')}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="pex-${month}.csv"`, 'Cache-Control': 'no-store' } })
})

async function createSession(c: Context, userId: string, email: string, status = 200) {
  const sessionId = crypto.randomUUID()
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, userId, expires).run()
  setCookie(c, cookieName, sessionId, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 60 * 60 })
  return c.json({ user: { id: userId, email } }, status as 200 | 201)
}

async function rateLimit(db: D1Database, action: string, ip: string, limit: number, windowSeconds: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
  const key = `${action}:${ip}:${bucket}`
  try {
    const row = await db.prepare('INSERT INTO rate_limits (key, hits) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits').bind(key).first<{ hits: number }>()
    await db.prepare('DELETE FROM rate_limits WHERE key NOT LIKE ?').bind(`%:${bucket}`).run()
    return (row?.hits ?? limit + 1) <= limit
  } catch (error) {
    console.error('Rate limit storage unavailable', error)
    return true
  }
}

function shiftMonth(month: string, offset: number): string {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7)
}

export const onRequest: PagesFunction<Bindings> = context => app.fetch(context.request, context.env, context)
