"""Configuración centralizada del backend FastAPI con soporte para .env."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List

logger = logging.getLogger("iot.config")

ORIGENES_CORS_DEFAULT = [
    "https://andres0524e.github.io",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:5505",
    "http://localhost:5500",
    "http://localhost:5505",
]

SECRETOS_INSEGUROS = {
    "",
    "CAMBIA_ESTE_SECRETO_EN_PRODUCCION_MIN_32_BYTES",
    "cambiame-secreto-jwt-desarrollo",
    "secret",
    "dev-secret",
}


def _cargar_dotenv_simple() -> None:
    """Carga variables de backend/.env si python-dotenv no está o para entorno local."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.is_file():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)
    except OSError:
        pass


_cargar_dotenv_simple()


def _parse_bool(valor: str | bool | None, default: bool = False) -> bool:
    if isinstance(valor, bool):
        return valor
    if valor is None:
        return default
    return str(valor).strip().lower() in {"1", "true", "yes", "on", "si"}


def _parse_int(valor: str | int | None, default: int) -> int:
    try:
        return int(valor) if valor is not None else default
    except (TypeError, ValueError):
        return default


def _parse_cors_origins(raw: str | List[str] | None) -> List[str]:
    if not raw:
        return list(ORIGENES_CORS_DEFAULT)
    if isinstance(raw, list):
        candidatos = [str(item).strip() for item in raw]
    else:
        candidatos = [item.strip() for item in str(raw).split(",")]
    filtrados = [item for item in candidatos if item and item != "*"]
    if any(item == "*" for item in candidatos):
        logger.warning(
            "Se ignoró '*' en CORS_ORIGINS porque allow_credentials=True requiere orígenes explícitos."
        )
    return filtrados or list(ORIGENES_CORS_DEFAULT)


class Settings:
    """Configuración tipada sin fallar cuando pydantic-settings no está instalado en tests locales."""

    def __init__(self) -> None:
        self.app_env: str = os.getenv("APP_ENV", "development").strip().lower()
        self.app_title: str = os.getenv(
            "APP_TITLE",
            "API IoT Vehículos - Control, Monitoreo y Administración",
        )
        self.app_version: str = os.getenv("APP_VERSION", "3.0.0")

        self.db_host: str = os.getenv("DB_HOST", "localhost")
        self.db_port: int = _parse_int(os.getenv("DB_PORT"), 3306)
        self.db_user: str = os.getenv("DB_USER", "root")
        self.db_password: str = os.getenv("DB_PASSWORD", "")
        self.db_name: str = os.getenv("DB_NAME", "vehiculo_iot")
        self.db_connect_timeout: int = _parse_int(os.getenv("DB_CONNECT_TIMEOUT"), 5)

        raw_jwt = os.getenv("JWT_SECRET") or os.getenv("API_KEY") or ""
        if raw_jwt and len(raw_jwt) < 32:
            raw_jwt = f"{raw_jwt}-iot-jwt-secret-key-padding-32b"
        self.jwt_secret: str = raw_jwt or "dev-only-jwt-key-not-for-production-use-32b"
        self.jwt_algorithm: str = os.getenv("JWT_ALGORITHM", "HS256")
        self.jwt_expire_minutes: int = _parse_int(os.getenv("JWT_EXPIRE_MINUTES"), 480)

        self.cors_origins: List[str] = _parse_cors_origins(os.getenv("CORS_ORIGINS"))

        self.guest_session_minutes: int = _parse_int(os.getenv("GUEST_SESSION_MINUTES"), 3)
        self.support_default_minutes: int = _parse_int(os.getenv("SUPPORT_DEFAULT_MINUTES"), 30)
        self.demo_max_pasos: int = _parse_int(os.getenv("DEMO_MAX_PASOS"), 30)
        self.demo_min_duracion_ms: int = _parse_int(os.getenv("DEMO_MIN_DURACION_MS"), 200)
        self.demo_max_duracion_ms: int = _parse_int(os.getenv("DEMO_MAX_DURACION_MS"), 10000)
        self.rate_limit_movimientos_por_min: int = _parse_int(
            os.getenv("RATE_LIMIT_MOVIMIENTOS_POR_MIN"), 120
        )
        self.allow_legacy_anon: bool = _parse_bool(os.getenv("ALLOW_LEGACY_ANON"), False)

        if self.jwt_secret in SECRETOS_INSEGUROS or len(self.jwt_secret) < 24:
            if self.app_env == "production":
                raise RuntimeError(
                    "JWT_SECRET inseguro o vacío en entorno de producción. Configura una clave aleatoria >= 32 bytes."
                )
            logger.warning(
                "Usando JWT_SECRET de desarrollo; define JWT_SECRET seguro en backend/.env antes de desplegar."
            )

    @property
    def cors_origins_list(self) -> List[str]:
        return list(self.cors_origins)


settings = Settings()
