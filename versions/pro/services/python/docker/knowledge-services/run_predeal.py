from runtime_env import configure_shared_env

configure_shared_env()

from predeal.web.app import app

app.run(host="0.0.0.0", port=8020, debug=False, threaded=True)
