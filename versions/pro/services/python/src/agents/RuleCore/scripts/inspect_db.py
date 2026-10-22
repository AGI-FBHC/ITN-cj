import sys
from pathlib import Path

import pymysql, hashlib

# 从 .env 读取数据库配置（不硬编码凭据）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core.config import settings

conn = pymysql.connect(**settings.mysql_dsn, connect_timeout=10)
cur = conn.cursor()

cur.execute("SELECT status, COUNT(*) FROM knowledge_chunk GROUP BY status")
print("=== chunk status 分布 ===")
for r in cur.fetchall(): print(f"  {r[0]}: {r[1]}")

cur.execute("SELECT COUNT(*) FROM knowledge_chunk WHERE status='active' AND canonical_chunk_id IS NULL")
print(f"\nactive 且 canonical_chunk_id 为 NULL: {cur.fetchone()[0]}")

# superseded 与 active 的配对关系：同 doc 同 section_title
cur.execute("""
SELECT c.document_id, c.section_title,
       SUM(c.status='active') as act, SUM(c.status='superseded') as sup
FROM knowledge_chunk c
GROUP BY c.document_id, c.section_title
HAVING act > 0 AND sup > 0
LIMIT 10
""")
print("\n=== 同 section 并存 active+superseded 的样例（前10）===")
for r in cur.fetchall(): print(f"  doc{r[0]} [{r[1]}] active={r[2]} superseded={r[3]}")

# 规则关键词分布
cur.execute("""
SELECT document_id, COUNT(*) FROM knowledge_chunk
WHERE status='active' AND (
  content LIKE '%必须%' OR content LIKE '%应当%' OR content LIKE '%不得%'
  OR content LIKE '%禁止%' OR content LIKE '%应该%' OR content LIKE '%须%'
  OR content LIKE '当…时' OR content LIKE '%如果%' OR content LIKE '%若%')
GROUP BY document_id ORDER BY 2 DESC
""")
print("\n=== active 切片中含规则关键词的分布 ===")
for r in cur.fetchall(): print(f"  doc {r[0]}: {r[1]}")

# 第四章中含规则句的 active 切片内容抽样
cur.execute("""
SELECT id, section_title, content FROM knowledge_chunk
WHERE document_id=38 AND status='active'
AND (content LIKE '%必须%' OR content LIKE '%不得%' OR content LIKE '%应该%' OR content LIKE '%须%')
ORDER BY chunk_index LIMIT 5
""")
print("\n=== 第四章规则候选切片抽样 ===")
for r in cur.fetchall():
    text = r[2]
    # 抽出含关键词的句子
    import re
    sents = re.split(r'(?<=[。；])', text)
    hits = [s.strip()[:150] for s in sents if any(k in s for k in ('必须','不得','应该','须'))]
    print(f"--- chunk {r[0]} [{r[1]}]")
    for h in hits[:4]: print(f"    · {h}")

conn.close()
