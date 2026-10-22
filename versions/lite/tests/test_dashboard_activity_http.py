"""Opt-in real activity/ranking regression using disposable anonymous learners."""
import json
import os
from pathlib import Path
import unittest
import urllib.request

import pymysql

ROOT = Path(__file__).resolve().parent.parent
API = os.environ.get('ZHIXUN_TEST_API', 'http://127.0.0.1:8312/api').rstrip('/')


@unittest.skipUnless(os.environ.get('ZHIXUN_TEST_DASHBOARD') == '1', 'Set ZHIXUN_TEST_DASHBOARD=1')
class DashboardActivityTest(unittest.TestCase):
    def call(self, path, learner=None, body=None, method=None):
        request = urllib.request.Request(API + path,
            None if body is None else json.dumps(body).encode(),
            {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + learner['token']} if learner else {})},
            method=method)
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    def sql(self, statement, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(statement, args)
            return cursor.fetchall() if cursor.description else cursor.rowcount

    def setUp(self):
        values = dict(line.split('=', 1) for line in (ROOT / '.env.local').read_text(encoding='utf-8-sig').splitlines()
                      if '=' in line and not line.lstrip().startswith('#'))
        self.assertEqual(values['ZHIXUN_DB_NAME'], 'itn_learning_v2_dev')
        self.db = pymysql.connect(host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
            user=values['ZHIXUN_DB_USER'], password=values['ZHIXUN_DB_PASSWORD'],
            database=values['ZHIXUN_DB_NAME'], charset='utf8mb4', autocommit=True,
            cursorclass=pymysql.cursors.DictCursor)
        self.learners = []
        self.addCleanup(self.cleanup)
        self.learners.extend([self.call('/session', body={}), self.call('/session', body={})])

    def cleanup(self):
        try:
            for learner in self.learners:
                self.sql('DELETE FROM users WHERE id=%s', (learner['userId'],))
        finally:
            self.db.close()

    def test_real_reads_are_deduplicated_and_popularity_counts_unique_learners(self):
        owner, other = self.learners
        initial = self.call('/learner/dashboard', owner)
        resources = initial['popularResources']
        self.assertEqual(initial['activity']['learningDays'], 0)
        self.assertTrue(resources, 'A published resource is required for this local regression')
        item = resources[0]
        baseline = item['learnerCount']
        rows = self.sql('SELECT generation FROM kb_courseware WHERE id=%s', (item['id'],))
        version = rows[0]['generation']
        route = '/courses/' + item['courseId'] + '/lessons/' + str(item['lessonIndex']) + '/progress'
        payload = {'read': True, 'resourceKind': item['kind'], 'resourceVersion': version}
        for _ in range(2):
            self.call(route, owner, payload, 'PUT')
        after = self.call('/learner/dashboard', owner)
        self.assertEqual(after['activity']['learningDays'], 1)
        today = after['activity']['today']
        self.assertEqual(next(day['count'] for day in after['activity']['days'] if day['date'] == today), 1)
        self.assertEqual(self.call('/learner/dashboard', other)['activity']['learningDays'], 0)
        current = next(resource for resource in after['popularResources'] if resource['id'] == item['id'])
        self.assertEqual(current['learnerCount'], baseline + 1)
        self.call(route, other, payload, 'PUT')
        ranked = self.call('/learner/dashboard', owner)['popularResources']
        self.assertEqual(next(resource['learnerCount'] for resource in ranked if resource['id'] == item['id']), baseline + 2)
        counts = [resource['learnerCount'] for resource in ranked]
        self.assertEqual(counts, sorted(counts, reverse=True))
        self.sql('INSERT IGNORE INTO learner_activity_days(user_id,activity_date,course_id,lesson_index,kind) '
                 'VALUES(%s,DATE_SUB(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),INTERVAL 1 DAY),%s,0,%s)',
                 (owner['userId'], 'activity-fixture-history', 'lesson'))
        self.assertEqual(self.call('/learner/dashboard', owner)['activity']['learningDays'], 2)
        self.assertEqual(self.call('/bootstrap', owner)['stats']['learningDays'], 2)


if __name__ == '__main__':
    unittest.main()
