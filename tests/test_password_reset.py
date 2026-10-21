"""Password-reset API regression with isolated users; sends no external mail."""
import concurrent.futures
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
API = os.environ.get('ZHIXUN_TEST_API', 'http://127.0.0.1:8312/api').rstrip('/')


@unittest.skipUnless(os.environ.get('ZHIXUN_TEST_RESET') == '1', 'Set ZHIXUN_TEST_RESET=1')
class PasswordResetTest(unittest.TestCase):
    def sql(self, statement, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(statement, args)
            return cursor.fetchall() if cursor.description else cursor.rowcount

    def call(self, path, body=None, token=None):
        request = urllib.request.Request(API + path,
            None if body is None else json.dumps(body).encode(),
            {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
        try:
            response = urllib.request.urlopen(request, timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def setUp(self):
        values = {}
        for line in (ROOT / '.env.local').read_text(encoding='utf-8-sig').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip()
        self.assertEqual(values['ZHIXUN_DB_NAME'], 'itn_learning_v2_dev')
        self.secret = values.get('ZHIXUN_AUTH_SECRET', '')
        self.db = pymysql.connect(host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
            user=values['ZHIXUN_DB_USER'], password=values['ZHIXUN_DB_PASSWORD'],
            database=values['ZHIXUN_DB_NAME'], charset='utf8mb4', autocommit=True)
        self.user_id = str(uuid.uuid4())
        self.email = 'password-reset-' + self.user_id + '@example.test'
        self.extra_email = 'missing-' + self.email
        self.password = 'BeforeReset123!'
        self.new_password = 'AfterReset456!'
        self.addCleanup(self.cleanup)
        salt = uuid.uuid4().hex
        password_hash = hashlib.sha256((salt + ':' + self.password).encode()).hexdigest()
        self.sql('INSERT INTO users(id,login_key,password_salt,password_hash,display_name,org_id) '
                 'VALUES(%s,%s,%s,%s,%s,%s)', (self.user_id, self.email, salt, password_hash,
                 'Password reset test', '00000000-0000-0000-0000-000000000001'))

    def cleanup(self):
        try:
            self.sql('DELETE FROM email_verification_codes WHERE email IN (%s,%s)', (self.email, self.extra_email))
            self.sql('DELETE FROM users WHERE id=%s', (self.user_id,))
        finally:
            self.db.close()

    def code(self, code='123456', purpose='RESET_PASSWORD', expired=False, consumed=False):
        digest = hashlib.sha256(f'{self.email}:{purpose}:{code}:{self.secret}'.encode()).hexdigest()
        self.sql('INSERT INTO email_verification_codes(id,email,purpose,code_hash,expires_at,consumed_at) '
                 'VALUES(%s,%s,%s,%s,DATE_ADD(NOW(6),INTERVAL %s SECOND),'
                 'IF(%s,NOW(6),NULL))',
                 (str(uuid.uuid4()), self.email, purpose, digest, -60 if expired else 300, consumed))

    def reset(self, code='123456', password=None):
        return self.call('/auth/reset-password', {'email': self.email,
            'verificationCode': code, 'password': password or self.new_password})

    def login(self, password):
        return self.call('/auth/login', {'account': self.email, 'password': password})

    def test_reset_rotates_password_consumes_code_and_revokes_sessions(self):
        _, first = self.login(self.password)
        _, second = self.login(self.password)
        self.code('112233', purpose='LOGIN')
        self.code()
        self.assertEqual(self.reset()[0], 200)
        self.assertEqual(self.login(self.password)[0], 401)
        self.assertEqual(self.login(self.new_password)[0], 200)
        self.assertEqual(self.call('/bootstrap', token=first['token'])[0], 401)
        self.assertEqual(self.call('/bootstrap', token=second['token'])[0], 401)
        self.assertEqual(self.reset()[0], 400)
        self.assertEqual(self.call('/auth/email-login', {'email': self.email, 'verificationCode': '112233'})[0], 400)

    def test_wrong_purpose_expiry_and_attempt_limit(self):
        self.code(purpose='LOGIN')
        self.assertEqual(self.reset()[0], 400, 'A login code must not reset a password')
        self.code(expired=True)
        self.assertEqual(self.reset()[0], 400)
        self.code(consumed=True)
        self.assertEqual(self.reset()[0], 400)
        self.code()
        for _ in range(5):
            self.assertEqual(self.reset('654321')[0], 400)
        self.assertEqual(self.reset()[0], 400, 'A locked code must not become usable again')
        self.assertEqual(self.login(self.password)[0], 200)

    def test_bad_inputs_and_send_cooldown_without_smtp(self):
        self.assertEqual(self.call('/auth/send-code', {'email': self.email, 'purpose': 'UNKNOWN'})[0], 400)
        self.assertEqual(self.call('/auth/send-code', {'email': 'bad\r\n@example.test'})[0], 400)
        self.code()
        self.assertEqual(self.reset('abcdef')[0], 400)
        self.assertEqual(self.reset(password='short')[0], 400)
        self.assertEqual(self.call('/auth/send-code', {'email': self.email, 'purpose': 'RESET_PASSWORD'})[0], 429)
        status, sent = self.call('/auth/send-code', {'email': self.extra_email, 'purpose': 'RESET_PASSWORD'})
        self.assertEqual(status, 200)
        self.assertEqual(sent['retryAfterSeconds'], 60)
        self.assertEqual(self.sql('SELECT id FROM users WHERE login_key=%s', (self.extra_email,)), ())
        self.assertEqual(self.call('/auth/send-code', {'email': self.extra_email, 'purpose': 'RESET_PASSWORD'})[0], 429)
        self.assertEqual(self.reset()[0], 200, 'Malformed requests must not consume a valid challenge')

    def test_concurrent_resets_can_consume_the_challenge_once(self):
        self.code()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(lambda _: self.reset()[0], range(2)))
        self.assertEqual(sorted(statuses), [200, 400])

    def test_email_only_account_can_set_a_password(self):
        self.sql('UPDATE users SET password_hash=NULL,password_salt=NULL WHERE id=%s', (self.user_id,))
        self.assertEqual(self.login(self.password)[0], 401)
        self.code()
        self.assertEqual(self.reset()[0], 200)
        self.assertEqual(self.login(self.new_password)[0], 200)


if __name__ == '__main__':
    unittest.main(verbosity=2)
