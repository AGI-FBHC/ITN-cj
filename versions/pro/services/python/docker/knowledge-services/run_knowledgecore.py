from runtime_env import configure_shared_env

configure_shared_env()

import uvicorn

uvicorn.run("app.main:app", host="0.0.0.0", port=8010, workers=1)
