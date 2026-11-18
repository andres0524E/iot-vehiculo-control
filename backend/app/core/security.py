"""Módulo de seguridad IoT: PBKDF2/Bcrypt, JWT (HS256), RBAC, BOLA/IDOR y Soporte."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, Optional

from app.core.config import settings
from app.core.db import obtener_conexion

try:
    from fastapi import Depends, Header, HTTPException, Request, status
except ImportError:  # pragma: no cover - fallback ligero para tests unitarios sin FastAPI
    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: Any = None, headers: Optional[Dict[str, str]] = None):
            super().__init__(str(detail))
            self.status_code = status_code
            self.detail = detail
            self.headers = headers or {}

    class _Status:
        HTTP_400_BAD_REQUEST = 400
        HTTP_401_UNAUTHORIZED = 401
        HTTP_403_FORBIDDEN = 403
        HTTP_404_NOT_FOUND = 404
        HTTP_409_CONFLICT = 409
        HTTP_422_UNPROCESSABLE_ENTITY = 422
        HTTP_429_TOO_MANY_REQUESTS = 429

    status = _Status()

    def Depends(dep: Any = None):
        return dep

    def Header(default: Any = None, **_kwargs: Any):
        return default

    Request = Any  # type: ignore

try:
    import jwt as pyjwt
except ImportError:  # pragma: no cover
    pyjwt = None

try:
    import bcrypt as pybcrypt
except ImportError:  # pragma: no cover
    pybcrypt = None


PBKDF2_ALGORITMO = "pbkdf2_sha256"
PBKDF2_ITERACIONES_DEFAULT = 310000
CODIGOS_INVITADO_FALLBACK = frozenset({1, 2, 3, 4, 7, 8, 9, 10, 11})
CODIGO_DETENER = 9


def ahora_utc() -> datetime:
    """Devuelve datetime UTC con tzinfo=timezone.utc."""
    return datetime.now(timezone.utc)


def ahora_utc_naive() -> datetime:
    """Devuelve datetime UTC naive compatible con DATETIME de MySQL."""
    return ahora_utc().replace(tzinfo=None)


def serializar_utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """Formatea un datetime MySQL (asumido UTC si viene naive) en ISO-8601 con sufijo Z."""
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt if dt.endswith("Z") or "+" in dt else f"{dt.replace(' ', 'T')}Z"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def hash_password(password_plano: str, iteraciones: int = PBKDF2_ITERACIONES_DEFAULT) -> str:
    """Genera hash PBKDF2-HMAC-SHA256 salado compatible con Python 3.14 sin dependencias rotas."""
    if not password_plano or not isinstance(password_plano, str):
        raise ValueError("La contraseña no puede estar vacía.")
    sal_hex = secrets.token_hex(16)
    derivado = hashlib.pbkdf2_hmac(
        "sha256",
        password_plano.encode("utf-8"),
        bytes.fromhex(sal_hex),
        iteraciones,
    ).hex()
    return f"{PBKDF2_ALGORITMO}${iteraciones}${sal_hex}${derivado}"


def verificar_password(password_plano: str, password_hash: str) -> bool:
    """Verifica estrictamente la contraseña contra su hash almacenado (cero bypasses)."""
    if not password_plano or not password_hash:
        return False

    if password_hash.startswith(f"{PBKDF2_ALGORITMO}$"):
        partes = password_hash.split("$")
        if len(partes) != 4:
            return False
        _, iter_str, sal_hex, digest_hex = partes
        try:
            iteraciones = int(iter_str)
            sal_bytes = bytes.fromhex(sal_hex)
            calculado = hashlib.pbkdf2_hmac(
                "sha256",
                password_plano.encode("utf-8"),
                sal_bytes,
                iteraciones,
            ).hex()
        except (ValueError, TypeError):
            return False
        return hmac.compare_digest(calculado, digest_hex)

    if password_hash.startswith(("$2a$", "$2b$", "$2y$")) and pybcrypt is not None:
        try:
            return pybcrypt.checkpw(
                password_plano.encode("utf-8"),
                password_hash.encode("utf-8"),
            )
        except (ValueError, TypeError):
            return False

    return False


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(texto: str) -> bytes:
    padding = "=" * (-len(texto) % 4)
    return base64.urlsafe_b64decode(f"{texto}{padding}".encode("ascii"))


def crear_token_acceso(
    *,
    id_usuario: int,
    email: str,
    rol: str,
    nombre_completo: str = "",
    expires_delta: Optional[timedelta] = None,
) -> Dict[str, Any]:
    """Firma un JWT HS256 con jti único para permitir revocación en logout."""
    ahora = ahora_utc()
    expiracion = ahora + (expires_delta or timedelta(minutes=settings.jwt_expire_minutes))
    jti = uuid.uuid4().hex
    payload = {
        "sub": str(id_usuario),
        "id_usuario": int(id_usuario),
        "email": email,
        "rol": rol,
        "nombre_completo": nombre_completo,
        "jti": jti,
        "iat": int(ahora.timestamp()),
        "exp": int(expiracion.timestamp()),
    }

    if pyjwt is not None:
        token = pyjwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    else:
        header_b64 = _b64url_encode(
            json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode("utf-8")
        )
        payload_b64 = _b64url_encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        )
        mensaje = f"{header_b64}.{payload_b64}".encode("ascii")
        firma = hmac.new(settings.jwt_secret.encode("utf-8"), mensaje, hashlib.sha256).digest()
        token = f"{header_b64}.{payload_b64}.{_b64url_encode(firma)}"

    return {
        "access_token": token,
        "jti": jti,
        "expira_en": expiracion,
        "token_type": "bearer",
    }


def decodificar_token_acceso(token: str) -> Dict[str, Any]:
    """Valida firma y expiración de un JWT HS256 sin aceptar tokens manipulados o vencidos."""
    if not token or not isinstance(token, str):
        raise ValueError("Token vacío")

    if pyjwt is not None:
        try:
            payload = pyjwt.decode(
                token,
                settings.jwt_secret,
                algorithms=[settings.jwt_algorithm],
            )
            return dict(payload)
        except Exception as exc:
            raise ValueError(f"Token JWT inválido o expirado: {exc}") from exc

    partes = token.split(".")
    if len(partes) != 3:
        raise ValueError("Formato JWT inválido")
    header_b64, payload_b64, firma_b64 = partes
    try:
        header = json.loads(_b64url_decode(header_b64).decode("utf-8"))
        if header.get("alg") != "HS256":
            raise ValueError("Algoritmo JWT no permitido")
        mensaje = f"{header_b64}.{payload_b64}".encode("ascii")
        firma_esperada = hmac.new(
            settings.jwt_secret.encode("utf-8"),
            mensaje,
            hashlib.sha256,
        ).digest()
        firma_recibida = _b64url_decode(firma_b64)
        if not hmac.compare_digest(firma_esperada, firma_recibida):
            raise ValueError("Firma JWT inválida")
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("No se pudo decodificar el JWT") from exc

    exp = payload.get("exp")
    if exp is None or int(ahora_utc().timestamp()) >= int(exp):
        raise ValueError("Token JWT expirado")
    return payload


def es_token_revocado(cursor: Any, jti: Optional[str]) -> bool:
    """Consulta si un JWT jti fue invalidado explícitamente mediante logout."""
    if not jti:
        return False
    cursor.execute(
        "SELECT 1 AS revocado FROM tokens_revocados WHERE jti = %s LIMIT 1",
        (jti,),
    )
    return cursor.fetchone() is not None


def cargar_usuario_desde_token(cursor: Any, token: str) -> Dict[str, Any]:
    """Decodifica el JWT, verifica que no esté revocado y carga al usuario activo de RDS."""
    try:
        payload = decodificar_token_acceso(token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    if es_token_revocado(cursor, payload.get("jti")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión cerrada o token revocado",
            headers={"WWW-Authenticate": "Bearer"},
        )

    sub = payload.get("sub") or payload.get("id_usuario")
    try:
        id_usuario = int(sub)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Identificador de usuario inválido en token",
        ) from exc

    cursor.execute(
        """
        SELECT u.id_usuario, u.email, u.nombre_completo, u.activo,
               r.id_rol, r.clave AS rol, r.nombre AS rol_nombre
        FROM usuarios u
        INNER JOIN roles r ON r.id_rol = u.id_rol
        WHERE u.id_usuario = %s
        LIMIT 1
        """,
        (id_usuario,),
    )
    usuario = cursor.fetchone()
    if not usuario or not bool(usuario.get("activo")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuario inexistente o desactivado",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return {
        "id_usuario": int(usuario["id_usuario"]),
        "email": usuario["email"],
        "nombre_completo": usuario["nombre_completo"],
        "id_rol": int(usuario["id_rol"]),
        "rol": usuario["rol"],
        "rol_nombre": usuario.get("rol_nombre", ""),
        "jti": payload.get("jti"),
        "exp": payload.get("exp"),
    }


def extraer_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    partes = authorization.strip().split(" ", 1)
    if len(partes) == 2 and partes[0].lower() == "bearer" and partes[1].strip():
        return partes[1].strip()
    return None


def obtener_usuario_opcional(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> Optional[Dict[str, Any]]:
    token = extraer_bearer_token(authorization)
    if not token:
        return None
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            return cargar_usuario_desde_token(cur, token)


def obtener_usuario_actual(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> Dict[str, Any]:
    token = extraer_bearer_token(authorization)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Se requiere token de autenticación Bearer",
            headers={"WWW-Authenticate": "Bearer"},
        )
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            return cargar_usuario_desde_token(cur, token)


def requerir_roles(roles_permitidos: Iterable[str]) -> Callable:
    roles_set = set(roles_permitidos)

    def _dependencia(usuario: Dict[str, Any] = Depends(obtener_usuario_actual)) -> Dict[str, Any]:
        if usuario.get("rol") not in roles_set:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Acceso denegado para el rol '{usuario.get('rol')}'",
            )
        return usuario

    return _dependencia


def obtener_ip_cliente(request: Any) -> str:
    try:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()[:45]
        if request.client and request.client.host:
            return str(request.client.host)[:45]
    except Exception:
        pass
    return "0.0.0.0"


def registrar_auditoria(
    cursor: Any,
    *,
    id_usuario: Optional[int],
    accion: str,
    entidad_afectada: str,
    id_entidad: Optional[int] = None,
    detalles: Optional[Dict[str, Any]] = None,
    ip_origen: Optional[str] = None,
) -> None:
    """Inserta un evento auditable serializando detalles en JSON de forma segura."""
    cursor.execute(
        """
        INSERT INTO auditoria_operaciones
            (id_usuario, accion, entidad_afectada, id_entidad, detalles_json, ip_origen)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (
            id_usuario,
            accion[:64],
            entidad_afectada[:64],
            id_entidad,
            json.dumps(detalles or {}, ensure_ascii=False),
            (ip_origen or "0.0.0.0")[:45],
        ),
    )


def obtener_propietario_activo(cursor: Any, id_vehiculo: int) -> Optional[Dict[str, Any]]:
    cursor.execute(
        """
        SELECT a.id_asignacion, a.id_usuario, a.estado, u.email, u.nombre_completo
        FROM asignaciones_vehiculo a
        INNER JOIN usuarios u ON u.id_usuario = a.id_usuario
        WHERE a.id_vehiculo = %s AND a.estado = 'activo'
        ORDER BY a.id_asignacion DESC
        LIMIT 1
        """,
        (id_vehiculo,),
    )
    return cursor.fetchone()


def obtener_autorizacion_soporte_activa(cursor: Any, id_vehiculo: int) -> Optional[Dict[str, Any]]:
    cursor.execute(
        """
        SELECT id_soporte, id_vehiculo, id_usuario_dueno, motivo, activo, fecha_inicio, fecha_expiracion
        FROM soporte_autorizaciones
        WHERE id_vehiculo = %s
          AND activo = 1
          AND fecha_expiracion > UTC_TIMESTAMP()
        ORDER BY id_soporte DESC
        LIMIT 1
        """,
        (id_vehiculo,),
    )
    return cursor.fetchone()


def obtener_sesion_invitado_activa(
    cursor: Any,
    guest_token: str,
    id_vehiculo: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    if not guest_token:
        return None
    if id_vehiculo is not None:
        cursor.execute(
            """
            SELECT id_sesion, id_vehiculo, token_sesion, alias_cliente, fecha_inicio, fecha_expiracion, activa
            FROM sesiones_invitado
            WHERE token_sesion = %s
              AND id_vehiculo = %s
              AND activa = 1
              AND fecha_expiracion > UTC_TIMESTAMP()
            LIMIT 1
            """,
            (guest_token, id_vehiculo),
        )
    else:
        cursor.execute(
            """
            SELECT id_sesion, id_vehiculo, token_sesion, alias_cliente, fecha_inicio, fecha_expiracion, activa
            FROM sesiones_invitado
            WHERE token_sesion = %s
              AND activa = 1
              AND fecha_expiracion > UTC_TIMESTAMP()
            LIMIT 1
            """,
            (guest_token,),
        )
    return cursor.fetchone()


def validar_comando_para_actor(
    cursor: Any,
    *,
    vehiculo: Dict[str, Any],
    id_comando: int,
    es_invitado: bool,
) -> Dict[str, Any]:
    """Verifica que el comando exista para la unidad, esté activo y sea permitido al actor."""
    id_vehiculo = int(vehiculo["id_vehiculo"])
    cursor.execute(
        """
        SELECT id_comando, id_vehiculo, nombre, codigo, descripcion, activo
        FROM comandos
        WHERE id_comando = %s AND id_vehiculo = %s
        LIMIT 1
        """,
        (id_comando, id_vehiculo),
    )
    cmd = cursor.fetchone()
    if not cmd:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"El comando {id_comando} no existe para el vehículo {id_vehiculo}",
        )

    codigo = int(cmd.get("codigo") or 0)
    cmd_activo = bool(cmd.get("activo", 1))
    if not cmd_activo and codigo != CODIGO_DETENER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"El comando '{cmd.get('nombre')}' está deshabilitado para esta unidad",
        )

    if es_invitado:
        permitido = None
        id_modelo = vehiculo.get("id_modelo")
        if id_modelo is not None:
            cursor.execute(
                """
                SELECT permitido_invitado, activo
                FROM modelo_comandos
                WHERE id_modelo = %s AND codigo = %s
                LIMIT 1
                """,
                (int(id_modelo), codigo),
            )
            mc = cursor.fetchone()
            if mc is not None:
                permitido = bool(mc.get("activo", 1)) and bool(mc.get("permitido_invitado", 0))
        if permitido is None:
            permitido = codigo in CODIGOS_INVITADO_FALLBACK
        if not permitido:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"El rol invitado no tiene permiso para ejecutar el comando '{cmd.get('nombre')}' (código {codigo})",
            )

    return cmd


def verificar_acceso_vehiculo(
    cursor: Any,
    *,
    id_vehiculo: int,
    usuario: Optional[Dict[str, Any]] = None,
    guest_token: Optional[str] = None,
    requiere_control: bool = False,
    requiere_privacidad_vendido: bool = True,
    permitir_anonimo_legacy: Optional[bool] = None,
) -> Dict[str, Any]:
    """Evalúa RBAC, propiedad de unidad (BOLA/IDOR), consentimiento de soporte y sesión de invitado."""
    cursor.execute(
        """
        SELECT v.id_vehiculo, v.id_modelo, v.numero_serie, v.nombre, v.modelo,
               v.microcontrolador, v.activo, v.estado_inventario
        FROM vehiculos v
        WHERE v.id_vehiculo = %s
        LIMIT 1
        """,
        (id_vehiculo,),
    )
    vehiculo = cursor.fetchone()
    if not vehiculo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Vehículo {id_vehiculo} no encontrado",
        )

    estado_inv = (vehiculo.get("estado_inventario") or "exhibicion").lower()
    unidad_activa = bool(vehiculo.get("activo", 1)) and estado_inv != "inactivo"
    propietario = obtener_propietario_activo(cursor, id_vehiculo)

    # 1. Prioridad de sesión temporal explícita si presenta X-Guest-Token (solo exhibición)
    if guest_token and (usuario is None or usuario.get("rol") == "invitado"):
        sesion = obtener_sesion_invitado_activa(cursor, guest_token, id_vehiculo)
        if not sesion:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Sesión temporal de invitado inexistente o expirada",
            )
        if not unidad_activa or estado_inv != "exhibicion" or propietario is not None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="La unidad ya no está disponible para prueba de exhibición",
            )
        return {
            "vehiculo": vehiculo,
            "propietario": propietario,
            "actor_tipo": "invitado",
            "es_invitado": True,
            "id_usuario": usuario["id_usuario"] if usuario else None,
            "id_sesion_invitado": int(sesion["id_sesion"]),
            "expira_en": sesion["fecha_expiracion"],
            "soporte": None,
        }

    # 2. Usuario autenticado con JWT
    if usuario is not None:
        rol = usuario.get("rol")
        if rol == "admin":
            es_unidad_vendida = propietario is not None or estado_inv == "vendido"
            soporte = None
            if es_unidad_vendida and (requiere_control or requiere_privacidad_vendido):
                soporte = obtener_autorizacion_soporte_activa(cursor, id_vehiculo)
                if not soporte:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=(
                            "El administrador no puede acceder al control o telemetría privada de "
                            "una unidad vendida sin autorización vigente del comprador."
                        ),
                    )
            if requiere_control and not unidad_activa:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="La unidad se encuentra desactivada o en baja lógica",
                )
            return {
                "vehiculo": vehiculo,
                "propietario": propietario,
                "actor_tipo": "admin_soporte" if soporte else "admin",
                "es_invitado": False,
                "id_usuario": usuario["id_usuario"],
                "id_sesion_invitado": None,
                "expira_en": soporte["fecha_expiracion"] if soporte else None,
                "soporte": soporte,
            }

        if rol == "usuario":
            if propietario is None or int(propietario["id_usuario"]) != int(usuario["id_usuario"]):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Acceso denegado (BOLA/IDOR): esta unidad no pertenece a tu cuenta",
                )
            if requiere_control and not unidad_activa:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Tu unidad se encuentra inactiva actualmente",
                )
            return {
                "vehiculo": vehiculo,
                "propietario": propietario,
                "actor_tipo": "propietario",
                "es_invitado": False,
                "id_usuario": usuario["id_usuario"],
                "id_sesion_invitado": None,
                "expira_en": None,
                "soporte": None,
            }

        if rol == "invitado":
            # El usuario invitado sin un guest_token vigente para esta unidad queda bloqueado
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="El rol invitado requiere una reserva temporal activa sobre la unidad de exhibición",
            )

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Rol sin permisos para acceder al vehículo",
        )

    # 3. Modo legacy opcional explícito (solo si ALLOW_LEGACY_ANON=true en .env)
    modo_legacy = settings.allow_legacy_anon if permitir_anonimo_legacy is None else permitir_anonimo_legacy
    if modo_legacy:
        return {
            "vehiculo": vehiculo,
            "propietario": propietario,
            "actor_tipo": "legacy_anon",
            "es_invitado": False,
            "id_usuario": None,
            "id_sesion_invitado": None,
            "expira_en": None,
            "soporte": None,
        }

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Se requiere autenticación Bearer o sesión temporal X-Guest-Token válida",
        headers={"WWW-Authenticate": "Bearer"},
    )
