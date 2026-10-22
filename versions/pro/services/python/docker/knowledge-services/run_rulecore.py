from runtime_env import configure_shared_env

configure_shared_env()

import subprocess
import sys

import uvicorn

subprocess.run([sys.executable, "scripts/migrate.py"], check=True)
uvicorn.run("app.main:app", host="0.0.0.0", port=8201, workers=1)
