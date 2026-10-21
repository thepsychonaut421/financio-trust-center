const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/erp-release.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exported = { exports: {} };
vm.runInThisContext(`(function(module,exports){${compiled}\n})`)(exported, exported.exports);
const observe = exported.exports.getErpReleaseObservation;
const previous = global.fetch;
const publicIdentity = { ok: true, runtime: 'nest', instanceId: 'opaque-public-process-identity' };
(async () => {
  let captured;
  global.fetch = async (url, options) => { captured = { url, options }; return Response.json(publicIdentity); };
  const availability = await observe();
  assert.equal(availability.runtime, 'nest'); assert.equal(availability.releaseSha, null); assert.ok(Number.isFinite(Date.parse(availability.observedAt)));
  assert.equal(captured.url, 'https://app.financioflow.com/api/server-info'); assert.equal(captured.options.cache, 'no-store'); assert.equal(captured.options.redirect, 'error'); assert.ok(captured.options.signal);
  assert.equal(JSON.stringify(availability).includes('opaque-public-process-identity'), false);
  global.fetch = async () => Response.json({ ...publicIdentity, release: 'a'.repeat(40) }); assert.equal((await observe()).releaseSha, 'a'.repeat(40));
  global.fetch = async () => Response.json({ ...publicIdentity, release: 'not-a-sha' }); assert.equal((await observe()).releaseSha, null);
  for (const input of [{ ...publicIdentity, runtime: 'next' }, { ...publicIdentity, ok: false }, { ...publicIdentity, instanceId: '' }, { ...publicIdentity, instanceId: 'x'.repeat(129) }]) {
    global.fetch = async () => Response.json(input); assert.equal(await observe(), null);
  }
  global.fetch = async () => new Response('Forbidden', { status: 403 }); assert.equal(await observe(), null);
  global.fetch = async () => new Response('{broken'); assert.equal(await observe(), null);
  global.fetch = async () => new Response('x'.repeat(32769)); assert.equal(await observe(), null);
  global.fetch = async () => { throw new Error('Timeout/redirect/provider unavailable'); }; assert.equal(await observe(), null);
  console.log('PASS: fixed public ERP source, bounded fail-closed observation, no invented SHA or instance disclosure.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = previous; });
