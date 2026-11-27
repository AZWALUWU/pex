export const expenseCategories = ['Makan', 'Transportasi', 'Tagihan', 'Hiburan', 'Belanja', 'Kesehatan', 'Pendidikan', 'Lainnya'] as const
export const incomeCategories = ['Gaji', 'Lainnya'] as const
export const currencies = ['IDR', 'USD', 'EUR'] as const
export type Currency = typeof currencies[number]
export type TransactionType = 'income' | 'expense'

export function amountToMinor(value: number, currency: Currency): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Jumlah harus lebih dari nol.')
  const digits = currency === 'IDR' ? 0 : 2
  const minor = Math.round(value * 10 ** digits)
  if (!Number.isSafeInteger(minor) || minor < 1) throw new Error('Jumlah di luar batas yang didukung.')
  return minor
}

export function minorToAmount(value: number, currency: Currency): number {
  return value / 10 ** (currency === 'IDR' ? 0 : 2)
}

export function validateDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function validCategory(type: TransactionType, category: string): boolean {
  return (type === 'income' ? incomeCategories : expenseCategories).includes(category as never)
}

export function escapeCsvCell(value: string | number): string {
  const text = String(value)
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
