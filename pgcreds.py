"""Preserve libpq connection options while keeping passwords out of argv."""
import os

from psycopg2.extensions import make_dsn, parse_dsn


def pg_env(dsn):
    params = parse_dsn(dsn)
    env = dict(os.environ)
    if 'password' in params:
        env['PGPASSWORD'] = params.pop('password')
    # libpq parses conninfo dbnames too, preserving sslmode, options and encoded
    # database names exactly as the Python connection used for identity checks.
    env['PGDATABASE'] = make_dsn(**params)
    return env
