import assert from 'node:assert/strict'
import { amountToMinor, minorToAmount, escapeCsvCell, validateDate, validCategory } from '../functions/lib/domain.ts'

assert.equal(amountToMinor(12.34, 'USD'), 1234)
assert.equal(amountToMinor(12500, 'IDR'), 12500)
assert.equal(minorToAmount(1234, 'EUR'), 12.34)
assert.throws(() => amountToMinor(0, 'USD'))
assert.throws(() => amountToMinor(Number.MAX_SAFE_INTEGER, 'USD'))
assert.equal(validateDate('2024-02-29'), true)
assert.equal(validateDate('2025-02-29'), false)
assert.equal(validateDate('2024-2-09'), false)
assert.equal(validCategory('income', 'Gaji'), true)
assert.equal(validCategory('income', 'Makan'), false)
assert.equal(validCategory('expense', 'Transportasi'), true)
assert.equal(escapeCsvCell('=1+1'), "\"'=1+1\"")
assert.equal(escapeCsvCell('plain, text'), '"plain, text"')
assert.equal(escapeCsvCell('say "hello"'), '"say ""hello"""')
console.log('PeX core checks passed')
