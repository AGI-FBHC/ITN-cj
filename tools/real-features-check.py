# -*- coding: utf-8 -*-
"""真实模型案例测试：用 Lumin 里配置的真实对话模型，在隔离数据目录里把近期功能逐项跑通。

覆盖：基础对话 / 流式长回复 / 图片识别 / lumin://thread 会话读取 / 项目内文件附件 /
学习记忆 / 学习资源生成（含引用与质检）。只读用户配置（不打印密钥），所有写入都在临时目录，
不碰用户数据库。

用法：
    python tools/real-features-check.py                # 全部
    python tools/real-features-check.py --case chat,vision
"""
import json, os, re, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / 'dist/core/itn-desktop-core.exe'
UI = ROOT / 'shell/renderer'
SKILLS = ROOT / 'shell/skills'
USERDATA = Path(os.path.expandvars(r'%LOCALAPPDATA%/Lumin'))
DB = USERDATA / 'itn.db'
NO_WINDOW = 0x08000000
sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def read_config():
    uri = 'file:' + str(DB).replace('\\', '/') + '?mode=ro'
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    models = [dict(r) for r in db.execute('SELECT * FROM models ORDER BY ord')]
    roles = {r['kind']: r['model_id'] for r in db.execute('SELECT * FROM roles')}
    db.close()
    return models, roles


class Core:
    def __init__(self, data_dir):
        self.dir = Path(data_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        pf = self.dir / 'port.txt'
        self.proc = subprocess.Popen(
            [str(EXE), '--data-dir', str(self.dir), '--port-file', str(pf), '--ui-dir', str(UI), '--skills-dir', str(SKILLS)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        for _ in range(200):
            if pf.exists() and pf.read_text(encoding='utf-8', errors='replace').strip():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('core did not start')
        self.base = 'http://127.0.0.1:' + pf.read_text(encoding='utf-8').strip()

    def call(self, path, obj, timeout=600):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode('utf-8'))
        if j.get('code') != 0:
            raise RuntimeError('%s: %s' % (path, j.get('message')))
        return j.get('data') or {}

    def events(self, sid):
        return self.call('/api/sessions/events', {'sessionId': sid}).get('events') or []

    def close(self):
        self.proc.kill()


RESULTS = []


def run_case(name, fn):
    t0 = time.time()
    try:
        detail = fn() or ''
        RESULTS.append((name, True, detail))
        print('PASS %-18s %5.1fs  %s' % (name, time.time() - t0, detail))
    except Exception as e:
        RESULTS.append((name, False, str(e)))
        print('FAIL %-18s %5.1fs  %s' % (name, time.time() - t0, e))
    sys.stdout.flush()


def main():
    only = None
    if '--case' in sys.argv:
        only = set(sys.argv[sys.argv.index('--case') + 1].split(','))
    models, roles = read_config()
    chat = next((m for m in models if m['id'] == roles.get('chat')), None)
    if chat is None:
        print('没有找到已绑定的对话模型，先在 Lumin 设置里配置')
        return 2
    work = Path(tempfile.mkdtemp(prefix='lumin-real-features-'))
    core = Core(work / 'data')
    try:
        caps = chat['capabilities'] or '[]'
        try:
            caps = json.loads(caps)
        except Exception:
            caps = []
        core.call('/api/models/save', {'id': chat['id'], 'name': chat['name'], 'baseUrl': chat['base_url'],
                                       'apiKey': chat['api_key'], 'model': chat['model'],
                                       'visionModel': chat['vision_model'] or '', 'embeddingModel': chat['embedding_model'] or '',
                                       'capabilities': caps})
        core.call('/api/models/roles', {'chatModelId': chat['id']})
        print('REAL model: %s (%s) · 隔离目录 %s' % (chat['name'], chat['model'], work))

        def new_session(project=''):
            return core.call('/api/sessions/new', {'projectId': project} if project else {})['sessionId']

        def ask(sid, q, **kw):
            payload = {'sessionId': sid, 'question': q, 'web': 'off'}
            payload.update(kw)
            return core.call('/api/agent/ask-pi', payload, timeout=600)

        def case_chat():
            sid = new_session()
            r = ask(sid, '请只用一句话说明你是一款什么软件，不要调用任何工具。')
            ans = (r.get('answer') or '').strip()
            assert r.get('ok') is True, 'turn not ok: %s' % (r.get('message') or '')
            assert len(ans) >= 4, '空回复'
            return 'answer=%r' % ans[:36]

        def case_stream():
            sid = new_session()
            r = ask(sid, '写三句话介绍「输入与输出」这个概念，不超过 80 个汉字。')
            ans = (r.get('answer') or '').strip()
            events = core.events(sid)
            resp = [e for e in events if e.get('type') == 'model/response']
            assert r.get('ok') is True and len(ans) >= 30, '回复不合格：ok=%s len=%s' % (r.get('ok'), len(ans))
            assert resp and resp[-1]['payload'].get('responseId'), '缺少上游响应 ID（不是真实上游？）'
            return 'answer=%d chars upstream=%s' % (len(ans), resp[-1]['payload'].get('responseModel'))

        def case_vision():
            src = (ROOT / 'core/src/llm/vision_probe.cj').read_text(encoding='utf-8')
            probe = re.search(r'data:image/png;base64,[A-Za-z0-9+/=]+', src).group(0)
            sid = new_session()
            r = ask(sid, '请读取图片中央的验证码，只输出验证码，不要猜测。',
                    attachments=[{'kind': 'image', 'name': 'probe.png', 'dataUrl': probe}])
            ans = ((r.get('answer') or '').replace('-', '').replace(' ', ''))
            assert 'K7P4' in ans, '图片回答不含验证码：%r' % (r.get('answer') or '')
            return 'answer=%r' % (r.get('answer') or '')[:24]

        def case_session_read():
            a = new_session()
            ask(a, '请只回复一句话：收到，暗号是 X42-NOTE。')
            b = new_session()
            r = ask(b, '必须用 read_session 工具读取会话 lumin://thread/%s，然后告诉我其中的暗号是什么。' % a)
            events = core.events(b)
            used = any(e.get('type') == 'tool/result' and (e.get('payload') or {}).get('tool') == 'read_session' and (e.get('payload') or {}).get('ok') for e in events)
            ans = (r.get('answer') or '')
            assert used, 'read_session 没有被成功调用：%r' % ans[:120]
            assert 'X42-NOTE' in ans, '回答里没有暗号：%r' % ans[:120]
            return 'tool=read_session ok, answer=%r' % ans[:32]

        def case_file_read():
            proj = work / 'project'
            proj.mkdir(exist_ok=True)
            (proj / 'secret.txt').write_text('内部编码：ZQ-7781\n负责人：测试组\n', encoding='utf-8')
            p = core.call('/api/projects/save', {'name': '真实模型测试项目', 'root': str(proj)})
            sid = new_session(p['id'])
            r = ask(sid, '我附加了一份文件附件，请读取它并回答：内部编码是什么？只输出编码。',
                    attachments=[{'kind': 'file', 'name': 'secret.txt', 'path': str(proj / 'secret.txt')}])
            ans = (r.get('answer') or '')
            assert 'ZQ-7781' in ans, '回答里没有文件内容：%r' % ans[:120]
            return 'answer=%r' % ans[:24]

        def case_memory():
            sid = new_session()
            ask(sid, '记住：我喜欢先看例子再看概念。')
            mems = core.call('/api/learning/memories', {}).get('memories') or []
            hit = [m for m in mems if '例子' in (m.get('text') or '')]
            assert hit, '学习记忆没有保存（现有 %d 条）' % len(mems)
            core.call('/api/learning/memory/forget', {'id': hit[0]['id']})
            return 'memory=%r' % (hit[0].get('text') or '')[:24]

        def case_generate():
            kb = work / 'kb'
            kb.mkdir(exist_ok=True)
            (kb / 'io.md').write_text('# 输入与输出\n\n输入样例要写清范围与边界，输出要保留中间状态，方便复现与验证。\n\n# 验证与边界\n\n正常、最小、最大与异常样例都要覆盖，预期与实际差异要记录。\n', encoding='utf-8')
            core.call('/api/kb/save', {'id': 'kb', 'name': '真实模型测试资料', 'rootDir': str(kb)})
            core.call('/api/kb/build', {'id': 'kb'})
            sid = new_session()
            r = ask(sid, '请根据资料中的《输入与输出》生成一份定制讲义，讲给学生听。', kbId='kb')
            events = core.events(sid)
            saved = [e for e in events if e.get('type') == 'resource/saved']
            called = any(e.get('type') == 'tool/call' and (e.get('payload') or {}).get('tool') == 'generate_learning_resource' for e in events)
            assert called, '模型没有调用 generate_learning_resource'
            assert r.get('ok') is True and saved, '生成失败：ok=%s msg=%s' % (r.get('ok'), r.get('message'))
            res = core.call('/api/learning/resource', {'id': saved[-1]['payload']['id'], 'version': saved[-1]['payload']['version']})
            cites = res.get('citations') or []
            issues = ((res.get('quality') or {}).get('issues') or [])
            assert (res.get('markdown') or '').strip(), '资源正文为空'
            assert cites, '资源没有引用'
            return 'title=%r citations=%d issues=%d' % (res.get('title'), len(cites), len(issues))

        cases = [('chat', case_chat), ('stream', case_stream), ('vision', case_vision),
                 ('session_read', case_session_read), ('file_read', case_file_read),
                 ('memory', case_memory), ('generate', case_generate)]
        for name, fn in cases:
            if only and name not in only:
                continue
            run_case('real-' + name, fn)

        failed = [n for n, ok, _ in RESULTS if not ok]
        print('SUMMARY %d/%d passed%s' % (len(RESULTS) - len(failed), len(RESULTS), (' · FAILED: ' + ','.join(failed)) if failed else ''))
        return 1 if failed else 0
    finally:
        core.close()


if __name__ == '__main__':
    sys.exit(main())
