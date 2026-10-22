"""Real organization-invite / brand regression with isolated manual fixtures.

No outbound email, model request, saved provider change, or existing-brand edit.
Only uniquely named test organizations, users, sessions and exact logo files are
removed. Set ZHIXUN_ADMIN_PASSWORD before running against the native dev service.
"""
import hashlib
import json
import os
from pathlib import Path
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

import pymysql


ROOT = Path(__file__).resolve().parent.parent
API = os.environ.get('ZHIXUN_TEST_API', 'http://localhost:3006/api').rstrip('/')


@unittest.skipUnless(os.environ.get('ZHIXUN_ADMIN_PASSWORD'), 'Set ZHIXUN_ADMIN_PASSWORD')
class OrganizationInvitesTest(unittest.TestCase):
    def sql(self, statement, args=()):
        with self.db.cursor() as cursor:
            cursor.execute(statement, args)
            return cursor.fetchall() if cursor.description else cursor.rowcount

    def request(self, route, token=None, body=None, method=None, expect=None, content_type=None):
        if route.startswith(('http://', 'https://')):
            url = route
        elif route.startswith('/api/'):
            url = urllib.parse.urljoin(API, route)
        else:
            url = API + route
        headers = {'Content-Type': content_type or 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        payload = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, payload, headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            allowed = tuple(expect) if isinstance(expect, (tuple, list, set)) else (expect,) if expect is not None else None
            if allowed is None:
                self.assertTrue(200 <= response.status < 300, (method or 'GET', route, response.status, raw[:500]))
            else:
                self.assertIn(response.status, allowed, (method or 'GET', route, response.status, raw[:500]))
            return raw, dict(response.headers)

    def call(self, route, token=None, body=None, method=None, expect=None, content_type=None):
        raw, _ = self.request(route, token, body, method, expect, content_type)
        return json.loads(raw) if raw else {}

    @staticmethod
    def brand(response):
        return response.get('organization', response)

    def remember_session(self, response, own_user=False):
        self.sessions.add(response['token'])
        if own_user:
            self.user_ids.add(response['userId'])
        return response

    def checkpoint(self, label):
        self.phases.append(label)
        print('PASSED:', label, flush=True)

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
        self.suffix = uuid.uuid4().hex
        self.prefix = 'org-invite-manual-fixture-' + self.suffix
        self.names = {letter: self.prefix + '-' + letter for letter in ('A', 'B', 'duplicate', 'invalid')}
        self.invites = {letter: 'T' + self.suffix[:20].upper() + '-' + letter for letter in ('A', 'B', 'C')}
        self.password = 'Manual-fixture-' + self.suffix[:16]
        self.orgs = {}
        self.user_ids = set()
        self.sessions = set()
        self.logins = set()
        self.emails = set()
        self.logo_files = set()
        self.phases = []
        self.admin = None
        self.default_id = None
        self.auth_secret = values.get('ZHIXUN_AUTH_SECRET', '')
        self.env_before = hashlib.sha256((ROOT / '.env.local').read_bytes()).hexdigest()
        self.addCleanup(self.cleanup)
        session = self.remember_session(self.call('/admin/login', body={
            'account': os.environ.get('ZHIXUN_ADMIN_ACCOUNT', 'admin'), 'password': os.environ['ZHIXUN_ADMIN_PASSWORD']}))
        self.admin = session['token']
        self.default = self.brand(self.call('/admin/org', self.admin))
        self.default_id = self.default['id']
        self.default_before = self.digest(self.default)
        self.settings_before = self.digest(self.call('/admin/kb', self.admin)['settings'])

    @staticmethod
    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()

    def org_route(self, org_id, logo=False):
        return '/admin/org' + ('/logo' if logo else '') + '?orgId=' + urllib.parse.quote(str(org_id), safe='')

    def create_org(self, letter):
        response = self.call('/admin/orgs', self.admin,
                             {'name': self.names[letter], 'shortName': 'Manual ' + letter,
                              'inviteCode': '  ' + self.invites[letter].lower() + '  '})
        org = self.brand(response)
        self.assertTrue(org.get('id') is not None and org['id'] != self.default_id, 'Create must return a distinct organization')
        self.orgs[letter] = org
        self.assertTrue(org.get('inviteCode') == self.invites[letter], 'Invitation normalization must trim and uppercase')
        detail = self.brand(self.call(self.org_route(org['id']), self.admin))
        self.assertEqual(detail['id'], org['id'])
        self.assertEqual(detail['name'], self.names[letter])
        return org

    def register(self, label, invite=None, token=None, expect=None):
        account = self.prefix + '-' + label
        self.logins.add(account)
        body = {'account': account, 'password': self.password, 'displayName': 'Manual invite user'}
        if invite is not None:
            body['inviteCode'] = invite
        response = self.call('/auth/register', token, body, expect=expect)
        if 'token' in response:
            self.remember_session(response, own_user=True)
        return account, response

    def assert_user_org(self, user_id, org_id):
        rows = self.sql('SELECT org_id FROM users WHERE id=%s', (user_id,))
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0]['org_id']), str(org_id))

    def assert_no_account(self, account):
        self.assertEqual(self.sql('SELECT COUNT(*) n FROM users WHERE login_key=%s', (account,))[0]['n'], 0)

    def public_brand(self, token=None):
        public = self.brand(self.call('/org', token))
        def check(value):
            if isinstance(value, dict):
                self.assertTrue(all('invite' not in key.lower() for key in value), 'Public branding exposes invite fields')
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        check(public)
        raw = json.dumps(public)
        self.assertTrue(all(code not in raw for code in self.invites.values()), 'Public branding exposes an invitation value')
        return public

    def make_email_code(self, label):
        email = self.prefix + '-' + label + '@example.com'
        self.logins.add(email)
        self.emails.add(email)
        code = '246810'
        identifier = str(uuid.uuid4())
        digest = hashlib.sha256((email + ':LOGIN:' + code + ':' + self.auth_secret).encode()).hexdigest()
        self.sql('INSERT INTO email_verification_codes(id,email,purpose,code_hash,created_at,expires_at) '
                 "VALUES(%s,%s,'LOGIN',%s,NOW(6),DATE_ADD(NOW(6),INTERVAL 10 MINUTE))", (identifier, email, digest))
        return email, code, identifier

    def email_login(self, email, code, invite=None, expect=None):
        body = {'email': email, 'verificationCode': code}
        if invite is not None:
            body['inviteCode'] = invite
        response = self.call('/auth/email-login', body=body, expect=expect)
        if 'token' in response:
            self.remember_session(response, own_user=True)
        return response

    def assert_code_unconsumed(self, identifier):
        row = self.sql('SELECT consumed_at FROM email_verification_codes WHERE id=%s', (identifier,))[0]
        self.assertIsNone(row['consumed_at'])

    @staticmethod
    def logo(color, label):
        return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
                '<title>Manual fixture ' + label + '</title><rect x="2" y="2" width="44" height="44" rx="8" fill="' +
                color + '"/></svg>').encode()

    def upload_logo(self, letter, content):
        org_id = self.orgs[letter]['id']
        # Confirm identity before any write; an unsupported query must never edit
        # the default organization by silently falling back to its settings.
        detail = self.brand(self.call(self.org_route(org_id), self.admin))
        self.assertEqual(detail['id'], org_id)
        self.assertEqual(detail['name'], self.names[letter])
        response = self.brand(self.call(self.org_route(org_id, logo=True), self.admin, content,
                                       content_type='image/svg+xml'))
        self.assertEqual(response['id'], org_id)
        return response

    def test_registration_membership_and_brand_isolation(self):
        self.assertEqual(self.public_brand()['id'], self.default_id)
        self.assertEqual(self.default['name'], '江南大学')
        self.call('/admin/orgs', expect=401)
        self.create_org('A')
        self.create_org('B')
        organizations = self.call('/admin/orgs', self.admin)['organizations']
        self.assertTrue(all(any(str(item['id']) == str(self.orgs[letter]['id']) for item in organizations) for letter in 'AB'))
        self.call('/admin/orgs', self.admin,
                  {'name': self.names['duplicate'], 'shortName': 'Duplicate', 'inviteCode': self.invites['A']}, expect=(400, 409))
        self.call('/admin/orgs', self.admin,
                  {'name': self.names['invalid'], 'shortName': 'Invalid', 'inviteCode': ''}, expect=400)
        self.checkpoint('distinct organizations are created with normalized unique invitations; admin APIs require authentication')

        for label, invite in (('missing', None), ('invalid', 'INVALID-' + self.suffix[:20]), ('empty', '   ')):
            account, _ = self.register(label, invite, expect=400)
            self.assert_no_account(account)
        account_a, user_a = self.register('member-a', self.invites['A'].lower())
        _, second_a = self.register('member-a-2', ' ' + self.invites['A'] + ' ')
        account_b, user_b = self.register('member-b', self.invites['B'])
        self.assert_user_org(user_a['userId'], self.orgs['A']['id'])
        self.assert_user_org(second_a['userId'], self.orgs['A']['id'])
        self.assert_user_org(user_b['userId'], self.orgs['B']['id'])
        self.call('/admin/orgs', user_a['token'], expect=403)
        self.checkpoint('missing or invalid invitation creates no account; one valid invitation admits multiple members')

        logo_a = self.logo('#8b5cf6', 'A')
        logo_b = self.logo('#14b8a6', 'B')
        self.upload_logo('A', logo_a)
        self.upload_logo('B', logo_b)
        public_a = self.public_brand(user_a['token'])
        public_b = self.public_brand(user_b['token'])
        self.assertEqual(public_a['id'], self.orgs['A']['id'])
        self.assertEqual(public_b['id'], self.orgs['B']['id'])
        self.assertEqual(self.public_brand(second_a['token']), public_a)
        self.assertTrue(public_a['hasLogo'] and public_b['hasLogo'])
        self.assertNotEqual(public_a['logoUrl'], public_b['logoUrl'])
        for public, expected in ((public_a, logo_a), (public_b, logo_b)):
            self.assertTrue(str(public['id']) in public['logoUrl'], 'Public logo URL must identify its organization')
            raw, headers = self.request(public['logoUrl'])
            self.assertEqual(raw, expected)
            normalized_headers = {str(key).lower(): value for key, value in headers.items()}
            self.assertIn('image/svg+xml', normalized_headers.get('content-type', ''))
        self.assertEqual(self.public_brand(user_a['token'])['id'], self.orgs['A']['id'])
        self.assertEqual(self.public_brand(user_b['token'])['id'], self.orgs['B']['id'])
        self.checkpoint('members share their own organization logo; switching accounts does not leak branding or invitations')

        updated_logo = self.logo('#f59e0b', 'A replacement')
        self.upload_logo('A', updated_logo)
        replaced = self.public_brand(user_a['token'])
        self.assertNotEqual(replaced['logoUrl'], public_a['logoUrl'])
        self.assertEqual(self.request(replaced['logoUrl'])[0], updated_logo)
        self.assertEqual(self.public_brand(user_b['token'])['logoUrl'], public_b['logoUrl'])
        self.assertEqual(self.request(public_b['logoUrl'])[0], logo_b)
        self.checkpoint('replacing a logo changes its content version without changing another organization cache key')

        normal = self.remember_session(self.call('/auth/login', body={'account': account_a, 'password': self.password}))
        self.assertEqual(normal['userId'], user_a['userId'])
        alternate = self.remember_session(self.call('/auth/login', body={
            'account': account_a, 'password': self.password, 'inviteCode': self.invites['B']}))
        self.assert_user_org(alternate['userId'], self.orgs['A']['id'])
        self.assertEqual(self.public_brand(alternate['token'])['id'], self.orgs['A']['id'])
        legacy = self.remember_session(self.call('/auth/login', body={
            'account': os.environ.get('ZHIXUN_ADMIN_ACCOUNT', 'admin'), 'password': os.environ['ZHIXUN_ADMIN_PASSWORD']}))
        self.assert_user_org(legacy['userId'], self.default_id)
        self.assertEqual(self.public_brand(legacy['token'])['id'], self.default_id)
        self.assertEqual(self.sql("SELECT COUNT(*) n FROM users WHERE org_id IS NULL OR org_id='' ")[0]['n'], 0)
        self.checkpoint('existing password accounts log in without invitation and keep their original organization')

        guest = self.remember_session(self.call('/auth/guest', body={}), own_user=True)
        anonymous = self.remember_session(self.call('/session', body={}), own_user=True)
        for session in (guest, anonymous):
            self.assert_user_org(session['userId'], self.default_id)
            self.assertIsNone(self.sql('SELECT login_key FROM users WHERE id=%s', (session['userId'],))[0]['login_key'])
            account, _ = self.register('guest-bypass-' + session['userId'][:8], token=session['token'], expect=400)
            self.assert_no_account(account)
        self.checkpoint('guest and anonymous sessions default to Jiangnan and cannot bypass formal registration invitations')

        email, code, identifier = self.make_email_code('email-first')
        self.email_login(email, code, expect=400)
        self.assert_no_account(email)
        self.assert_code_unconsumed(identifier)
        self.email_login(email, code, 'INVALID-' + self.suffix[:20], expect=400)
        self.assert_no_account(email)
        self.assert_code_unconsumed(identifier)
        self.email_login(email, '000000', self.invites['A'], expect=400)
        self.assert_code_unconsumed(identifier)
        email_user = self.email_login(email, code, self.invites['A'])
        self.assert_user_org(email_user['userId'], self.orgs['A']['id'])
        self.assertIsNotNone(self.sql('SELECT consumed_at FROM email_verification_codes WHERE id=%s', (identifier,))[0]['consumed_at'])
        self.email_login(email, code, self.invites['A'], expect=400)
        self.checkpoint('first email login requires invitation and consumes a valid verification code only after all validation')

        _, code_again, _ = self.make_email_code('email-first')
        existing_email = self.email_login(email, code_again)
        self.assertEqual(existing_email['userId'], email_user['userId'])
        _, code_third, _ = self.make_email_code('email-first')
        existing_email = self.email_login(email, code_third, self.invites['B'])
        self.assert_user_org(existing_email['userId'], self.orgs['A']['id'])
        self.assertEqual(self.public_brand(existing_email['token'])['id'], self.orgs['A']['id'])
        self.checkpoint('existing email accounts need no invitation and cannot use another organization code to move membership')

        duplicate_body = {'name': self.names['B'], 'shortName': 'Manual B', 'inviteCode': self.invites['A']}
        self.call(self.org_route(self.orgs['B']['id']), self.admin, duplicate_body, 'PUT', expect=(400, 409))
        detail_b = self.brand(self.call(self.org_route(self.orgs['B']['id']), self.admin))
        self.assertTrue(detail_b['inviteCode'] == self.invites['B'], 'Failed rotation must preserve the existing invitation')
        rotation = {'name': self.names['A'], 'shortName': 'Manual A', 'inviteCode': self.invites['C']}
        rotated = self.brand(self.call(self.org_route(self.orgs['A']['id']), self.admin, rotation, 'PUT'))
        self.assertTrue(rotated['inviteCode'] == self.invites['C'], 'The new invitation must be saved')
        account, _ = self.register('old-code-after-rotation', self.invites['A'], expect=400)
        self.assert_no_account(account)
        _, rotated_user = self.register('new-code-after-rotation', self.invites['C'])
        self.assert_user_org(rotated_user['userId'], self.orgs['A']['id'])
        for user in (user_a, second_a, email_user):
            self.assert_user_org(user['userId'], self.orgs['A']['id'])
            self.assertEqual(self.public_brand(user['token'])['id'], self.orgs['A']['id'])
        self.assert_user_org(user_b['userId'], self.orgs['B']['id'])
        self.checkpoint('invitation rotation invalidates the old code while retaining every existing member and other organization')

        self.assertEqual(self.digest(self.brand(self.call('/admin/org', self.admin))), self.default_before)
        self.assertEqual(self.digest(self.call('/admin/kb', self.admin)['settings']), self.settings_before)
        self.assertEqual(hashlib.sha256((ROOT / '.env.local').read_bytes()).hexdigest(), self.env_before)
        self.checkpoint('existing Jiangnan branding and invitation, model settings, and local environment remain unchanged')
        self.write_report()

    def write_report(self, cleanup=None):
        report = ROOT / 'data/org-invites-report.json'
        report.parent.mkdir(exist_ok=True)
        content = {'fixture': 'isolated manual organizations; no email or model requests',
                   'passed': len(self.phases), 'checks': self.phases}
        if cleanup is not None:
            content['cleanup'] = cleanup
        report.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding='utf-8')

    def cleanup(self):
        try:
            # Exact UUID/user-login scope; never remove existing account sessions
            # except for tokens issued by this test itself.
            for email in self.emails:
                self.sql('DELETE FROM email_verification_codes WHERE email=%s', (email,))
            for login in self.logins:
                self.sql('DELETE FROM users WHERE login_key=%s', (login,))
            for user_id in self.user_ids:
                self.sql('DELETE FROM users WHERE id=%s', (user_id,))
            # The backend's organization table and precise file path are filled
            # in from its migration contract before this test is run.
            for org in self.orgs.values():
                org_id = str(org['id'])
                self.assertNotEqual(org_id, str(self.default_id))
                self.assertRegex(org_id, r'^[A-Za-z0-9_-]+$')
                detail = self.brand(self.call(self.org_route(org_id), self.admin))
                self.assertIn(detail['name'], self.names.values())
                self.call(self.org_route(org_id, logo=True), self.admin, method='DELETE')
                self.sql('DELETE FROM organizations WHERE id=%s AND name=%s', (org_id, detail['name']))
            for logo in self.logo_files:
                resolved = logo.resolve()
                self.assertTrue(resolved.is_relative_to((ROOT / 'data').resolve()), 'Logo cleanup must stay within the test workspace data')
                self.assertNotEqual(resolved, (ROOT / 'data/org/logo.bin').resolve())
                resolved.unlink(missing_ok=True)
            for token in self.sessions:
                self.sql('DELETE FROM user_sessions WHERE token_hash=%s', (hashlib.sha256(token.encode()).hexdigest(),))
            self.write_report({'temporaryOrganizations': 0, 'temporaryUsers': 0, 'exactLogoFilesRemoved': True})
        finally:
            self.db.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
