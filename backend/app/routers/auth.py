"""Router de autenticación: login, perfil actual y revocación persistente de logout."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import obtener_conexion
from app.core.security import (
    crear_token_acceso,
    obtener_ip_cliente,
    obtener_usuario_actual,
    registrar_auditoria,
    serializar_utc_iso,
    verificar_password,
)
from app.models.schemas import LoginRequest, TokenResponse, UsuarioActualResponse

router = APIRouter(prefix="/auth", tags=["Autenticación y Sesión"])


@router.post("/login", response_model=TokenResponse)
def iniciar_sesion(payload: LoginRequest, request: Request):
    """Autentica usuario con hash PBKDF2/Bcrypt estricto y emite JWT con jti revocable."""
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id_usuario, u.email, u.password_hash, u.nombre_completo, u.activo,
                       r.clave AS rol, r.nombre AS rol_nombre
                FROM usuarios u
                INNER JOIN roles r ON r.id_rol = u.id_rol
                WHERE u.email = %s
                LIMIT 1
                """,
                (payload.email,),
            )
            usuario = cur.fetchone()

            if not usuario or not bool(usuario.get("activo")):
                registrar_auditoria(
                    cur,
                    id_usuario=int(usuario["id_usuario"]) if usuario else None,
                    accion="LOGIN_RECHAZADO",
                    entidad_afectada="USUARIO",
                    id_entidad=int(usuario["id_usuario"]) if usuario else None,
                    detalles={"email": payload.email, "motivo": "Usuario inexistente o inactivo"},
                    ip_origen=ip_origen,
                )
                conn.commit()
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Credenciales inválidas o cuenta desactivada",
                )

            if not verificar_password(payload.password, usuario.get("password_hash") or ""):
                registrar_auditoria(
                    cur,
                    id_usuario=int(usuario["id_usuario"]),
                    accion="LOGIN_PASSWORD_INCORRECTO",
                    entidad_afectada="USUARIO",
                    id_entidad=int(usuario["id_usuario"]),
                    detalles={"email": payload.email},
                    ip_origen=ip_origen,
                )
                conn.commit()
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Correo o contraseña incorrectos",
                )

            token_info = crear_token_acceso(
                id_usuario=int(usuario["id_usuario"]),
                email=usuario["email"],
                rol=usuario["rol"],
                nombre_completo=usuario["nombre_completo"],
            )

            registrar_auditoria(
                cur,
                id_usuario=int(usuario["id_usuario"]),
                accion="LOGIN_EXITOSO",
                entidad_afectada="SESION",
                id_entidad=int(usuario["id_usuario"]),
                detalles={"rol": usuario["rol"], "jti": token_info["jti"]},
                ip_origen=ip_origen,
            )
            conn.commit()

    return {
        "access_token": token_info["access_token"],
        "token_type": "bearer",
        "expira_en": token_info["expira_en"],
        "usuario": {
            "id_usuario": int(usuario["id_usuario"]),
            "email": usuario["email"],
            "nombre_completo": usuario["nombre_completo"],
            "rol": usuario["rol"],
            "rol_nombre": usuario.get("rol_nombre"),
        },
    }


@router.get("/me", response_model=UsuarioActualResponse)
def perfil_actual(usuario: dict = Depends(obtener_usuario_actual)):
    """Devuelve el perfil autenticado verificado contra base de datos."""
    return {
        "id_usuario": usuario["id_usuario"],
        "email": usuario["email"],
        "nombre_completo": usuario["nombre_completo"],
        "rol": usuario["rol"],
        "rol_nombre": usuario.get("rol_nombre"),
    }


@router.post("/logout")
def cerrar_sesion(request: Request, usuario: dict = Depends(obtener_usuario_actual)):
    """Revoca persistentemente el JWT actual registrando su jti en tokens_revocados."""
    jti = usuario.get("jti")
    exp_ts = usuario.get("exp")
    fecha_exp = (
        datetime.fromtimestamp(int(exp_ts), tz=timezone.utc).replace(tzinfo=None)
        if exp_ts
        else None
    )
    ip_origen = obtener_ip_cliente(request)

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            if jti:
                cur.execute(
                    """
                    INSERT IGNORE INTO tokens_revocados (jti, id_usuario, fecha_revocacion, fecha_expiracion)
                    VALUES (%s, %s, UTC_TIMESTAMP(), %s)
                    """,
                    (jti, usuario["id_usuario"], fecha_exp),
                )
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="LOGOUT_SESION",
                entidad_afectada="SESION",
                id_entidad=usuario["id_usuario"],
                detalles={"jti": jti},
                ip_origen=ip_origen,
            )
            conn.commit()

    return {
        "mensaje": "Sesión cerrada correctamente; token invalidado.",
        "revocado_en": serializar_utc_iso(datetime.now(timezone.utc)),
    }
