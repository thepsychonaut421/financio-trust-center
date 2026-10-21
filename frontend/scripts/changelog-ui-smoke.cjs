const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const frontendDirectory = path.resolve(__dirname, '..');
const requireFrontend = createRequire(path.join(frontendDirectory, 'package.json'));
// Resolve jsdom through the installed dependency that declares it. This also
// works when npm keeps jsdom nested rather than hoisting it to node_modules.
const requireDOMPurify = createRequire(requireFrontend.resolve('isomorphic-dompurify'));
const { JSDOM } = requireDOMPurify('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://trust.example.test/admin/changelog' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });
const React = requireFrontend('react');
const { act } = React;
const { createRoot } = requireFrontend('react-dom/client');
const ts = requireFrontend('typescript');
const requests = [];
let conflict = false;
let row = {
  id: '00000000-0000-4000-8000-000000000001', title: 'Engineering update',
  content: 'Source validated. <img src=x onerror=alert(1)>', state: 'draft', revision: 1,
  evidence: { sources: ['https://github.com/thepsychonaut421/Financio-Flow-ERP/commit/abc', 'https://ci.financioflow.com/repos/1/pipeline/2106/1', 'javascript:alert(1)', 'https://evil.example/test', 'https://github.com.evil.example/test'] },
  created_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:00:00Z',
};
let rows = [row];
const clone = value => JSON.parse(JSON.stringify(value));
const api = async (endpoint, token, options = {}) => {
  assert.equal(token, 'test-session-token');
  requests.push({ endpoint, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
  if (endpoint === '/api/changelog/config') return { repository: 'thepsychonaut421/Financio-Flow-ERP', github: 'configured', ai: 'not_configured', deploy: 'not_configured', securityCloud: 'not_configured' };
  if (endpoint === '/api/changelog') return clone(rows);
  if (endpoint.endsWith('/history')) return [{ action: row.state, actor_email: 'reviewer@example.test', revision: row.revision, title: row.title, content: row.content, note: 'Private decision', created_at: row.updated_at }];
  if (options.method === 'PATCH') {
    const body = JSON.parse(options.body);
    assert.equal(body.revision, row.revision);
    row = { ...row, ...body, revision: row.revision + 1 };
    rows[0] = row;
    return clone(row);
  }
  if (endpoint.endsWith('/review')) {
    const body = JSON.parse(options.body);
    assert.equal(body.confirm, true);
    assert.equal(body.revision, row.revision);
    if (conflict) {
      conflict = false;
      row = { ...row, title: 'Revision from another reviewer', revision: row.revision + 1 };
      rows[0] = row;
      throw new Error('Draft revision changed (409).');
    }
    assert.equal(body.decision, 'publish');
    row = { ...row, state: 'published', revision: row.revision + 1 };
    rows[0] = row;
    return clone(row);
  }
  if (endpoint === '/api/changelog/generate') {
    const generated = { ...row, id: '00000000-0000-4000-8000-000000000002', state: 'draft', revision: 1 };
    rows.unshift(generated);
    return clone(generated);
  }
  throw new Error(`Unexpected endpoint: ${endpoint}`);
};
const mockRequire = name => {
  if (name === '@/lib/api') return { apiRequestWithAuth: api };
  if (name === '@/lib/supabase/client') return { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'test-session-token' } } }) } }) };
  if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
  if (name === 'react-hot-toast') return { __esModule: true, default: { success() {}, error() {} } };
  if (name === '@/components/ui/ConfirmModal') return { __esModule: true, default: props => props.isOpen ? React.createElement('div', { role: 'dialog' },
    React.createElement('p', null, props.message),
    React.createElement('button', { onClick: props.onConfirm, disabled: props.isLoading }, props.confirmLabel),
    React.createElement('button', { onClick: props.onClose, disabled: props.isLoading }, 'Cancel')) : null };
  return requireFrontend(name);
};
function loadPage(relativePath, moduleRequire) {
  const source = fs.readFileSync(path.join(frontendDirectory, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const pageModule = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: relativePath })(moduleRequire, pageModule, pageModule.exports);
  return pageModule.exports.default;
}
const ChangelogPage = loadPage('src/app/admin/changelog/page.tsx', mockRequire);
const root = createRoot(document.getElementById('root'));
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
const click = async node => { assert.ok(node, 'Button is present'); await act(async () => { node.click(); }); };
const setValue = async (id, value) => {
  const node = document.getElementById(id);
  const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const reviewCalls = () => requests.filter(item => item.endpoint.endsWith('/review'));
async function verifyPublicUpdates() {
  const approvedContent = 'First approved paragraph.\n\nKeep <strong>literal wording</strong> and <5 unchanged.\nNo deployment claim.';
  const publicRows = [
    { id: 'assisted', title: 'Approved assisted update', content: approvedContent, content_format: 'plain_text' },
    { id: 'legacy', title: 'Legacy default format', content: '<p>Legacy <strong>formatting</strong>.</p><script>alert(1)</script>' },
    { id: 'explicit-html', title: 'Legacy explicit HTML', content: '<p><em>HTML formatting</em></p><img src=x onerror=alert(1)>', content_format: 'html' },
  ];
  const publicRequire = name => {
    if (name === '@/lib/api') return { apiRequest: async endpoint => { assert.equal(endpoint, '/api/security-updates'); return clone(publicRows); } };
    if (name === '@/components/ui/Breadcrumbs') return { __esModule: true, default: () => React.createElement('nav', null, 'Breadcrumbs') };
    return requireFrontend(name);
  };
  const PublicPage = loadPage('src/app/security-updates/page.tsx', publicRequire);
  const html = requireFrontend('react-dom/server').renderToStaticMarkup(await PublicPage());
  const publicDOM = new JSDOM(html);
  try {
    const articles = publicDOM.window.document.querySelectorAll('article');
    assert.equal(articles.length, 3);
    const approvedBody = articles[0].lastElementChild;
    assert.equal(approvedBody.textContent, approvedContent, 'Public assisted wording and paragraph breaks exactly match the approved content');
    assert.equal(articles[0].querySelector('strong'), null, 'Literal assisted markup is text, not formatting');
    // Compile the actual rendered utility classes and inspect their computed CSS,
    // so the test checks paragraph-preserving display rather than a class name.
    const postcss = requireFrontend('postcss');
    const tailwind = requireFrontend('tailwindcss');
    const css = await postcss([tailwind({ content: [{ raw: html, extension: 'html' }], corePlugins: ['whitespace'] })]).process('@tailwind utilities;', { from: undefined });
    const style = publicDOM.window.document.createElement('style');
    style.textContent = css.css;
    publicDOM.window.document.head.appendChild(style);
    assert.equal(publicDOM.window.getComputedStyle(approvedBody).whiteSpace, 'pre-wrap', 'Public paragraph breaks remain visible');
    assert.equal(articles[1].querySelector('strong').textContent, 'formatting', 'Legacy default HTML retains formatting');
    assert.equal(articles[1].querySelector('script'), null, 'Legacy HTML is still sanitized');
    assert.equal(articles[2].querySelector('em').textContent, 'HTML formatting', 'Explicit legacy HTML retains formatting');
    assert.equal(articles[2].querySelector('[onerror]'), null, 'Unsafe legacy HTML attributes are removed');
    await verifyPublicSnippets(publicRows, approvedContent);
  } finally {
    publicDOM.window.close();
  }
}
async function verifyPublicSnippets(publicRows, approvedContent) {
  const homeRequire = name => {
    if (name === 'next/link') return mockRequire(name);
    if (name === '@/components/StatsCounter') return { __esModule: true, default: ({ stats }) => React.createElement('section', null,
      stats.map(stat => React.createElement('span', { key: stat.label }, `${stat.value} ${stat.label}`))) };
    if (name.startsWith('@/components/')) return { __esModule: true, default: () => null };
    return requireFrontend(name);
  };
  const HomePage = loadPage('src/components/HomePageClient.tsx', homeRequire);
  const homeHTML = requireFrontend('react-dom/server').renderToStaticMarkup(React.createElement(HomePage, {
    settings: {}, publishedDocs: [], categories: [], certifications: [], controlCategories: [], securityUpdates: publicRows, controls: [],
  }));
  const homeDOM = new JSDOM(homeHTML);
  try {
    const excerpt = homeDOM.window.document.querySelector('#section-updates a.glass-card p');
    assert.ok(excerpt.textContent.includes('<strong>literal wording</strong>'), 'Home assisted excerpt preserves literal markup');
    assert.equal(excerpt.querySelector('strong'), null);
    assert.doesNotMatch(homeDOM.window.document.body.textContent, /99\.9|24\/7|All Systems Operational/, 'Homepage defaults do not invent operational claims');
  } finally { homeDOM.window.close(); }

  const headerRequire = name => {
    if (name === 'next/link') return mockRequire(name);
    if (name === 'next/navigation') return { useRouter: () => ({ push() {} }) };
    if (name === '@/components/GlobalRequestDocumentModal') return { __esModule: true, default: () => null };
    if (name === '@/lib/api') return { apiRequest: async endpoint => {
      assert.ok(['/api/documents', '/api/controls', '/api/certifications', '/api/security-updates'].includes(endpoint));
      return endpoint === '/api/security-updates' ? clone(publicRows) : [];
    } };
    return requireFrontend(name);
  };
  const Header = loadPage('src/components/layout/HeaderClient.tsx', headerRequire);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const headerRoot = createRoot(container);
  try {
    await act(async () => { headerRoot.render(React.createElement(Header, { companyName: 'Financio Flow', primaryColor: '#111827' })); });
    const query = container.querySelector('input');
    query.id = 'header-query';
    await setValue('header-query', 'Approved');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    const result = [...container.querySelectorAll('button')].find(node => node.textContent.includes('Approved assisted update'));
    assert.ok(result, 'Header search returns the assisted publication');
    assert.equal(result.querySelector('p').textContent, approvedContent.substring(0, 100), 'Header search preserves literal approved wording');
    assert.equal(result.querySelector('strong'), null);
  } finally {
    await act(async () => { headerRoot.unmount(); });
    container.remove();
  }
}
(async () => {
  await act(async () => { root.render(React.createElement(ChangelogPage)); });
  assert.equal(requests.filter(item => item.method !== 'GET').length, 0, 'Reading drafts never publishes');
  assert.match(document.body.textContent, /AI drafting is not configured/);
  assert.match(document.body.textContent, /green CI result does not establish a deployment/);
  assert.equal(document.querySelector('img'), null, 'Draft markup is escaped');
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.equal(document.querySelector('a[href*="evil.example"]'), null, 'Only exact evidence hostnames are linked');
  assert.equal(document.querySelectorAll('a[target="_blank"]').length, 2);

  await setValue('draft-content', 'Edited public wording');
  assert.equal(button('Save changes').disabled, false);
  assert.equal(button('Review publication').disabled, true, 'Unsaved edits cannot be published');
  await click(button('Save changes'));
  assert.equal(row.revision, 2);

  await setValue('review-note', 'Supported by commit evidence, no runtime claims.');
  await click(document.querySelector('input[type="checkbox"]'));
  assert.equal(button('Review publication').disabled, false);
  await click(button('Review publication'));
  assert.ok(document.querySelector('[role="dialog"]'), 'Second publication confirmation is visible');
  assert.equal(reviewCalls().length, 0, 'Opening confirmation does not publish');
  conflict = true;
  await click(button('Publish publicly'));
  assert.equal(reviewCalls().length, 1, 'Conflict is never retried');
  assert.equal(document.getElementById('draft-title').value, 'Revision from another reviewer');
  assert.equal(document.getElementById('review-note').value, '', 'Refresh requires a new decision note');
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false, 'Refresh clears approval');
  assert.equal(button('Review publication').disabled, true);
  assert.match(document.querySelector('[role="alert"]').textContent, /review the current revision/i);

  await setValue('review-note', 'Reviewed the current revision and evidence.');
  await click(document.querySelector('input[type="checkbox"]'));
  await click(button('Review publication'));
  await click(button('Publish publicly'));
  assert.equal(reviewCalls().length, 2);
  assert.equal(reviewCalls()[1].body.revision, 3);
  assert.equal(row.state, 'published');
  assert.equal(document.getElementById('draft-content').disabled, true, 'Published revision is immutable');
  assert.equal(button('Review publication'), undefined);

  await click(button('Prepare private draft'));
  assert.equal(requests.filter(item => item.endpoint === '/api/changelog/generate').length, 1);
  assert.equal(reviewCalls().length, 2, 'Generating a draft does not publish');
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(button('Review publication').disabled, true);
  await act(async () => { root.unmount(); });
  await verifyPublicUpdates();
  dom.window.close();
  console.log('PASS: React/jsdom UI smoke — escaped evidence/preview, save-before-review, explicit confirmation, conflict refresh without retry, immutable publication, unpublished generation, public plain-text fidelity, sanitized legacy HTML and public snippets.');
})().catch(async failure => { console.error(failure); await act(async () => { root.unmount(); }); dom.window.close(); process.exitCode = 1; });
