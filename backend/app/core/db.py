"""Conexión segura a MySQL / Amazon RDS compatible con PyMySQL y mysql-connector-python."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator, Tuple

from app.core.config import settings

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:  # pragma: no cover
    pymysql = None
    DictCursor = None

try:
    import mysql.connector as mysql_connector
except ImportError:  # pragma: no cover
    mysql_connector = None


class _MysqlConnectorCursorAdapter:
    """Adaptador para que el cursor de mysql.connector funcione como context manager igual que PyMySQL."""

    def __init__(self, raw_cursor):
        self._cur = raw_cursor

    def __enter__(self):
        return self._cur

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            self._cur.close()
        except Exception:
            pass
        return False

    def __getattr__(self, name):
        return getattr(self._cur, name)


class _MysqlConnectorConnAdapter:
    """Adaptador para que una conexión mysql.connector exponga conn.cursor() con dictionary=True y context manager."""

    def __init__(self, raw_conn):
        self._conn = raw_conn

    def cursor(self, *_args, **_kwargs):
        return _MysqlConnectorCursorAdapter(self._conn.cursor(dictionary=True))

    def commit(self):
        return self._conn.commit()

    def rollback(self):
        return self._conn.rollback()

    def close(self):
        return self._conn.close()


def crear_conexion():
    """Abre una conexión nueva hacia RDS usando PyMySQL o mysql-connector-python."""
    if pymysql is not None:
        return pymysql.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=settings.db_user,
            password=settings.db_password,
            database=settings.db_name,
            charset="utf8mb4",
            cursorclass=DictCursor,
            autocommit=False,
            connect_timeout=settings.db_connect_timeout,
            read_timeout=10,
            write_timeout=10,
        )
    if mysql_connector is not None:
        raw = mysql_connector.connect(
            host=settings.db_host,
            port=settings.db_port,
            user=settings.db_user,
            password=settings.db_password,
            database=settings.db_name,
            autocommit=False,
            connection_timeout=settings.db_connect_timeout,
        )
        return _MysqlConnectorConnAdapter(raw)
    raise RuntimeError(
        "No se encontró 'pymysql' ni 'mysql-connector-python' en el entorno Python."
    )


@contextmanager
def obtener_conexion(auto_commit: bool = False) -> Iterator:
    """Context manager que garantiza rollback ante error y cierre limpio."""
    conn = crear_conexion()
    try:
        yield conn
        if auto_commit:
            conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass


get_db_connection = obtener_conexion


def verificar_salud_db() -> Tuple[bool, str]:
    """Ejecuta una comprobación real SELECT 1 contra MySQL/RDS."""
    if pymysql is None and mysql_connector is None:
        return False, "Driver MySQL no instalado"
    try:
        with obtener_conexion() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                fila = cur.fetchone()
                if fila and (fila.get("ok") == 1 or 1 in fila.values()):
                    return True, "Disponible"
        return False, "Respuesta inesperada en SELECT 1"
    except Exception as exc:
        return False, f"No disponible ({type(exc).__name__})"
