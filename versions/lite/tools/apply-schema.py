"""Apply additive schema changes ONLY to the isolated learning-v2 database.

Uses .env.local for the target. A DDL account can be supplied through process-only
ZHIXUN_SCHEMA_USER / ZHIXUN_SCHEMA_PASSWORD. Credentials are never printed.
"""
import argparse
import re
from pathlib import Path

import pymysql


def split_sql(text, delimiter):
    pieces, start, depth, quote = [], 0, 0, ''
    for i, char in enumerate(text):
        if quote:
            if char == quote and (i == 0 or text[i - 1] != '\\'):
                quote = ''
        elif char in "'\"`":
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        elif char == delimiter and depth == 0:
            pieces.append(text[start:i].strip())
            start = i + 1
    pieces.append(text[start:].strip())
    return [piece for piece in pieces if piece]


def main():
    import os
    parser = argparse.ArgumentParser()
    parser.add_argument('migration', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    values = {}
    for line in (root / '.env.local').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    if values.get('ZHIXUN_DB_NAME') != 'itn_learning_v2_dev':
        raise RuntimeError('Refusing schema changes outside the isolated development database')
    migration = args.migration.resolve()
    if not migration.is_relative_to((root / 'services/learning/migrations').resolve()):
        raise RuntimeError('Migration must be inside this project migration directory')
    sql = '\n'.join(line for line in migration.read_text(encoding='utf-8').splitlines()
                    if not line.lstrip().startswith('--'))
    connection = pymysql.connect(
        host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
        user=os.environ.get('ZHIXUN_SCHEMA_USER', values['ZHIXUN_DB_USER']),
        password=os.environ.get('ZHIXUN_SCHEMA_PASSWORD', values['ZHIXUN_DB_PASSWORD']),
        database=values['ZHIXUN_DB_NAME'], charset='utf8mb4', autocommit=True,
        connect_timeout=15,
    )
    try:
        with connection.cursor() as cursor:
            for statement in split_sql(sql, ';'):
                alter = re.match(r'ALTER TABLE\s+(\w+)\s+([\s\S]+)', statement, re.I)
                if not alter:
                    if not re.match(r'CREATE TABLE IF NOT EXISTS\s+\w+', statement, re.I):
                        raise RuntimeError('Only additive CREATE/ALTER migration statements are supported')
                    cursor.execute(statement)
                    print('Ready:', re.search(r'EXISTS\s+(\w+)', statement, re.I)[1], flush=True)
                    continue
                table, operations = alter.groups()
                cursor.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=%s AND table_name=%s',
                               (values['ZHIXUN_DB_NAME'], table))
                columns = {row[0] for row in cursor.fetchall()}
                cursor.execute('SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema=%s AND table_name=%s',
                               (values['ZHIXUN_DB_NAME'], table))
                indexes = {row[0] for row in cursor.fetchall()}
                cursor.execute('SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema=%s AND table_name=%s',
                               (values['ZHIXUN_DB_NAME'], table))
                constraints = {row[0] for row in cursor.fetchall()}
                priority = lambda operation: (3 if operation.upper().startswith('DROP') else
                                              0 if operation.upper().startswith('ADD COLUMN') else
                                              2 if operation.upper().startswith('ADD CONSTRAINT') else 1)
                for operation in sorted(split_sql(operations, ','), key=priority):
                    column = re.match(r'ADD COLUMN\s+(\w+)', operation, re.I)
                    index = re.match(r'ADD (?:UNIQUE )?KEY\s+(\w+)', operation, re.I)
                    constraint = re.match(r'ADD CONSTRAINT\s+(\w+)', operation, re.I)
                    drop = re.match(r'DROP INDEX\s+(\w+)', operation, re.I)
                    if column:
                        name, known = column[1], columns
                    elif index:
                        name, known = index[1], indexes
                    elif constraint:
                        name, known = constraint[1], constraints
                    elif drop:
                        name, known = drop[1], indexes
                        if name not in known:
                            continue
                        cursor.execute(f'ALTER TABLE {table} {operation}')
                        known.remove(name)
                        print('Replaced old index:', table, name, flush=True)
                        continue
                    else:
                        raise RuntimeError('Unrecognized ALTER operation')
                    if name in known:
                        continue
                    cursor.execute(f'ALTER TABLE {table} {operation}')
                    known.add(name)
                    print('Added:', table, name, flush=True)
    finally:
        connection.close()


if __name__ == '__main__':
    main()
