"""Conexión segura a MySQL / Amazon RDS con DictCursor y timeouts controlados."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator, Tuple

from app.core.config import settings

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:  # pragma: no cover - permite pruebas unitarias sin pymysql local
    pymysql = None
    DictCursor = None


def crear_conexion():
    """Abre una conexión nueva PyMySQL hacia RDS o MySQL local."""
    if pymysql is None:
        raise RuntimeError(
            "El paquete 'pymysql' no está instalado en este entorno Python."
        )
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


# Alias de compatibilidad
get_db_connection = obtener_conexion


def verificar_salud_db() -> Tuple[bool, str]:
    """Ejecuta una comprobación real SELECT 1 contra MySQL/RDS."""
    if pymysql is None:
        return False, "pymysql no instalado"
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
