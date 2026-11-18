"""Router de Usuario / Comprador: Mis vehículos, demos privadas y consentimiento explícito de soporte."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import obtener_conexion
from app.core.security import (
    ahora_utc_naive,
    obtener_autorizacion_soporte_activa,
    obtener_ip_cliente,
    obtener_propietario_activo,
    registrar_auditoria,
    requerir_roles,
    serializar_utc_iso,
)
from app.core.ws_manager import ws_manager
from app.models.schemas import (
    AutorizacionSoporteRequest,
    DemoActualizarRequest,
    DemoCrearRequest,
)

router = APIRouter(
    prefix="/usuario",
    tags=["Comprador (Mis Unidades, Demos Privadas y Soporte)"],
    dependencies=[Depends(requerir_roles(["usuario"]))],
)


def _verificar_propiedad_unidad(cur, id_vehiculo: int, id_usuario: int) -> dict:
    cur.execute("SELECT id_vehiculo, nombre, estado_inventario FROM vehiculos WHERE id_vehiculo = %s", (id_vehiculo,))
    veh = cur.fetchone()
    if not veh:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehículo no encontrado")
    prop = obtener_propietario_activo(cur, id_vehiculo)
    if not prop or int(prop["id_usuario"]) != int(id_usuario):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acceso denegado (BOLA/IDOR): esta unidad no pertenece al comprador autenticado",
        )
    return veh


@router.get("/mis-vehiculos")
def listar_mis_vehiculos(usuario: dict = Depends(requerir_roles(["usuario"]))):
    """Lista exclusivamente las unidades asignadas al comprador actual (cero fallback a unidad 1)."""
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT v.id_vehiculo, v.id_modelo, v.numero_serie, v.nombre, v.modelo,
                       v.descripcion, v.microcontrolador, v.estado_inventario, v.activo,
                       m.nombre_comercial, m.imagen_url,
                       a.fecha_asignacion, a.notas,
                       (
                         SELECT s.fecha_expiracion
                         FROM soporte_autorizaciones s
                         WHERE s.id_vehiculo = v.id_vehiculo
                           AND s.id_usuario_dueno = %s
                           AND s.activo = 1
                           AND s.fecha_expiracion > UTC_TIMESTAMP()
                         ORDER BY s.id_soporte DESC
                         LIMIT 1
                       ) AS soporte_expira_en
                FROM asignaciones_vehiculo a
                INNER JOIN vehiculos v ON v.id_vehiculo = a.id_vehiculo
                LEFT JOIN modelos_vehiculo m ON m.id_modelo = v.id_modelo
                WHERE a.id_usuario = %s
                  AND a.estado = 'activo'
                  AND v.estado_inventario != 'inactivo'
                ORDER BY v.id_vehiculo ASC
                """,
                (usuario["id_usuario"], usuario["id_usuario"]),
            )
            filas = cur.fetchall()
            items = []
            for f in filas:
                item = dict(f)
                for k, val in list(item.items()):
                    if hasattr(val, "isoformat"):
                        item[k] = serializar_utc_iso(val)
                item["soporte_activo"] = bool(item.get("soporte_expira_en"))
                items.append(item)

    return {"total": len(items), "items": items}


# ---------------------------------------------------------------------------
# Consentimiento Explícito de Soporte Técnico
# ---------------------------------------------------------------------------
@router.get("/soporte/{id_vehiculo}")
def estado_soporte_unidad(id_vehiculo: int, usuario: dict = Depends(requerir_roles(["usuario"]))):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            _verificar_propiedad_unidad(cur, id_vehiculo, usuario["id_usuario"])
            soporte = obtener_autorizacion_soporte_activa(cur, id_vehiculo)
            if not soporte:
                return {"id_vehiculo": id_vehiculo, "soporte_activo": False, "autorizacion": None}
            return {
                "id_vehiculo": id_vehiculo,
                "soporte_activo": True,
                "autorizacion": {
                    "id_soporte": soporte["id_soporte"],
                    "motivo": soporte["motivo"],
                    "fecha_inicio": serializar_utc_iso(soporte["fecha_inicio"]),
                    "fecha_expiracion": serializar_utc_iso(soporte["fecha_expiracion"]),
                },
            }


@router.post("/soporte/{id_vehiculo}/autorizar", status_code=status.HTTP_201_CREATED)
def autorizar_soporte(
    id_vehiculo: int,
    payload: AutorizacionSoporteRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["usuario"])),
):
    ip_origen = obtener_ip_cliente(request)
    inicio_utc = ahora_utc_naive()
    expira_utc = inicio_utc + timedelta(minutes=payload.duracion_minutos)

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            _verificar_propiedad_unidad(cur, id_vehiculo, usuario["id_usuario"])
            cur.execute(
                "UPDATE soporte_autorizaciones SET activo = 0 WHERE id_vehiculo = %s AND activo = 1",
                (id_vehiculo,),
            )
            cur.execute(
                """
                INSERT INTO soporte_autorizaciones
                    (id_vehiculo, id_usuario_dueno, motivo, activo, fecha_inicio, fecha_expiracion)
                VALUES (%s, %s, %s, 1, %s, %s)
                """,
                (id_vehiculo, usuario["id_usuario"], payload.motivo.strip(), inicio_utc, expira_utc),
            )
            id_soporte = int(cur.lastrowid)
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="AUTORIZAR_SOPORTE_ADMIN",
                entidad_afectada="VEHICULO",
                id_entidad=id_vehiculo,
                detalles={"id_soporte": id_soporte, "duracion_minutos": payload.duracion_minutos, "motivo": payload.motivo},
                ip_origen=ip_origen,
            )
            conn.commit()

    return {
        "mensaje": "Soporte técnico autorizado temporalmente para el administrador",
        "id_soporte": id_soporte,
        "id_vehiculo": id_vehiculo,
        "fecha_expiracion": serializar_utc_iso(expira_utc),
    }


@router.post("/soporte/{id_vehiculo}/revocar")
async def revocar_soporte(
    id_vehiculo: int,
    request: Request,
    usuario: dict = Depends(requerir_roles(["usuario"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            _verificar_propiedad_unidad(cur, id_vehiculo, usuario["id_usuario"])
            cur.execute(
                "UPDATE soporte_autorizaciones SET activo = 0 WHERE id_vehiculo = %s AND activo = 1",
                (id_vehiculo,),
            )
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="REVOCAR_SOPORTE_ADMIN",
                entidad_afectada="VEHICULO",
                id_entidad=id_vehiculo,
                detalles={"motivo": "Revocado manualmente por el propietario"},
                ip_origen=ip_origen,
            )
            conn.commit()

    await ws_manager.revocar_conexiones(
        id_vehiculo,
        actor_tipos={"admin_soporte"},
        motivo="Autorización de soporte revocada por el comprador",
        code=4003,
    )
    return {"mensaje": "Autorización de soporte revocada inmediatamente", "id_vehiculo": id_vehiculo}


# ---------------------------------------------------------------------------
# Demos Privadas y de Fábrica del Comprador
# ---------------------------------------------------------------------------
@router.get("/demos/{id_vehiculo}")
def listar_demos_comprador(id_vehiculo: int, usuario: dict = Depends(requerir_roles(["usuario"]))):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            _verificar_propiedad_unidad(cur, id_vehiculo, usuario["id_usuario"])
            cur.execute(
                """
                SELECT id_demo, id_vehiculo, nombre, descripcion, es_fabrica, id_usuario
                FROM demos
                WHERE id_vehiculo = %s
                  AND activo = 1
                  AND (es_fabrica = 1 OR id_usuario = %s)
                ORDER BY id_demo ASC
                """,
                (id_vehiculo, usuario["id_usuario"]),
            )
            demos = cur.fetchall()
            for demo in demos:
                cur.execute(
                    """
                    SELECT dm.id_movimiento_demo, dm.id_comando, dm.orden, dm.duracion_ms,
                           c.nombre AS nombre_comando, c.codigo AS codigo_comando
                    FROM demo_movimientos dm
                    INNER JOIN comandos c ON c.id_comando = dm.id_comando
                    WHERE dm.id_demo = %s
                    ORDER BY dm.orden ASC
                    """,
                    (demo["id_demo"],),
                )
                demo["pasos"] = cur.fetchall()
    return {"id_vehiculo": id_vehiculo, "total": len(demos), "items": demos}


@router.post("/demos", status_code=status.HTTP_201_CREATED)
def crear_demo_privada(
    payload: DemoCrearRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["usuario"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            _verificar_propiedad_unidad(cur, payload.id_vehiculo, usuario["id_usuario"])

            for paso in payload.pasos:
                cur.execute(
                    "SELECT id_comando FROM comandos WHERE id_comando = %s AND id_vehiculo = %s AND activo = 1",
                    (paso.id_comando, payload.id_vehiculo),
                )
                if not cur.fetchone():
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"El comando {paso.id_comando} no existe o no está activo en tu unidad",
                    )

            cur.execute(
                """
                INSERT INTO demos (id_vehiculo, nombre, descripcion, es_fabrica, id_usuario, activo)
                VALUES (%s, %s, %s, 0, %s, 1)
                """,
                (payload.id_vehiculo, payload.nombre.strip(), payload.descripcion or "", usuario["id_usuario"]),
            )
            id_demo = int(cur.lastrowid)

            for paso in sorted(payload.pasos, key=lambda p: p.orden):
                cur.execute(
                    """
                    INSERT INTO demo_movimientos (id_demo, id_comando, orden, duracion_ms, pausa_ms)
                    VALUES (%s, %s, %s, %s, 0)
                    """,
                    (id_demo, paso.id_comando, paso.orden, paso.duracion_ms),
                )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="CREAR_DEMO_PRIVADA",
                entidad_afectada="DEMO",
                id_entidad=id_demo,
                detalles={"id_vehiculo": payload.id_vehiculo, "nombre": payload.nombre, "pasos": len(payload.pasos)},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Demo privada guardada correctamente", "id_demo": id_demo}


@router.put("/demos/{id_demo}")
def actualizar_demo_privada(
    id_demo: int,
    payload: DemoActualizarRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["usuario"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id_demo, id_vehiculo, es_fabrica, id_usuario, activo FROM demos WHERE id_demo = %s",
                (id_demo,),
            )
            demo = cur.fetchone()
            if not demo or not bool(demo.get("activo", 1)):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Demo no encontrada")
            if bool(demo.get("es_fabrica")) or int(demo.get("id_usuario") or 0) != usuario["id_usuario"]:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="No tienes permiso para modificar demos de fábrica ni rutinas de otro comprador",
                )

            _verificar_propiedad_unidad(cur, int(demo["id_vehiculo"]), usuario["id_usuario"])

            for paso in payload.pasos:
                cur.execute(
                    "SELECT id_comando FROM comandos WHERE id_comando = %s AND id_vehiculo = %s AND activo = 1",
                    (paso.id_comando, demo["id_vehiculo"]),
                )
                if not cur.fetchone():
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"El comando {paso.id_comando} no está disponible en esa unidad",
                    )

            cur.execute(
                "UPDATE demos SET nombre = %s, descripcion = %s WHERE id_demo = %s",
                (payload.nombre.strip(), payload.descripcion or "", id_demo),
            )
            cur.execute("DELETE FROM demo_movimientos WHERE id_demo = %s", (id_demo,))
            for paso in sorted(payload.pasos, key=lambda p: p.orden):
                cur.execute(
                    """
                    INSERT INTO demo_movimientos (id_demo, id_comando, orden, duracion_ms, pausa_ms)
                    VALUES (%s, %s, %s, %s, 0)
                    """,
                    (id_demo, paso.id_comando, paso.orden, paso.duracion_ms),
                )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ACTUALIZAR_DEMO_PRIVADA",
                entidad_afectada="DEMO",
                id_entidad=id_demo,
                detalles={"nombre": payload.nombre, "pasos": len(payload.pasos)},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Demo privada actualizada", "id_demo": id_demo}


@router.delete("/demos/{id_demo}")
def eliminar_demo_privada(
    id_demo: int,
    request: Request,
    usuario: dict = Depends(requerir_roles(["usuario"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id_demo, id_vehiculo, es_fabrica, id_usuario, activo FROM demos WHERE id_demo = %s",
                (id_demo,),
            )
            demo = cur.fetchone()
            if not demo or not bool(demo.get("activo", 1)):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Demo no encontrada")
            if bool(demo.get("es_fabrica")) or int(demo.get("id_usuario") or 0) != usuario["id_usuario"]:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="No tienes permiso para eliminar demos de fábrica ni de otro usuario",
                )

            _verificar_propiedad_unidad(cur, int(demo["id_vehiculo"]), usuario["id_usuario"])
            cur.execute("UPDATE demos SET activo = 0 WHERE id_demo = %s", (id_demo,))
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ELIMINAR_DEMO_PRIVADA",
                entidad_afectada="DEMO",
                id_entidad=id_demo,
                detalles={"id_vehiculo": demo["id_vehiculo"]},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Demo privada eliminada correctamente", "id_demo": id_demo}
