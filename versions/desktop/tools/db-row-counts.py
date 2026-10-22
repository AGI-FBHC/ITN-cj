import sqlite3, sys, json
db = sys.argv[1]
tables = ['sessions', 'session_events', 'notes', 'quiz_records', 'learning_resources', 'learning_memories']
out = {}
con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
for t in tables:
    try:
        out[t] = con.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]
    except Exception:
        out[t] = -1
con.close()
print(json.dumps(out))