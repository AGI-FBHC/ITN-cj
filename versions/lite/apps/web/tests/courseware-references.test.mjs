import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterReference, coursewareReferences, lessonReferences, normalizeCoursewareCitations, citationMarkdown } from '../src/courseware-references.js';

const references = chapterReference({ id: 'chapter-a', title: 'Fixture chapter', sourcePath: 'chapter.md', content: 'Original fixture text, not generated lecture prose.' }, 'bundle-a');

test('source schema copies chapter text and never invents author or URL', () => {
  assert.equal(references[0].excerpt, 'Original fixture text, not generated lecture prose.');
  assert.equal(references[0].label, '上传章节原文');
  assert.equal(references[0].author, undefined);
  assert.equal(references[0].url, undefined);
  assert.deepEqual(chapterReference({ id: 'empty', content: '' }), []);
  assert.deepEqual(coursewareReferences([{ number: 1, title: 'Unverifiable title' }]), []);
  assert.deepEqual(coursewareReferences([{ number: 1, url: 'javascript:alert(1)' }]), []);
});

test('repeated citations collapse at paragraph end and unknown sources disappear', () => {
  const input = '甲。[1]乙。[1][1]丙。[4]\n\nSecond fact [1]. More facts [1].';
  const result = normalizeCoursewareCitations(input, references);
  assert.equal(result, '甲。乙。丙。 [1]\n\nSecond fact . More facts . [1]');
  assert.equal(normalizeCoursewareCitations(result, references), result);
  assert.equal(normalizeCoursewareCitations('甲。[1]乙。[4]', []), '甲。乙。');
});

test('code fences, inline code, links, escapes and array indices remain intact', () => {
  const input = '```js\nconst x = arr[1]; // [4]\n```\n\n`arr[1]` and ``[4]``\n\n[1](https://example.test/a_(b)) [doc][1]\n\n[1]: https://example.test\n\n    arr[1]; [4]\n\narr[1] = [1]; \\[4]';
  assert.equal(normalizeCoursewareCitations(input, references), input);
  const code = '~~~js\narr[1]; [4]\n~~~\n\n说明。[1]';
  assert.equal(citationMarkdown(code, references, 'reader'), '~~~js\narr[1]; [4]\n~~~\n\n说明。 [1](#reader-reference-1)');
});

test('learner resources preserve persisted source snapshots and UTF-8 excerpts', () => {
  assert.deepEqual(lessonReferences({ resources: { lecture: { references } } }), coursewareReferences(references));
  const long = chapterReference({ id: 'c', content: '汉'.repeat(6000) })[0];
  assert.equal(long.excerptTruncated, true);
  assert.ok(Buffer.byteLength(long.excerpt, 'utf8') <= 16000);
  assert.ok(!long.excerpt.includes('\ufffd'));
});
