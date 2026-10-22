"""Opt-in HTTP/MySQL regression; creates anonymous fixture users and calls no model.

Apply migration 022 and build/restart the service before running:
ZHIXUN_TEST_TUTOR_CONVERSATIONS=1 python -m unittest discover -s tests -p test_tutor_conversations.py -v
"""
import json
import os
from pathlib import Path
import unittest
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parent.parent
API = os.environ.get('ZHIXUN_TEST_API', 'http://localhost:3006/api').rstrip('/')


@unittest.skipUnless(os.environ.get('ZHIXUN_TEST_TUTOR_CONVERSATIONS') == '1',
                     'Set ZHIXUN_TEST_TUTOR_CONVERSATIONS=1')
class TutorConversationsTest(unittest.TestCase):
    def call(self, route, learner=None, body=None, method=None, expect=200):
        headers = {'Content-Type': 'application/json'}
        if learner:
            headers['Authorization'] = 'Bearer ' + learner['token']
        data = None if body is None else json.dumps(body, ensure_ascii=True).encode()
        request = urllib.request.Request(API + route, data, headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            result = json.loads(raw) if raw else {}
            self.assertEqual(response.status, expect, (route, result))
            return result

    def sql(self, statement, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(statement, args)
            return cursor.fetchall() if cursor.description else cursor.rowcount

    def setUp(self):
        import pymysql
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
        self.learners = []
        self.addCleanup(self.cleanup)
        for _ in range(2):
            self.learners.append(self.call('/session', body={}))

    def cleanup(self):
        try:
            # IDs come exclusively from this test's own successful anonymous session creations.
            for learner in self.learners:
                self.sql('DELETE FROM users WHERE id=%s', (learner['userId'],))
        finally:
            self.db.close()

    def listing(self, learner, archived=False):
        value = self.call('/tutor/conversations?archived=' + str(archived).lower(), learner)
        self.assertEqual(value['items'], value['conversations'])
        self.assertLessEqual(len(value['items']), 100)
        return {item['conversationId']: item for item in value['items']}

    def patch(self, learner, conversation_id, body, expect=200):
        return self.call('/tutor/conversations/' + conversation_id, learner, body, 'PUT', expect)

    def message(self, learner, conversation_id, role, content, seconds):
        self.sql('INSERT INTO tutor_messages(id,user_id,conversation_id,role,content,created_at) '
                 'VALUES(%s,%s,%s,%s,%s,DATE_ADD(%s,INTERVAL %s SECOND))',
                 (str(uuid.uuid4()), learner['userId'], conversation_id, role, content,
                  '2020-01-01 00:00:00', seconds))

    def test_empty_session_rename_archive_restore_and_owner_isolation(self):
        owner, other = self.learners
        created = self.call('/tutor/conversations', owner, {})
        cid = created['conversationId']
        self.assertEqual(created['messageCount'], 0)
        self.assertEqual(created['courseId'], '')
        self.assertEqual(created['lessonIndex'], -1)
        self.assertIn(cid, self.listing(owner))
        self.assertNotIn(cid, self.listing(other))
        self.patch(other, cid, {'title': 'must not change'}, expect=404)
        self.patch(other, cid, {'archived': True}, expect=404)
        self.call('/tutor/conversations/' + cid, other, method='DELETE', expect=404)
        title = '\u5b66' * 63 + '\U0001f600'
        self.assertEqual(self.patch(owner, cid, {'title': title})['title'], title)
        self.assertTrue(self.patch(owner, cid, {'archived': True})['archived'])
        self.assertNotIn(cid, self.listing(owner))
        self.assertEqual(self.listing(owner, True)[cid]['title'], title)
        self.assertFalse(self.patch(owner, cid, {'archived': False})['archived'])
        for body in ({}, {'title': ''}, {'title': '\u5b66' * 65}, {'title': 12},
                     {'title': 'a\x00b'}, {'archived': 'true'}, {'archived': 1}, {'archived': None}):
            self.patch(owner, cid, body, expect=400)
        self.call('/tutor/conversations/' + cid, owner, method='DELETE')
        self.assertNotIn(cid, self.listing(owner))
        self.call('/tutor/conversations/' + cid, owner, method='DELETE', expect=404)

    def test_unbackfilled_legacy_first_user_title_and_scoped_deletion(self):
        owner, other = self.learners
        cid = 'legacy-test-' + str(uuid.uuid4())
        self.message(owner, cid, 'user', '\u7b2c\u4e00\u95ee', 0)
        self.message(owner, cid, 'assistant', 'answer', 1)
        self.message(owner, cid, 'user', '\u6700\u540e\u4e00\u95ee', 2)
        self.message(other, cid, 'user', 'other owner', 3)
        self.assertEqual(self.sql('SELECT * FROM tutor_conversations WHERE user_id=%s AND conversation_id=%s',
                                  (owner['userId'], cid)), ())
        item = self.listing(owner)[cid]
        self.assertEqual(item['title'], '\u7b2c\u4e00\u95ee')
        self.assertEqual(item['preview'], '\u6700\u540e\u4e00\u95ee')
        self.assertEqual(item['messageCount'], 3)
        self.patch(owner, cid, {'archived': True, 'title': 'custom'})
        self.assertNotIn(cid, self.listing(owner))
        self.message(owner, cid, 'assistant', 'new reply', 4)
        self.assertEqual(self.listing(owner, True)[cid]['title'], 'custom')
        self.call('/tutor/conversations/' + cid, owner, method='DELETE')
        self.assertEqual(self.sql('SELECT COUNT(*) n FROM tutor_messages WHERE user_id=%s AND conversation_id=%s',
                                  (owner['userId'], cid))[0]['n'], 0)
        self.assertEqual(self.listing(other)[cid]['title'], 'other owner')
        self.call('/tutor/conversations/' + cid, other, method='DELETE')

    def test_course_session_persists_before_messages_and_uses_server_names(self):
        rows = self.sql("SELECT c.id,c.name,l.title,COALESCE(l.display_index,l.lesson_index) lesson_index "
                        "FROM courses c JOIN lessons l ON l.course_id=c.id "
                        "WHERE c.status='published' AND l.is_visible=1 ORDER BY c.id,l.lesson_index LIMIT 1")
        if not rows:
            self.skipTest('No published visible lesson available for read-only course-context fixture')
        course = rows[0]
        owner = self.learners[0]
        body = {'courseId': course['id'], 'lessonIndex': course['lesson_index'],
                'lessonTitle': 'untrusted lesson title', 'title': 'untrusted conversation title'}
        first = self.call('/tutor/conversations', owner, body)
        second = self.call('/tutor/conversations', owner, body)
        self.assertNotEqual(first['conversationId'], second['conversationId'])
        items = self.listing(owner)
        for created in (first, second):
            for item in (created, items[created['conversationId']]):
                self.assertEqual(item['courseId'], course['id'])
                self.assertEqual(item['lessonIndex'], course['lesson_index'])
                self.assertEqual(item['courseName'], course['name'])
                self.assertEqual(item['lessonTitle'], course['title'])
                self.assertEqual(item['title'], course['name'] + ' \u00b7 ' + course['title'])
                self.assertEqual(item['messageCount'], 0)
        self.call('/tutor/conversations', owner, {'courseId': 'missing-' + str(uuid.uuid4())}, expect=404)
        self.call('/tutor/conversations', owner, {'lessonIndex': 0}, expect=400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
