import assert from 'node:assert/strict';
import test from 'node:test';
import { guideExampleMarkdown } from '../apps/web/src/guide-example.js';
import { marked } from '../apps/web/node_modules/marked/lib/marked.esm.js';

test('legacy worksheet tables render as a table instead of literal code', () => {
  const source = '# 案例名称\n\n| 组成 | 归属 | 理由 |\n|---|---|---|\n| | | |';
  const html = marked.parse(guideExampleMarkdown(source));
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<pre>/);
});

test('explicit program languages preserve Markdown examples literally', () => {
  const source = '# Example\ntext = "|---|---|"\nprint(text)';
  assert.match(marked.parse(guideExampleMarkdown(source, 'python')), /<pre><code class="language-python">/);
  assert.match(marked.parse(guideExampleMarkdown('mkdir demo\n# setup')), /<pre>/);
});

test('Mermaid and following worksheet prose survive without a surrounding fence', () => {
  const source = '```mermaid\nflowchart LR\n A --> B\n```\n\n# 请填写说明\n1. 答案';
  assert.equal(guideExampleMarkdown(source), source);
  const html = marked.parse(guideExampleMarkdown(source));
  assert.match(html, /language-mermaid/);
  assert.match(html, /<h1>请填写说明<\/h1>/);
});

test('literal backticks cannot accidentally close a genuine code example', () => {
  const source = 'value = "```"';
  const html = marked.parse(guideExampleMarkdown(source, 'python'));
  assert.match(html, /language-python/);
  assert.match(html, /```/);
});
