const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const directory = path.resolve(__dirname, '..');
const requireFrontend = createRequire(path.join(directory, 'package.json'));
const requireDOMPurify = createRequire(requireFrontend.resolve('isomorphic-dompurify'));
const { JSDOM } = requireDOMPurify('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://trust.example.test/admin/forgot-password' });
global.window = dom.window; global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = requireFrontend('react');
const { act } = React;
const { createRoot } = requireFrontend('react-dom/client');
const ts = requireFrontend('typescript');
let user = { id: 'test-admin' }; let admin = { id: 'test-admin' };
let updateError = false; const recoveries = []; const updates = []; const signOuts = []; const downloads = [];
const client = {
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    resetPasswordForEmail: async (...args) => { recoveries.push(args); return { error: null }; },
    updateUser: async body => { updates.push(body); return { error: updateError ? new Error('Expired session') : null }; },
    signOut: async body => { signOuts.push(body); return { error: null }; },
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: admin, error: null }) }) }) }),
};
const Panel = ({ children }) => React.createElement('div', {}, children);
const Dialog = Object.assign(({ children }) => React.createElement('div', { role: 'dialog' }, children), { Panel, Title: Panel });
const Transition = { Root: ({ show, children }) => show ? children : null };
let NdaModal;
const mockRequire = name => {
  if (name === '@/lib/supabase/client') return { createClient: () => client };
  if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
  if (name === 'next/navigation') return { useParams: () => ({ token: 'owned-link' }) };
  if (name === '@headlessui/react') return { Dialog, Transition };
  if (name === '@/components/NDAModal') return { __esModule: true, default: NdaModal };
  if (name === 'react-hot-toast') return { __esModule: true, default: { success() {}, error() {} } };
  if (name === '@/lib/api') return { apiRequest: async () => ({ request: { id: 'owned-request', requester_name: 'Owner', documents: [{ id: 'owned-document', title: 'Owned test', requires_nda: true }] } }) };
  return requireFrontend(name);
};
function load(relative, moduleRequire = mockRequire) {
  const source = fs.readFileSync(path.join(directory, relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: relative })(moduleRequire, module, module.exports);
  return module.exports;
}
let root = createRoot(document.getElementById('root'));
const click = async label => {
  const node = [...document.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(node, `Missing button ${label}`); await act(async () => node.click());
};
const value = async (id, text) => {
  const node = document.getElementById(id); assert.ok(node, `Missing input ${id}`);
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, text); node.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
const render = async Component => {
  await act(async () => root.unmount());
  document.getElementById('root').replaceChildren(); root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Component)));
};
async function recovery() {
  await render(load('src/app/admin/forgot-password/page.tsx').default);
  await value('recovery-email', 'operator@example.test'); await click('Send recovery email');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0][1].redirectTo, 'https://trust.example.test/auth/callback');
  assert.match(document.body.textContent, /If this address has an account/);
  const Reset = load('src/app/admin/reset-password/page.tsx').default;
  user = null; await render(Reset);
  assert.equal(document.getElementById('new-password'), null);
  user = { id: 'test-admin' }; admin = null; await render(Reset);
  assert.match(document.body.textContent, /administrator account is required/);
  assert.equal(document.getElementById('new-password'), null);
  admin = { id: 'test-admin' }; await render(Reset);
  await value('new-password', 'Test password 123456!'); await value('confirm-password', 'Different password 123456!'); await click('Update password');
  assert.equal(updates.length, 0); assert.match(document.body.textContent, /passwords do not match/);
  await value('confirm-password', 'Test password 123456!'); updateError = true; await click('Update password');
  assert.equal(signOuts.length, 0); assert.match(document.body.textContent, /Could not update/);
  updateError = false; await click('Update password');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
  assert.equal(document.getElementById('new-password'), null);
  assert.match(document.body.textContent, /Password updated/);
}
async function access() {
  NdaModal = load('src/components/NDAModal.tsx').default;
  let accepted = false; const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/accept-nda')) { const body = JSON.parse(options.body); assert.deepEqual(body, { nda_accepted: true, nda_url: '/nda-v1.pdf' }); accepted = true; return { ok: true }; }
    if (!accepted) return { status: 403, ok: false, json: async () => ({ error: 'NDA_REQUIRED', nda_url: '/nda-v1.pdf' }) };
    return { status: 200, ok: true, headers: { get: () => 'attachment; filename="owned.pdf"' }, blob: async () => new Blob(['Owned fixture']) };
  };
  window.URL.createObjectURL = () => 'blob:owned-fixture'; window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  await render(load('src/app/access/[token]/page.tsx').default);
  await click('Download');
  assert.ok(document.querySelector('iframe[src="/nda-v1.pdf"]'));
  const accept = [...document.querySelectorAll('button')].find(node => node.textContent === 'Accept & Download');
  assert.equal(accept.disabled, true); assert.equal(downloads.length, 0);
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Accept & Download');
  assert.deepEqual(downloads, ['owned.pdf']); assert.equal(calls.filter(call => call.url.endsWith('/accept-nda')).length, 1);
}
async function callback() {
  let exchanges = 0;
  const moduleRequire = name => name === '@/lib/supabase/server'
    ? { createClient: async () => ({ auth: { exchangeCodeForSession: async code => { assert.equal(code, 'owned-code'); exchanges++; return { data: { session: {} }, error: null }; }, verifyOtp: async () => ({ data: { session: null }, error: new Error('expired') }) } }) }
    : name === 'next/server' ? { NextResponse: { redirect: url => ({ url: url.href, headers: new Headers() }) } } : requireFrontend(name);
  const { GET } = load('src/app/auth/callback/route.ts', moduleRequire);
  const invoke = url => GET({ nextUrl: new URL(url), url });
  const result = await invoke('https://trust.example.test/auth/callback?code=owned-code&next=https://untrusted.example');
  assert.equal(exchanges, 1); assert.equal(result.url, 'https://trust.example.test/admin/reset-password');
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  const rejected = await invoke('https://trust.example.test/auth/callback?token_hash=old-token&type=recovery');
  assert.equal(rejected.url, 'https://trust.example.test/admin/reset-password?error=invalid_link');
}
(async () => { await recovery(); await access(); await callback(); await act(async () => root.unmount()); console.log('Recovery, restricted access/NDA, and callback UI checks passed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
