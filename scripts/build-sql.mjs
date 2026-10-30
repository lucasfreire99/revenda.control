// Junta as migrações em UM arquivo para colar no SQL Editor do Supabase:
//   npm run sql:bundle  ->  supabase/setup-completo.sql

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'supabase', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const parts = [
    '-- =====================================================================',
    '-- Revenda+ | SETUP COMPLETO (gerado por "npm run sql:bundle" — não edite aqui)',
    '-- Cole TUDO no Supabase: SQL Editor > New query > Run.',
    '-- É seguro rodar mais de uma vez.',
    '-- =====================================================================',
    ''
];
for (const f of files) parts.push(`-- >>>>> ${f}`, fs.readFileSync(path.join(dir, f), 'utf8').trim(), '');

const out = path.join(root, 'supabase', 'setup-completo.sql');
fs.writeFileSync(out, parts.join('\n'));
console.log(`Gerado ${path.relative(root, out)} com ${files.length} migrações.`);
