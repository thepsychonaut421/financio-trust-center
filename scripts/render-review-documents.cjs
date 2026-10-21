#!/usr/bin/env node
// Render only the curated review pack. Never use operational env files or secrets.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const repository = path.resolve(__dirname, '..');
const PDFDocument = createRequire(path.join(repository, 'backend/package.json'))('pdfkit');
const outputDirectory = process.argv[2];
if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error('Provide an absolute review output directory');
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const fontPairs = [['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'], ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf']];
const fonts = fontPairs.find(pair => pair.every(file => fs.existsSync(file)));
if (!fonts) throw new Error('Review rendering needs DejaVu Sans or Arial font files');
const names = ['NDA', 'PRIVACY_NOTICE', 'TRUST_CENTER_TERMS', 'SECURITY_OVERVIEW', 'VULNERABILITY_DISCLOSURE', 'SERVICE_PROVIDERS', 'DOCUMENT_ACCESS_POLICY'];
async function render(name) {
  const source = fs.readFileSync(path.join(repository, 'docs/review', `${name}_DRAFT.md`), 'utf8');
  const destination = path.join(outputDirectory, `${name}_DRAFT.pdf`);
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  const document = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true, info: { Title: source.split('\n')[0].replace(/^# /, ''), Author: 'Financio Flow', Subject: 'Draft for manual review; not approved for publication' } });
  const done = new Promise((resolve, reject) => { output.on('finish', resolve); output.on('error', reject); document.on('error', reject); });
  document.registerFont('ReviewBody', fonts[0]); document.registerFont('ReviewHeading', fonts[1]);
  document.pipe(output);
  for (const paragraph of source.split(/\n\s*\n/)) {
    const text = paragraph.replace(/\n/g, ' ').replace(/\*\*/g, '');
    if (text.startsWith('# ')) document.font('ReviewHeading').fontSize(19).fillColor('#163661').text(text.slice(2)).moveDown(0.8);
    else if (text.startsWith('## ')) document.font('ReviewHeading').fontSize(12).fillColor('#163661').text(text.slice(3)).moveDown(0.4);
    else document.font('ReviewBody').fontSize(10).fillColor('#202a36').text(text, { lineGap: 3 }).moveDown(0.6);
  }
  const pages = document.bufferedPageRange();
  for (let index = 0; index < pages.count; index++) {
    document.switchToPage(index);
    document.font('ReviewHeading').fontSize(8).fillColor('#9f1239').text('DRAFT — FOR REVIEW — NOT APPROVED FOR PUBLICATION', 54, 28, { lineBreak: false });
    document.font('ReviewBody').fontSize(8).fillColor('#64748b').text(`Prepared 2026-10-11 | ${index + 1} / ${pages.count}`, 54, document.page.height - 28, { lineBreak: false });
  }
  document.end(); await done;
  fs.chmodSync(destination, 0o600);
  return { file: path.basename(destination), bytes: fs.statSync(destination).size, pages: pages.count };
}
(async () => { for (const name of names) console.log(JSON.stringify(await render(name))); })().catch(() => { console.error('Review rendering failed'); process.exitCode = 1; });
