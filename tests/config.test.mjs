import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, PROBLEMS } from '../web/js/config.js';

const jwt = (payload) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.assinatura`;
const URL_OK = 'https://abcdefgh.supabase.co';

test('placeholder é detectado', () => assert.equal(checkConfig('COLE_AQUI_A_URL', 'COLE_AQUI_A_CHAVE').problem, 'placeholder'));
test('chave anon (JWT) é aceita', () => assert.equal(checkConfig(URL_OK, jwt({ role: 'anon' })).ok, true));
test('chave publishable é aceita', () => assert.equal(checkConfig(URL_OK, 'sb_publishable_abc123').ok, true));
test('service_role em JWT é recusada', () => assert.equal(checkConfig(URL_OK, jwt({ role: 'service_role' })).problem, 'secret'));
test('sb_secret_ é recusada', () => assert.equal(checkConfig(URL_OK, 'sb_secret_abc').problem, 'secret'));
test('URL com /rest/v1 ou http remoto é recusada', () => {
    assert.equal(checkConfig(`${URL_OK}/rest/v1`, 'sb_publishable_x').problem, 'url');
    assert.equal(checkConfig('http://abcdefgh.supabase.co', 'sb_publishable_x').problem, 'url');
    assert.equal(checkConfig('nao-e-url', 'sb_publishable_x').problem, 'url');
});
test('http em localhost é aceito', () => assert.equal(checkConfig('http://localhost:54321', 'sb_publishable_x').ok, true));
test('chave sem formato conhecido é recusada', () => assert.equal(checkConfig(URL_OK, 'qualquer-coisa').problem, 'key'));
test('toda falha tem mensagem em português', () => ['placeholder', 'url', 'key', 'secret'].forEach((k) => assert.ok(PROBLEMS[k].length > 20)));
