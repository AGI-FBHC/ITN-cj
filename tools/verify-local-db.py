"""Read-only verification of the remote learning-v2 database and its local copy.

Credentials stay in ignored env files. Reports contain only schema, counts and
hashes. Each table is compared as a sorted multiset of SHA-256 row hashes.
"""
import argparse
import json
from pathlib import Path

import pymysql


def read_env(path):
    values = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    if values.get('ZHIXUN_DB_NAME') != 'itn_learning_v2_dev':
        raise ValueError('Only the isolated learning-v2 database may be compared')
    return values


def connect(values):
    return pymysql.connect(
        host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
        user=values['ZHIXUN_DB_USER'], password=values['ZHIXUN_DB_PASSWORD'],
        database=values['ZHIXUN_DB_NAME'], charset='utf8mb4',
        connect_timeout=10, read_timeout=120,
    )


def quote_identifier(value):
    return '`' + value.replace('`', '``') + '`'


def fingerprint(values):
    database = connect(values)
    try:
        with database.cursor() as cursor:
            cursor.execute('SET SESSION group_concat_max_len=16777216')
            cursor.execute('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
            cursor.execute('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE '
                           'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() '
                           'ORDER BY TABLE_NAME,ORDINAL_POSITION')
            tables = {}
            for table, column, column_type, nullable in cursor.fetchall():
                tables.setdefault(table, []).append([column, column_type, nullable])
            selections = []
            for table, columns in tables.items():
                fields = ["IF({0} IS NULL,'N',CONCAT('V',HEX({0})))".format(quote_identifier(c[0]))
                          for c in columns]
                row_hash = "SHA2(CONCAT_WS('|'," + ','.join(fields) + '),256)'
                selections.append(
                    "SELECT '" + table + "' table_name,COUNT(*) row_count,"
                    "SHA2(COALESCE(GROUP_CONCAT(row_hash ORDER BY row_hash SEPARATOR ''),''),256) digest "
                    'FROM (SELECT ' + row_hash + ' row_hash FROM ' + quote_identifier(table) + ') rows_hashed'
                )
            cursor.execute(' UNION ALL '.join(selections))
            results = {table: {'count': count, 'sha256': digest, 'columns': tables[table]}
                       for table, count, digest in cursor.fetchall()}
            cursor.execute('SHOW WARNINGS')
            if cursor.fetchall():
                raise RuntimeError('Fingerprint query produced warnings; comparison is incomplete')
            return results
    finally:
        database.rollback()
        database.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-env', required=True, type=Path)
    parser.add_argument('--target-env', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    source_env, target_env = read_env(args.source_env), read_env(args.target_env)
    if target_env['ZHIXUN_DB_HOST'] not in ('127.0.0.1', 'localhost'):
        raise ValueError('The comparison target must be local')
    source = fingerprint(source_env)
    target = fingerprint(target_env)
    differences = [name for name in sorted(source.keys() | target.keys())
                   if source.get(name) != target.get(name)]
    report = {'equal': not differences, 'differentTables': differences,
              'source': source, 'target': target}
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'equal': not differences, 'tableCount': len(source),
                      'differentTables': differences}, ensure_ascii=False), flush=True)
    raise SystemExit(0 if not differences else 1)


if __name__ == '__main__':
    main()
