"""Router de Invitado: Catálogo público comercial y reserva temporal exclusiva en exhibición."""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from app.core.config import settings
from app.core.db import obtener_conexion
from app.core.security import (
    CODIGOS_INVITADO_FALLBACK,
    ahora_utc_naive,
    obtener_ip_cliente,
    obtener_usuario_opcional,
    registrar_auditoria,
    serializar_utc_iso,
)
from app.core.ws_manager import emitir_detener_seguridad, ws_manager
from app.models.schemas import SolicitudPruebaRequest

router = APIRouter(prefix="/invitado", tags=["Catálogo y Prueba de Invitado"])


@router.get("/catalogo")
def consultar_catalogo():
    """Catálogo público comercial sin exponer datos privados ni inventario vendido."""
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            # Limpiar sesiones expiradas para informar disponibilidad exacta
            cur.execute(
                """
                UPDATE sesiones_invitado
                SET activa = 0
                WHERE activa = 1 AND fecha_expiracion <= UTC_TIMESTAMP()
                """
            )
            conn.commit()

            cur.execute(
                """
                SELECT m.id_modelo, m.nombre_comercial, m.descripcion, m.tipo_microcontrolador, m.imagen_url,
                       (
                         SELECT v.id_vehiculo
                         FROM vehiculos v
                         WHERE v.id_modelo = m.id_modelo
                           AND v.estado_inventario = 'exhibicion'
                           AND v.activo = 1
                         ORDER BY v.id_vehiculo ASC
                         LIMIT 1
                       ) AS id_vehiculo_exhibicion,
                       (
                         SELECT v.nombre
                         FROM vehiculos v
                         WHERE v.id_modelo = m.id_modelo
                           AND v.estado_inventario = 'exhibicion'
                           AND v.activo = 1
                         ORDER BY v.id_vehiculo ASC
                         LIMIT 1
                       ) AS nombre_unidad_exhibicion,
                       (
                         SELECT COUNT(*)
                         FROM vehiculos v
                         INNER JOIN sesiones_invitado s ON s.id_vehiculo = v.id_vehiculo
                         WHERE v.id_modelo = m.id_modelo
                           AND v.estado_inventario = 'exhibicion'
                           AND s.activa = 1
                           AND s.fecha_expiracion > UTC_TIMESTAMP()
                       ) AS sesion_ocupada
                FROM modelos_vehiculo m
                WHERE m.activo = 1
                ORDER BY m.id_modelo ASC
                """
            )
            modelos = cur.fetchall()
            for mod in modelos:
                cur.execute(
                    """
                    SELECT nombre, codigo, descripcion
                    FROM modelo_comandos
                    WHERE id_modelo = %s AND activo = 1 AND permitido_invitado = 1
                    ORDER BY codigo ASC
                    """,
                    (mod["id_modelo"],),
                )
                mod["comandos_invitado"] = cur.fetchall()
                mod["exhibicion_disponible"] = (
                    mod["id_vehiculo_exhibicion"] is not None and int(mod.get("sesion_ocupada") or 0) == 0
                )

    return {"modelos": modelos, "duracion_prueba_minutos": settings.guest_session_minutes}


@router.post("/solicitar-prueba", status_code=status.HTTP_201_CREATED)
def solicitar_prueba_exhibicion(
    payload: SolicitudPruebaRequest,
    request: Request,
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    """Reserva exclusivamente una unidad en estado 'exhibicion' durante GUEST_SESSION_MINUTES."""
    ip_origen = obtener_ip_cliente(request)
    duracion_min = settings.guest_session_minutes

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            # 1. Localizar unidad de exhibición con bloqueo de fila FOR UPDATE para evitar carrera
            if payload.id_vehiculo is not None:
                cur.execute(
                    """
                    SELECT v.id_vehiculo, v.id_modelo, v.nombre, v.estado_inventario, v.activo,
                           m.nombre_comercial
                    FROM vehiculos v
                    LEFT JOIN modelos_vehiculo m ON m.id_modelo = v.id_modelo
                    WHERE v.id_vehiculo = %s
                    FOR UPDATE
                    """,
                    (payload.id_vehiculo,),
                )
            elif payload.id_modelo is not None:
                cur.execute(
                    """
                    SELECT v.id_vehiculo, v.id_modelo, v.nombre, v.estado_inventario, v.activo,
                           m.nombre_comercial
                    FROM vehiculos v
                    LEFT JOIN modelos_vehiculo m ON m.id_modelo = v.id_modelo
                    WHERE v.id_modelo = %s
                      AND v.estado_inventario = 'exhibicion'
                      AND v.activo = 1
                    ORDER BY v.id_vehiculo ASC
                    LIMIT 1
                    FOR UPDATE
                    """,
                    (payload.id_modelo,),
                )
            else:
                cur.execute(
                    """
                    SELECT v.id_vehiculo, v.id_modelo, v.nombre, v.estado_inventario, v.activo,
                           m.nombre_comercial
                    FROM vehiculos v
                    LEFT JOIN modelos_vehiculo m ON m.id_modelo = v.id_modelo
                    WHERE v.estado_inventario = 'exhibicion'
                      AND v.activo = 1
                    ORDER BY v.id_vehiculo ASC
                    LIMIT 1
                    FOR UPDATE
                    """
                )

            unidad = cur.fetchone()
            if not unidad:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="No hay ninguna unidad en exhibición habilitada para este modelo",
                )

            if unidad.get("estado_inventario") != "exhibicion" or not bool(unidad.get("activo", 1)):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Solo las unidades con estado 'exhibicion' admiten pruebas de invitado",
                )

            id_vehiculo = int(unidad["id_vehiculo"])

            # 2. Expirar sesiones vencidas previas de esta unidad
            cur.execute(
                """
                UPDATE sesiones_invitado
                SET activa = 0
                WHERE id_vehiculo = %s AND activa = 1 AND fecha_expiracion <= UTC_TIMESTAMP()
                """,
                (id_vehiculo,),
            )

            # 3. Verificar exclusividad estricta (409 Conflict si ya está ocupada)
            cur.execute(
                """
                SELECT id_sesion, alias_cliente, fecha_expiracion
                FROM sesiones_invitado
                WHERE id_vehiculo = %s AND activa = 1 AND fecha_expiracion > UTC_TIMESTAMP()
                LIMIT 1
                """,
                (id_vehiculo,),
            )
            activa = cur.fetchone()
            if activa:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"Unidad de exhibición ocupada actualmente hasta "
                        f"{serializar_utc_iso(activa['fecha_expiracion'])}. Intenta más tarde."
                    ),
                )

            # 4. Crear sesión temporal UTC
            token_sesion = secrets.token_urlsafe(32)
            inicio_utc = ahora_utc_naive()
            expira_utc = inicio_utc + timedelta(minutes=duracion_min)

            cur.execute(
                """
                INSERT INTO sesiones_invitado
                    (id_vehiculo, token_sesion, alias_cliente, fecha_inicio, fecha_expiracion, activa, ip_origen)
                VALUES (%s, %s, %s, %s, %s, 1, %s)
                """,
                (id_vehiculo, token_sesion, payload.alias_cliente.strip(), inicio_utc, expira_utc, ip_origen),
            )
            id_sesion = int(cur.lastrowid)

            # Consultar códigos permitidos para este invitado
            if unidad.get("id_modelo"):
                cur.execute(
                    """
                    SELECT codigo
                    FROM modelo_comandos
                    WHERE id_modelo = %s AND activo = 1 AND permitido_invitado = 1
                    """,
                    (unidad["id_modelo"],),
                )
                cods = [int(r["codigo"]) for r in cur.fetchall()]
            else:
                cods = sorted(CODIGOS_INVITADO_FALLBACK)
            if not cods:
                cods = sorted(CODIGOS_INVITADO_FALLBACK)

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"] if usuario else None,
                accion="INICIO_PRUEBA_INVITADO",
                entidad_afectada="SESION_INVITADO",
                id_entidad=id_sesion,
                detalles={
                    "id_vehiculo": id_vehiculo,
                    "alias": payload.alias_cliente.strip(),
                    "expira_en": serializar_utc_iso(expira_utc),
                },
                ip_origen=ip_origen,
            )
            conn.commit()

    return {
        "mensaje": "Sesión de prueba concedida exclusivamente",
        "id_sesion": id_sesion,
        "id_vehiculo": id_vehiculo,
        "nombre_vehiculo": unidad["nombre"],
        "nombre_comercial": unidad.get("nombre_comercial") or unidad["nombre"],
        "token_sesion": token_sesion,
        "fecha_inicio": serializar_utc_iso(inicio_utc),
        "fecha_expiracion": serializar_utc_iso(expira_utc),
        "duracion_segundos": duracion_min * 60,
        "codigos_permitidos": cods,
    }


@router.post("/finalizar-prueba/{id_sesion}")
async def finalizar_prueba_exhibicion(
    id_sesion: int,
    request: Request,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    """Cierra la sesión temporal, envía DETENER (9) por seguridad y revoca WebSockets del invitado."""
    ip_origen = obtener_ip_cliente(request)
    es_admin = usuario is not None and usuario.get("rol") == "admin"

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id_sesion, id_vehiculo, token_sesion, activa
                FROM sesiones_invitado
                WHERE id_sesion = %s
                LIMIT 1
                """,
                (id_sesion,),
            )
            sesion = cur.fetchone()
            if not sesion:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sesión de prueba no encontrada")

            if not es_admin:
                if not x_guest_token or not secrets.compare_digest(x_guest_token, sesion["token_sesion"]):
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Token X-Guest-Token faltante o inválido para finalizar esta sesión",
                    )

            id_vehiculo = int(sesion["id_vehiculo"])
            cur.execute("UPDATE sesiones_invitado SET activa = 0 WHERE id_sesion = %s", (id_sesion,))
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"] if usuario else None,
                accion="FIN_PRUEBA_INVITADO",
                entidad_afectada="SESION_INVITADO",
                id_entidad=id_sesion,
                detalles={"id_vehiculo": id_vehiculo, "cerrado_por": "admin" if es_admin else "invitado"},
                ip_origen=ip_origen,
            )
            conn.commit()

        await emitir_detener_seguridad(
            conn,
            id_vehiculo,
            origen="FIN_PRUEBA_INVITADO",
            id_usuario=usuario["id_usuario"] if usuario else None,
            motivo="Finalización de sesión temporal de invitado",
        )
        await ws_manager.revocar_conexiones(
            id_vehiculo,
            id_sesion_invitado=id_sesion,
            motivo="Prueba de invitado finalizada",
            code=4008,
        )

    return {"mensaje": "Sesión temporal cerrada y vehículo detenido con seguridad", "id_sesion": id_sesion}
