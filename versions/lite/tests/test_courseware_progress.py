"""Publication/history regression using manually authored, isolated fixtures.

No model requests, mock providers or saved settings changes. Run against the
native service with ZHIXUN_ADMIN_PASSWORD set; only this test's data is removed.
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


@unittest.skipUnless(os.environ.get('ZHIXUN_ADMIN_PASSWORD'), 'Set ZHIXUN_ADMIN_PASSWORD')
class CoursewareProgressTest(unittest.TestCase):
    def sql(self, text, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(text, args)
            return cursor.fetchall() if cursor.description else cursor.rowcount

    def call(self, route, token=None, body=None, method=None, expect=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(API + route, None if body is None else json.dumps(body).encode(), headers, method=method)
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
        self.admin = self.call('/admin/login', body={'account': os.environ.get('ZHIXUN_ADMIN_ACCOUNT', 'admin'),
                                                   'password': os.environ['ZHIXUN_ADMIN_PASSWORD']})['token']
        self.run_id = str(uuid.uuid4())
        self.bid = str(uuid.uuid4())
        self.cid = 'kb-' + self.bid.replace('-', '')
        self.control = 'control-' + self.run_id[:8]
        self.learners = []
        self.phases = []
        self.doc_ids = {letter: str(uuid.uuid4()) for letter in 'ABC'}
        self.resource_ids = {letter: str(uuid.uuid4()) for letter in 'ABC'}
        self.settings_before = json.dumps(self.call('/admin/kb', self.admin)['settings'], sort_keys=True)
        self.sql('INSERT INTO kb_bundles(id,name,bytes,status,title,source_saved) VALUES(%s,%s,0,%s,%s,1)',
                 (self.bid, 'progress-fixture-' + self.run_id, 'ready', '自动验收：学习记录保留'))
        for position, letter in enumerate('ABC'):
            text = '# Chapter ' + letter + '\n\nManually authored regression material.\n'
            self.sql('INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count,original_content,source_path) '
                     'VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                     (self.doc_ids[letter], self.bid, position, 'Chapter ' + letter, text, len(text), text, letter + '.md'))
            self.sql('INSERT INTO kb_courseware(id,bundle_id,doc_id,kind,title,status,published,content_json,model) '
                     'VALUES(%s,%s,%s,%s,%s,%s,0,%s,%s)',
                     (self.resource_ids[letter], self.bid, self.doc_ids[letter], 'bank', 'Bank ' + letter,
                      'ready', json.dumps(self.bank(letter, 0)), 'manually-authored-regression-fixture'))

    @staticmethod
    def bank(letter, correct):
        return {'questions': [{'id': 'shared-question', 'stem': 'Question ' + letter, 'options': ['Yes', 'No'],
                               'correctIndex': correct, 'explanation': 'Authored explanation.', 'knowledgePointId': letter}]}

    def publish_resource(self, letter, live=True):
        return self.call('/admin/kb/courseware/' + self.resource_ids[letter] + ('/publish' if live else '/unpublish'), self.admin, {})

    def publish_chapter(self, letter, order):
        return self.call('/admin/kb/courseware/chapters/' + self.doc_ids[letter] + '/publish', self.admin,
                         {'bundleId': self.bid, 'order': order})

    def lesson(self, index, learner=0, expect=None):
        return self.call('/courses/' + self.cid + '/lessons/' + str(index), self.learners[learner]['token'], expect=expect)

    def quiz(self, index, attempt, choice=0, learner=0, expect=None):
        return self.call('/courses/' + self.cid + '/lessons/' + str(index) + '/quiz', self.learners[learner]['token'],
                         {'attemptId': attempt, 'answers': [{'questionId': 'shared-question', 'choice': choice}], 'durationSeconds': 12}, expect=expect)

    def history(self, course=None):
        course = course or self.cid
        result = {}
        for table in ('lesson_progress', 'quiz_attempts'):
            result[table] = self.sql('SELECT * FROM ' + table + ' WHERE course_id=%s ORDER BY user_id,lesson_index', (course,))
        return hashlib.sha256(json.dumps(result, sort_keys=True, default=str).encode()).hexdigest()

    def checkpoint(self, label):
        self.phases.append(label)
        print('PASSED:', label, flush=True)

    def test_history_is_bound_to_chapters_until_explicit_deletion(self):
        self.call('/admin/kb/bundles/' + self.bid + '/publish', self.admin, {})
        for letter in 'AB':
            self.publish_resource(letter)
        # Reproduce pre-migration lessons: no source_doc_id or display_index.
        for index, letter in enumerate('AB'):
            quiz = [{'id': 'shared-question', 'question': 'Question ' + letter, 'options': ['Yes', 'No'],
                     'correct': 0, 'explanation': 'Authored explanation.'}]
            self.sql('INSERT INTO lessons(course_id,lesson_index,title,content_json,quiz_json,sources_json) VALUES(%s,%s,%s,%s,%s,%s)',
                     (self.cid, index, 'Chapter ' + letter, '{}', json.dumps(quiz),
                      json.dumps([{'id': self.doc_ids[letter], 'kind': 'kb-courseware'}])))
            self.sql('INSERT INTO kb_courseware_chapters(bundle_id,doc_id,order_no) VALUES(%s,%s,%s)',
                     (self.bid, self.doc_ids[letter], index + 1))
        self.sql('UPDATE courses SET chapters_json=%s WHERE id=%s', (json.dumps([{'title': 'Chapter A'}, {'title': 'Chapter B'}]), self.cid))
        for _ in range(2):
            self.learners.append(self.call('/session', body={}))
        attempt = str(uuid.uuid4())
        self.assertEqual(self.quiz(0, attempt)['score'], 100)
        self.call('/courses/' + self.cid + '/lessons/1/progress', self.learners[0]['token'], {'read': True}, 'PUT')
        self.assertEqual(self.quiz(1, str(uuid.uuid4()), choice=1, learner=1)['score'], 0)
        before = self.history()

        self.publish_chapter('A', 1)
        self.assertEqual(self.history(), before)
        self.assertTrue(self.lesson(0)['progress']['completed'])
        self.checkpoint('legacy binding keeps existing records and timestamps')

        self.call('/admin/kb/bundles/' + self.bid + '?metadata=1', self.admin)
        self.call('/admin/kb/courseware?bundleId=' + self.bid, self.admin)
        self.call('/admin/kb/courseware/chapters?bundleId=' + self.bid, self.admin)
        self.assertEqual(self.history(), before)
        self.checkpoint('page and knowledge-base selection perform no learning reset')

        self.sql('UPDATE kb_courseware SET content_json=%s WHERE id=%s', (json.dumps(self.bank('A', 1)), self.resource_ids['A']))
        self.publish_resource('A')
        replay = self.quiz(0, attempt, choice=1)
        self.assertEqual((replay['score'], replay['correctCount'], replay['total']), (100, 1, 1))
        self.assertEqual(self.history(), before)
        self.checkpoint('resource updates and attempt replay preserve the original grade')

        self.publish_chapter('A', 5)
        self.assertEqual(self.lesson(1)['title'], 'Chapter A')
        self.assertEqual(self.lesson(1)['progress']['score'], 100)
        self.assertIsNone(self.lesson(0)['progress']['score'])
        self.assertEqual(self.lesson(0, learner=1)['progress']['score'], 0)
        self.quiz(0, attempt, expect=409)
        self.assertEqual(self.quiz(1, attempt)['score'], 100)
        self.assertEqual(self.history(), before)
        self.checkpoint('reordering keeps identities and rejects cross-chapter attempt replay')

        self.publish_resource('C')
        self.publish_chapter('C', 3)
        self.assertEqual(self.lesson(2)['title'], 'Chapter A')
        self.assertEqual(self.lesson(2)['progress']['score'], 100)
        self.assertEqual(self.quiz(1, str(uuid.uuid4()), choice=1)['score'], 0)
        self.assertIsNone(self.lesson(0)['progress']['score'])
        before = self.history()
        self.checkpoint('inserting a chapter does not move grades to another chapter')

        self.call('/admin/kb/courseware/chapters/' + self.doc_ids['A'] + '/unpublish', self.admin, {'bundleId': self.bid})
        self.lesson(2, expect=404)
        self.assertEqual(self.history(), before)
        self.publish_chapter('A', 5)
        self.assertEqual(self.lesson(2)['progress']['score'], 100)
        self.assertEqual(self.history(), before)
        self.checkpoint('chapter take-down and restoration retain all history')

        self.publish_resource('A', False)
        self.lesson(2, expect=404)
        self.publish_resource('A')
        self.assertEqual(self.lesson(2)['progress']['score'], 100)
        self.assertEqual(self.history(), before)
        self.checkpoint('resource withdrawal hides content while retaining history')

        for letter in 'ABC':
            self.publish_resource(letter, False)
        catalog = self.call('/courses', self.learners[0]['token'])['courses']
        self.assertFalse(any(course['id'] == self.cid for course in catalog))
        self.lesson(0, expect=404)
        self.assertEqual(self.history(), before)
        for letter in 'ABC':
            self.publish_resource(letter)
        self.assertEqual(self.lesson(2)['progress']['score'], 100)
        self.assertEqual(self.history(), before)
        self.checkpoint('no published resources hides the course without deleting records')

        self.call('/admin/kb/bundles/' + self.bid + '/unpublish', self.admin, {})
        self.lesson(0, expect=404)
        self.assertEqual(self.history(), before)
        self.call('/admin/kb/bundles/' + self.bid + '/publish', self.admin, {})
        self.assertEqual(self.lesson(2)['progress']['score'], 100)
        self.assertEqual(self.history(), before)
        self.checkpoint('course take-down and relisting retain records')

        # A separate course proves explicit deletion is scoped to this knowledge base.
        self.sql('INSERT INTO courses(id,name,icon,description,level,duration,chapters_json,source_label,status) '
                 'VALUES(%s,%s,%s,%s,%s,1,%s,%s,%s)', (self.control, 'Unrelated control', '', '', 'test', '[]', 'regression', 'draft'))
        self.sql('INSERT INTO lessons(course_id,lesson_index,title,content_json,quiz_json,sources_json) VALUES(%s,0,%s,%s,%s,%s)',
                 (self.control, 'Control', '{}', '[]', '[]'))
        self.sql('INSERT INTO lesson_progress(user_id,course_id,lesson_index,is_read,score,completed,updated_at) VALUES(%s,%s,0,1,77,1,NOW(6))',
                 (self.learners[0]['userId'], self.control))
        control = self.history(self.control)
        self.call('/admin/kb/bundles/' + self.bid, self.admin, method='DELETE')
        for table in ('lesson_progress', 'quiz_attempts', 'lessons', 'courses'):
            key = 'id' if table == 'courses' else 'course_id'
            self.assertEqual(self.sql('SELECT COUNT(*) n FROM ' + table + ' WHERE ' + key + '=%s', (self.cid,))[0]['n'], 0)
        self.assertEqual(self.history(self.control), control)
        self.assertEqual(json.dumps(self.call('/admin/kb', self.admin)['settings'], sort_keys=True), self.settings_before)
        self.checkpoint('explicit knowledge-base deletion clears only its own learning records')
        (ROOT / 'data/courseware-progress-report.json').write_text(json.dumps({'passed': len(self.phases), 'checks': self.phases}), encoding='utf-8')

    def tearDown(self):
        try:
            rows = self.sql('SELECT name FROM kb_bundles WHERE id=%s', (self.bid,))
            if rows and rows[0]['name'] == 'progress-fixture-' + self.run_id:
                self.call('/admin/kb/bundles/' + self.bid, self.admin, method='DELETE')
            for course in (self.cid, self.control):
                for table in ('quiz_attempts', 'lesson_progress', 'lessons'):
                    self.sql('DELETE FROM ' + table + ' WHERE course_id=%s', (course,))
                self.sql('DELETE FROM courses WHERE id=%s', (course,))
            for learner in self.learners:
                self.sql('DELETE FROM users WHERE id=%s', (learner['userId'],))
        finally:
            self.db.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
