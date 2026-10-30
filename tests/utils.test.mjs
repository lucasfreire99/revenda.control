import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, DEFAULT_CATEGORY, resolveCategory, isUUID, newId, round2, margin } from '../web/js/utils.js';

test('categorias novas, na ordem pedida', () => {
    assert.deepEqual(CATEGORIES, ['Hidratante', 'Perfume', 'Bodysplash', 'Booster', 'Proteína', 'Esfoliante', 'Desodorante', 'Sabonete', 'Shampoo + Condicionador']);
    assert.equal(DEFAULT_CATEGORY, 'Hidratante');
});
test('resolveCategory', () => {
    assert.equal(resolveCategory(''), DEFAULT_CATEGORY);
    assert.equal(resolveCategory('Perfume'), 'Perfume');
    assert.equal(resolveCategory('  Outra  '), 'Outra');
});
test('newId gera UUID v4 mesmo sem crypto.randomUUID', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    try {
        Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
        assert.ok(isUUID(newId()));
    } finally { if (orig) Object.defineProperty(globalThis.crypto, 'randomUUID', orig); }
    assert.ok(isUUID(newId()));
});
test('isUUID rejeita lixo', () => { assert.equal(isUUID('123'), false); assert.equal(isUUID(5), false); });
test('contas', () => { assert.equal(round2(1.005 + 0.001), 1.01); assert.equal(margin(100, 60), 40); assert.equal(margin(0, 5), 0); });
