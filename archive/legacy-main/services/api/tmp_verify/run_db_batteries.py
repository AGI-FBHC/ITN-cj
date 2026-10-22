"""Launch Spire via subprocess.Popen (the only launch method that survives
on this machine — PowerShell Start-Process and direct exec both die in
msvcrt.dll after ~6s) and run the §14.4 / §14.5 DB batteries against it.

Secret-free: PLATFORM_DB_URL is assembled in-memory from VERIFY_MYSQL_PW.

Run:
  source tmp_verify/spire_db_env.sh && JWT_SECRET=... python tmp_verify/run_db_batteries.py
"""
import os, sys, time, subprocess, urllib.request

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\cangjie\zyqprojects\itn_spire"
EXE = os.path.join(ROOT, r"target\release\bin\main.exe")
LOG = os.path.join(os.environ.get("TEMP", ROOT), "spire_db_batteries.log")
PORT = "19413"
BASE = f"http://127.0.0.1:{PORT}"
HERE = os.path.join(ROOT, "tmp_verify")

pw = os.environ.get("VERIFY_MYSQL_PW") or os.environ.get("PLATFORM_DB_URL", "")
if not pw or pw.startswith("mysql://") and "VERIFY_MYSQL_PW" not in os.environ:
    # need the password itself to assemble; refuse to start without it
    if not os.environ.get("VERIFY_MYSQL_PW"):
        print("FAIL | VERIFY_MYSQL_PW not set | source spire_db_env.sh first")
        sys.exit(2)

env = os.environ.copy()
env["JWT_SECRET"] = env.get("JWT_SECRET", "KNOWNSECRET20CHARSXX")
env["SPIRE_HTTP_URL"] = BASE
if env.get("VERIFY_MYSQL_PW"):
    _pw = env["VERIFY_MYSQL_PW"]
    env["PLATFORM_DB_URL"] = (
        f"mysql://root:{_pw}@43.160.236.121:3306/itn_cangjie_dev"
    )
if "PLATFORM_DB_URL" not in env:
    print("FAIL | no PLATFORM_DB_URL")
    sys.exit(2)
env["CANGJIE_STDX_PATH"] = (
    r"D:\cangjie\cangjie-stdx-windows-x64-1.1.3.1\windows_x86_64_cjnative\static\stdx"
)
env["PRESENTATION_OUTPUT_DIR"] = os.path.join(HERE, "ppt_out")
env["PATH"] = r"D:\OpenSSL-Win64\OpenSSL-Win64\bin;" + env["PATH"]
env["VERIFY_BASE"] = BASE

os.makedirs(env["PRESENTATION_OUTPUT_DIR"], exist_ok=True)
logf = open(LOG, "w", encoding="utf-8", errors="replace")
proc = subprocess.Popen(
    [EXE],
    env=env,
    stdout=logf,
    stderr=subprocess.STDOUT,
    cwd=os.path.dirname(EXE),
)
print(f"spire pid={proc.pid} base={BASE} log={LOG}", flush=True)

ok = False
for _ in range(60):
    time.sleep(0.25)
    if proc.poll() is not None:
        print(f"spire DIED rc={proc.poll()}", flush=True)
        break
    try:
        with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
            if r.status == 200:
                print("health", repr(r.read().decode("utf-8", "replace")), flush=True)
                ok = True
                break
    except Exception:
        pass

if not ok:
    print("SERVICE NOT UP", flush=True)
    try:
        logf.flush()
        print(open(LOG, "r", errors="replace").read()[-3000:], flush=True)
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass
    sys.exit(1)

rc = 0
for name in ("verify_rtask_write.py", "verify_customize_tasks.py", "verify_tutoring.py"):
    path = os.path.join(HERE, name)
    print(f"\n===== RUN {name} =====", flush=True)
    t0 = time.time()
    p = subprocess.run([sys.executable, path], env=env, cwd=HERE)
    print(f"===== {name} exit={p.returncode} in {time.time()-t0:.1f}s =====", flush=True)
    if p.returncode != 0:
        rc = p.returncode

try:
    proc.terminate()
    proc.wait(timeout=5)
except Exception:
    try:
        proc.kill()
    except Exception:
        pass
logf.close()
print(f"\nspire stopped; batteries rc={rc}")
sys.exit(rc)
