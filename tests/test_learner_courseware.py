"""Real HTTP/MySQL regression for learner-facing published courseware.

All content is a manually authored fixture, not model-generated output. This
suite never calls a model, changes provider settings, or touches user courses.
Set ZHIXUN_ADMIN_PASSWORD and run against the native service and isolated dev DB.
"""
import hashlib
import json
import os
from pathlib import Path
import unittest
import urllib.error
import urllib.request
import uuid

import pymysql


ROOT = Path(__file__).resolve().parent.parent
API = os.environ.get('ZHIXUN_TEST_API', 'http://localhost:3006/api').rstrip('/')
KINDS = ('lecture', 'bank', 'slides')


@unittest.skipUnless(os.environ.get('ZHIXUN_ADMIN_PASSWORD'), 'Set ZHIXUN_ADMIN_PASSWORD')
class LearnerCoursewareTest(unittest.TestCase):
    def sql(self, statement, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(statement, args)
            return cursor.fetchall() if cursor.description else cursor.rowcount

    def call(self, route, token=None, body=None, method=None, expect=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(API + route, None if body is None else json.dumps(body).encode(),
                                         headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            data = json.loads(raw) if raw else {}
            if expect is None:
                self.assertTrue(200 <= response.status < 300, (route, response.status, data.get('message')))
            else:
                self.assertEqual(response.status, expect, (route, data.get('message')))
        return data

    def setUp(self):
        values = {}
        for line in (ROOT / '.env.local').read_text(encoding='utf-8-sig').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip()
        self.assertEqual(values['ZHIXUN_DB_NAME'], 'itn_learning_v2_dev')
        self.db = pymysql.connect(host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
                                  user=values['ZHIXUN_DB_USER'], password=values['ZHIXUN_DB_PASSWORD'],
                                  database=values['ZHIXUN_DB_NAME'], charset='utf8mb4', autocommit=True,
                                  cursorclass=pymysql.cursors.DictCursor, connect_timeout=10, read_timeout=30)
        self.run_id = str(uuid.uuid4())
        self.bid = str(uuid.uuid4())
        self.cid = 'kb-' + self.bid.replace('-', '')
        self.name = 'learner-courseware-manual-fixture-' + self.run_id
        self.doc_ids = {letter: str(uuid.uuid4()) for letter in 'ABCD'}
        self.resource_ids = {(letter, kind): str(uuid.uuid4()) for letter in 'ABCD' for kind in KINDS}
        self.learners = []
        self.phases = []
        self.admin = None
        self.addCleanup(self.cleanup)
        self.admin = self.call('/admin/login', body={'account': os.environ.get('ZHIXUN_ADMIN_ACCOUNT', 'admin'),
                                                   'password': os.environ['ZHIXUN_ADMIN_PASSWORD']})['token']
        self.settings_before = json.dumps(self.call('/admin/kb', self.admin)['settings'], sort_keys=True)
        self.env_before = hashlib.sha256((ROOT / '.env.local').read_bytes()).hexdigest()
        self.sql('INSERT INTO kb_bundles(id,name,bytes,status,title,source_saved) VALUES(%s,%s,0,%s,%s,1)',
                 (self.bid, self.name, 'ready', 'Manual fixture: learner resources'))
        for position, letter in enumerate('ABCD'):
            text = '# Manual fixture ' + letter + '\n\nIndependently authored contract test material.\n'
            self.sql('INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count,original_content,source_path) '
                     'VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                     (self.doc_ids[letter], self.bid, position, 'Manual chapter ' + letter, text,
                      len(text), text, 'manual-fixture-' + letter + '.md'))
            for kind in KINDS:
                self.sql('INSERT INTO kb_courseware(id,bundle_id,doc_id,kind,title,status,published,content_json,model) '
                         'VALUES(%s,%s,%s,%s,%s,%s,0,%s,%s)',
                         (self.resource_ids[letter, kind], self.bid, self.doc_ids[letter], kind,
                          'Manual ' + letter + ' ' + kind, 'ready', json.dumps(self.fixture(letter, kind)),
                          'manually-authored-learner-contract-fixture'))
        self.learners.append(self.call('/session', body={}))

    @staticmethod
    def fixture(letter, kind):
        if kind == 'lecture':
            return {'title': 'Lecture ' + letter, 'objective': 'Read the manual fixture.',
                    'objectives': ['Identify the input.', 'Describe the result.'],
                    'sections': [{'heading': 'Manual input ' + letter, 'body': 'Lecture body ' + letter + ' [1].'},
                                 {'heading': 'Manual result ' + letter, 'body': 'Second lecture section ' + letter + '.'}]}
        if kind == 'slides':
            return {'title': 'Slides ' + letter, 'subtitle': 'Manual content',
                    'slides': [{'title': 'Slide one ' + letter, 'bullets': ['Manual input', 'Manual action'],
                                'speakerNote': 'Explain the real first slide ' + letter + '.'},
                               {'title': 'Slide two ' + letter, 'bullets': ['Manual result', 'Manual check'],
                                'speakerNote': 'Explain the real second slide ' + letter + '.'}]}
        return {'title': 'Bank ' + letter,
                'questions': [{'id': 'q-' + str(i), 'stem': 'Manual ' + letter + ' question ' + str(i),
                               'options': ['Expected result', 'Other result'], 'correctIndex': 0,
                               'explanation': 'PRIVATE_EXPLANATION_' + letter + '_' + str(i),
                               'knowledgePointId': 'manual-' + letter, 'difficulty': 'easy'} for i in range(5)]}

    def publish_resource(self, letter, kind, live=True):
        route = '/admin/kb/courseware/' + self.resource_ids[letter, kind] + ('/publish' if live else '/unpublish')
        return self.call(route, self.admin, {})

    def publish_chapter(self, letter, order, expect=None):
        return self.call('/admin/kb/courseware/chapters/' + self.doc_ids[letter] + '/publish', self.admin,
                         {'bundleId': self.bid, 'order': order}, expect=expect)

    def catalog_course(self):
        courses = self.call('/courses', self.learners[0]['token'])['courses']
        return next((course for course in courses if course['id'] == self.cid), None)

    def lesson(self, index, expect=None):
        return self.call('/courses/' + self.cid + '/lessons/' + str(index), self.learners[0]['token'], expect=expect)

    def progress(self, index, complete=False, expect=None):
        return self.call('/courses/' + self.cid + '/lessons/' + str(index) + '/progress', self.learners[0]['token'],
                         {'read': True, 'complete': complete}, 'PUT', expect=expect)

    def quiz(self, index, correct):
        return self.call('/courses/' + self.cid + '/lessons/' + str(index) + '/quiz', self.learners[0]['token'],
                         {'attemptId': str(uuid.uuid4()), 'durationSeconds': 15,
                          'answers': [{'questionId': 'q-' + str(i), 'choice': 0 if i < correct else 1} for i in range(5)]})

    def history(self):
        rows = {table: self.sql('SELECT * FROM ' + table + ' WHERE course_id=%s ORDER BY user_id,lesson_index', (self.cid,))
                for table in ('lesson_progress', 'quiz_attempts')}
        return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()

    def checkpoint(self, label):
        self.phases.append(label)
        print('PASSED:', label, flush=True)

    def assert_public(self, value):
        private = {'correct', 'correctIndex', 'correctAnswer', 'answerKey', 'explanation'}
        if isinstance(value, dict):
            self.assertFalse(private.intersection(value), 'Pre-submission response exposes private quiz fields')
            for child in value.values():
                self.assert_public(child)
        elif isinstance(value, list):
            for child in value:
                self.assert_public(child)

    def test_published_resources_and_completion_contract(self):
        self.call('/admin/kb/bundles/' + self.bid + '/publish', self.admin, {})
        self.assertIsNone(self.catalog_course())
        self.publish_chapter('D', 20, expect=409)
        for kind in KINDS:
            self.publish_resource('A', kind)
        for kind in ('lecture',):
            self.publish_resource('B', kind)
        self.publish_resource('C', 'slides')
        # Intentionally non-contiguous numbers; learners address visible indices.
        for letter, order in (('A', 2), ('B', 7), ('C', 11)):
            self.publish_chapter(letter, order)
        course = self.catalog_course()
        self.assertIsNotNone(course)
        self.assertEqual([chapter['title'] for chapter in course['chapters']], ['Manual chapter ' + s for s in 'ABC'])
        self.assertEqual([chapter['orderNo'] for chapter in course['chapters']], [2, 7, 11])
        for chapter, kinds in zip(course['chapters'], (KINDS, ('lecture',), ('slides',))):
            self.assertEqual(set(chapter['resources']), set(kinds))
        self.lesson(3, expect=404)
        self.checkpoint('catalog exposes only published resources and preserves administrator order numbers')

        all_resources = self.lesson(0)
        self.assertEqual(set(all_resources['resourceTypes']), set(KINDS))
        self.assertEqual(set(all_resources['resources']), set(KINDS))
        lecture = all_resources['resources']['lecture']
        self.assertEqual(len(lecture['sections']), 2)
        self.assertIn('Lecture body A', json.dumps(lecture))
        slides = all_resources['resources']['slides']['slides']
        self.assertEqual(len(slides), 2)
        self.assertEqual(slides[0]['title'], 'Slide one A')
        self.assertEqual(slides[0]['bullets'], ['Manual input', 'Manual action'])
        self.assertEqual(slides[0]['notes'], 'Explain the real first slide A.')
        self.assertEqual(all_resources['content']['slides'], slides)
        self.assertEqual(len(all_resources['questions']), 5)
        self.assertEqual(all_resources['questions'], all_resources['resources']['bank']['questions'])
        self.assert_public(all_resources)
        self.assertNotIn('PRIVATE_EXPLANATION', json.dumps(all_resources))
        self.checkpoint('three supported resource payloads contain authored content and no quiz answer leakage')

        reading = self.lesson(1)
        self.assertEqual(set(reading['resourceTypes']), {'lecture'})
        self.assertEqual(reading['questions'], [])
        self.assertEqual(reading['completion'], {'requiresQuiz': False, 'passScore': 60, 'canMarkComplete': True})
        self.assertFalse(self.progress(1)['completed'])
        self.assertTrue(self.progress(1, complete=True)['completed'])
        self.assertTrue(self.lesson(1)['progress']['completed'])
        self.assertTrue(self.catalog_course()['chapters'][1]['done'])
        self.assertTrue(self.progress(1, complete=False)['completed'])
        self.checkpoint('reading-only chapter completes explicitly and stays completed after refresh')

        slide_only = self.lesson(2)
        self.assertEqual(slide_only['resourceTypes'], ['slides'])
        self.assertEqual(set(slide_only['resources']), {'slides'})
        self.assertEqual(slide_only['questions'], [])
        self.assertTrue(self.progress(2, complete=True)['completed'])
        self.checkpoint('slides-only chapter uses its published data without fabricated lecture or quiz entry')

        self.assertEqual(all_resources['completion'], {'requiresQuiz': True, 'passScore': 60, 'canMarkComplete': False})
        self.progress(0, complete=True, expect=409)
        self.assertFalse(self.lesson(0)['progress']['completed'])
        failed = self.quiz(0, correct=2)
        self.assertEqual(failed['score'], 40)
        self.assertFalse(failed['completed'])
        self.progress(0, complete=True, expect=409)
        passed = self.quiz(0, correct=3)
        self.assertEqual(passed['score'], 60)
        self.assertTrue(passed['completed'])
        self.assertTrue(self.lesson(0)['progress']['completed'])
        self.assertTrue(self.catalog_course()['chapters'][0]['done'])
        self.assert_public(self.lesson(0))
        self.checkpoint('quiz completion requires a server-graded score of at least sixty')

        # Simulate already published lessons made by the previous synchronizer:
        # only compatibility sections/slides and quiz_json are present in storage.
        row = self.sql('SELECT lesson_index,content_json FROM lessons WHERE course_id=%s AND source_doc_id=%s',
                       (self.cid, self.doc_ids['A']))[0]
        legacy = json.loads(row['content_json'])
        legacy.pop('resources', None)
        legacy.pop('resourceTypes', None)
        self.sql('UPDATE lessons SET content_json=%s WHERE course_id=%s AND lesson_index=%s',
                 (json.dumps(legacy), self.cid, row['lesson_index']))
        chapters = self.sql('SELECT chapters_json FROM courses WHERE id=%s', (self.cid,))[0]
        legacy_chapters = json.loads(chapters['chapters_json'])
        for chapter in legacy_chapters:
            chapter.pop('resources', None)
            chapter.pop('orderNo', None)
        self.sql('UPDATE courses SET chapters_json=%s WHERE id=%s', (json.dumps(legacy_chapters), self.cid))
        recovered = self.lesson(0)
        self.assertEqual(set(recovered['resourceTypes']), set(KINDS))
        self.assertEqual(len(recovered['resources']['slides']['slides']), 2)
        self.assert_public(recovered)
        self.assertEqual(set(self.catalog_course()['chapters'][0]['resources']), set(KINDS))
        self.assertEqual(self.catalog_course()['chapters'][0]['orderNo'], 2)
        self.checkpoint('already published legacy lessons receive the new learner resource contract')

        before = self.history()
        self.publish_resource('A', 'lecture', False)
        withdrawn = self.lesson(0)
        self.assertNotIn('lecture', withdrawn['resourceTypes'])
        self.assertNotIn('lecture', withdrawn['resources'])
        self.assertNotIn('guide', withdrawn['resourceTypes'])
        self.assertNotIn('guide', withdrawn['resources'])
        self.assertNotIn('lecture', self.catalog_course()['chapters'][0]['resources'])
        self.assertEqual(self.history(), before)
        self.publish_resource('A', 'lecture')
        self.assertEqual(len(self.lesson(0)['resources']['lecture']['sections']), 2)
        self.assertEqual(self.history(), before)
        self.checkpoint('withdrawn resources disappear without clearing saved progress or quiz attempts')

        self.publish_resource('A', 'bank', False)
        no_bank = self.lesson(0)
        self.assertNotIn('bank', no_bank['resourceTypes'])
        self.assertNotIn('bank', no_bank['resources'])
        self.assertEqual(no_bank['questions'], [])
        self.assertFalse(no_bank['completion']['requiresQuiz'])
        self.assertEqual(self.history(), before)
        self.publish_resource('A', 'bank')
        self.assertTrue(self.lesson(0)['progress']['completed'])
        self.assertEqual(self.history(), before)
        self.checkpoint('bank withdrawal removes questions and preserves the previously earned grade')

        self.publish_resource('C', 'slides', False)
        self.assertEqual([chapter['orderNo'] for chapter in self.catalog_course()['chapters']], [2, 7])
        self.lesson(2, expect=404)
        self.assertEqual(self.history(), before)
        self.publish_resource('C', 'slides')
        self.assertTrue(self.lesson(2)['progress']['completed'])
        self.assertEqual(self.history(), before)
        self.checkpoint('chapter with no live resource is hidden and restoration preserves its progress')

        self.call('/admin/kb/bundles/' + self.bid + '/unpublish', self.admin, {})
        self.assertIsNone(self.catalog_course())
        self.lesson(0, expect=404)
        self.assertEqual(self.history(), before)
        self.call('/admin/kb/bundles/' + self.bid + '/publish', self.admin, {})
        self.assertTrue(self.lesson(0)['progress']['completed'])
        self.assertEqual(self.history(), before)
        self.checkpoint('course take-down gates learner access and relisting preserves learning records')

        self.assertEqual(json.dumps(self.call('/admin/kb', self.admin)['settings'], sort_keys=True), self.settings_before)
        self.assertEqual(hashlib.sha256((ROOT / '.env.local').read_bytes()).hexdigest(), self.env_before)
        self.checkpoint('provider settings and ignored environment file remain unchanged')
        report = ROOT / 'data/learner-courseware-report.json'
        report.parent.mkdir(exist_ok=True)
        report.write_text(json.dumps({'fixture': 'manually authored; no model requests', 'passed': len(self.phases),
                                      'checks': self.phases}, ensure_ascii=False, indent=2), encoding='utf-8')

    def cleanup(self):
        try:
            rows = self.sql('SELECT name FROM kb_bundles WHERE id=%s', (self.bid,))
            if rows and rows[0]['name'] == self.name:
                if self.admin:
                    self.call('/admin/kb/bundles/' + self.bid, self.admin, method='DELETE')
                else:
                    self.sql('DELETE FROM kb_bundles WHERE id=%s', (self.bid,))
            for table in ('quiz_attempts', 'lesson_progress', 'lessons'):
                self.sql('DELETE FROM ' + table + ' WHERE course_id=%s', (self.cid,))
            self.sql('DELETE FROM courses WHERE id=%s', (self.cid,))
            for learner in self.learners:
                self.sql('DELETE FROM users WHERE id=%s', (learner['userId'],))
        finally:
            self.db.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
