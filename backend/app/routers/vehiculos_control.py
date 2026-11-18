"""Router de Control (4.1) y Monitoreo (4.2) con compatibilidad REST/WSS y seguridad RBAC/BOLA."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status

from app.core.config import settings
from app.core.db import obtener_conexion
from app.core.security import (
    CODIGO_DETENER,
    obtener_ip_cliente,
    obtener_usuario_opcional,
    registrar_auditoria,
    requerir_roles,
    serializar_utc_iso,
    validar_comando_para_actor,
    verificar_acceso_vehiculo,
)
from app.core.ws_manager import controlador_tasa, gestor_demos, ws_manager
from app.models.schemas import (
    ComandoLegacyCrearRequest,
    DemoEjecutarRequest,
    EstadoLegacyCrearRequest,
    HistorialLegacyCrearRequest,
    MovimientoCrearRequest,
    VehiculoLegacyCrearRequest,
)

router = APIRouter(tags=["Control y Monitoreo IoT (4.1 / 4.2 Protegidos)"])


def _serializar_fechas_fila(fila: dict) -> dict:
    res = dict(fila)
    for clave, valor in list(res.items()):
        if hasattr(valor, "isoformat"):
            res[clave] = serializar_utc_iso(valor)
    return res


def _extraer_estado_vehiculo(cur, id_vehiculo: int) -> Optional[dict]:
    cur.execute(
        """
        SELECT v.id_vehiculo, v.nombre AS vehiculo,
               e.id_estado, e.id_comando, e.conectado, e.fecha_actualizacion,
               c.nombre AS comando, c.codigo
        FROM estado_vehiculo e
        INNER JOIN vehiculos v ON v.id_vehiculo = e.id_vehiculo
        INNER JOIN comandos c ON c.id_comando = e.id_comando
        WHERE e.id_vehiculo = %s
        ORDER BY e.id_estado DESC
        LIMIT 1
        """,
        (id_vehiculo,),
    )
    fila = cur.fetchone()
    if not fila:
        return None
    fila = _serializar_fechas_fila(fila)
    fila["origen"] = "Amazon RDS"
    return fila


async def _ejecutar_demo_async(
    id_vehiculo: int,
    id_demo: int,
    nombre_demo: str,
    pasos: list,
    cancel_event: asyncio.Event,
) -> None:
    """Ejecuta los pasos de una secuencia demo emitiendo eventos WSS sin ensuciar historial_comandos."""
    total = len(pasos)
    try:
        await ws_manager.emitir_a_vehiculo(
            id_vehiculo,
            {
                "evento": "demo_inicio",
                "id_vehiculo": id_vehiculo,
                "id_demo": id_demo,
                "nombre_demo": nombre_demo,
                "total_pasos": total,
                "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                "datos": {
                    "id_demo": id_demo,
                    "nombre_demo": nombre_demo,
                    "total_pasos": total,
                },
            },
        )

        for idx, paso in enumerate(pasos, start=1):
            if cancel_event.is_set():
                await ws_manager.emitir_a_vehiculo(
                    id_vehiculo,
                    {
                        "evento": "demo_cancelada",
                        "id_vehiculo": id_vehiculo,
                        "id_demo": id_demo,
                        "nombre_demo": nombre_demo,
                        "paso_actual": idx,
                        "total_pasos": total,
                        "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                        "datos": {
                            "id_demo": id_demo,
                            "nombre_demo": nombre_demo,
                            "paso": idx,
                            "total_pasos": total,
                        },
                    },
                )
                return

            duracion_ms = max(200, min(10000, int(paso.get("duracion_ms") or 800)))
            payload_paso = {
                "evento": "demo_movimiento",
                "id_vehiculo": id_vehiculo,
                "id_demo": id_demo,
                "nombre_demo": nombre_demo,
                "paso": int(paso.get("orden") or idx),
                "paso_actual": idx,
                "total_pasos": total,
                "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                "datos": {
                    "id_demo": id_demo,
                    "nombre_demo": nombre_demo,
                    "id_comando": int(paso["id_comando"]),
                    "comando": paso["comando"],
                    "codigo": int(paso["codigo"]),
                    "orden": int(paso.get("orden") or idx),
                    "paso_actual": idx,
                    "total_pasos": total,
                    "duracion_ms": duracion_ms,
                },
            }
            await ws_manager.emitir_a_vehiculo(id_vehiculo, payload_paso)

            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=duracion_ms / 1000.0)
                # Si cancel_event se activó durante el paso, emitir cancelación
                await ws_manager.emitir_a_vehiculo(
                    id_vehiculo,
                    {
                        "evento": "demo_cancelada",
                        "id_vehiculo": id_vehiculo,
                        "id_demo": id_demo,
                        "nombre_demo": nombre_demo,
                        "paso_actual": idx,
                        "total_pasos": total,
                        "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                        "datos": {
                            "id_demo": id_demo,
                            "nombre_demo": nombre_demo,
                            "paso": idx,
                            "total_pasos": total,
                        },
                    },
                )
                return
            except asyncio.TimeoutError:
                pass

        await ws_manager.emitir_a_vehiculo(
            id_vehiculo,
            {
                "evento": "demo_fin",
                "id_vehiculo": id_vehiculo,
                "id_demo": id_demo,
                "nombre_demo": nombre_demo,
                "total_pasos": total,
                "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                "datos": {
                    "id_demo": id_demo,
                    "nombre_demo": nombre_demo,
                    "total_pasos": total,
                },
            },
        )
    except Exception as exc:
        await ws_manager.emitir_a_vehiculo(
            id_vehiculo,
            {
                "evento": "demo_error",
                "id_vehiculo": id_vehiculo,
                "id_demo": id_demo,
                "nombre_demo": nombre_demo,
                "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                "datos": {
                    "id_demo": id_demo,
                    "nombre_demo": nombre_demo,
                    "detalle": str(exc),
                },
            },
        )
    finally:
        gestor_demos.limpiar(id_vehiculo, id_demo)


# ---------------------------------------------------------------------------
# Vehículos (Compatibles 4.1 + Seguros por Rol/Propiedad)
# ---------------------------------------------------------------------------
@router.get("/vehiculos")
def listar_vehiculos(
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    """Lista únicamente los vehículos visibles según el rol autenticado o sesión temporal."""
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            if x_guest_token and (usuario is None or usuario.get("rol") == "invitado"):
                cur.execute(
                    """
                    SELECT v.id_vehiculo, v.id_modelo, v.numero_serie, v.nombre, v.modelo,
                           v.descripcion, v.microcontrolador, v.activo, v.estado_inventario
                    FROM sesiones_invitado s
                    INNER JOIN vehiculos v ON v.id_vehiculo = s.id_vehiculo
                    WHERE s.token_sesion = %s
                      AND s.activa = 1
                      AND s.fecha_expiracion > UTC_TIMESTAMP()
                      AND v.estado_inventario = 'exhibicion'
                      AND v.activo = 1
                    """,
                    (x_guest_token,),
                )
                return [_serializar_fechas_fila(r) for r in cur.fetchall()]

            if usuario is None:
                if settings.allow_legacy_anon:
                    cur.execute("SELECT * FROM vehiculos ORDER BY id_vehiculo ASC")
                    return [_serializar_fechas_fila(r) for r in cur.fetchall()]
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Autenticación requerida para consultar vehículos",
                )

            if usuario["rol"] == "admin":
                cur.execute(
                    """
                    SELECT v.id_vehiculo, v.id_modelo, v.numero_serie, v.nombre, v.modelo,
                           v.descripcion, v.microcontrolador, v.activo, v.estado_inventario
                    FROM vehiculos v
                    ORDER BY v.id_vehiculo ASC
                    """
                )
                return [_serializar_fechas_fila(r) for r in cur.fetchall()]

            if usuario["rol"] == "usuario":
                cur.execute(
                    """
                    SELECT v.id_vehiculo, v.id_modelo, v.numero_serie, v.nombre, v.modelo,
                           v.descripcion, v.microcontrolador, v.activo, v.estado_inventario
                    FROM asignaciones_vehiculo a
                    INNER JOIN vehiculos v ON v.id_vehiculo = a.id_vehiculo
                    WHERE a.id_usuario = %s AND a.estado = 'activo' AND v.estado_inventario != 'inactivo'
                    ORDER BY v.id_vehiculo ASC
                    """,
                    (usuario["id_usuario"],),
                )
                return [_serializar_fechas_fila(r) for r in cur.fetchall()]

            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="El rol invitado debe solicitar una prueba sobre una unidad de exhibición",
            )


@router.get("/vehiculos/{id_vehiculo}")
def obtener_vehiculo(
    id_vehiculo: int,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
            return _serializar_fechas_fila(ctx["vehiculo"])


@router.post("/vehiculos", status_code=status.HTTP_201_CREATED)
def crear_vehiculo_legacy(
    payload: VehiculoLegacyCrearRequest,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO vehiculos (nombre, modelo, descripcion, microcontrolador, activo, estado_inventario)
                VALUES (%s, %s, %s, %s, 1, 'disponible')
                """,
                (payload.nombre, payload.modelo, payload.descripcion, payload.microcontrolador),
            )
            id_v = int(cur.lastrowid)
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="CREAR_VEHICULO_LEGACY",
                entidad_afectada="VEHICULO",
                id_entidad=id_v,
                detalles={"nombre": payload.nombre},
            )
            conn.commit()
    return {"mensaje": "Vehículo creado", "id_vehiculo": id_v}


@router.post("/vehiculos/{id_vehiculo}/actualizar")
def actualizar_vehiculo_legacy(
    id_vehiculo: int,
    payload: VehiculoLegacyCrearRequest,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_vehiculo FROM vehiculos WHERE id_vehiculo = %s", (id_vehiculo,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Vehículo no encontrado")
            cur.execute(
                """
                UPDATE vehiculos
                SET nombre = %s, modelo = %s, descripcion = %s, microcontrolador = %s
                WHERE id_vehiculo = %s
                """,
                (payload.nombre, payload.modelo, payload.descripcion, payload.microcontrolador, id_vehiculo),
            )
            conn.commit()
    return {"mensaje": "Vehículo actualizado", "id_vehiculo": id_vehiculo}


@router.post("/vehiculos/{id_vehiculo}/eliminar")
def eliminar_vehiculo_legacy(
    id_vehiculo: int,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE vehiculos SET estado_inventario = 'inactivo', activo = 0 WHERE id_vehiculo = %s",
                (id_vehiculo,),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Vehículo no encontrado")
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="BAJA_LOGICA_VEHICULO",
                entidad_afectada="VEHICULO",
                id_entidad=id_vehiculo,
            )
            conn.commit()
    return {"mensaje": "Vehículo dado de baja lógica", "id_vehiculo": id_vehiculo}


# ---------------------------------------------------------------------------
# Comandos
# ---------------------------------------------------------------------------
@router.get("/vehiculos/{id_vehiculo}/comandos")
def obtener_comandos_vehiculo(
    id_vehiculo: int,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
            cur.execute(
                """
                SELECT id_comando, id_vehiculo, nombre, codigo, descripcion, activo
                FROM comandos
                WHERE id_vehiculo = %s AND activo = 1
                ORDER BY codigo ASC
                """,
                (id_vehiculo,),
            )
            comandos = cur.fetchall()
            if ctx["es_invitado"]:
                id_modelo = ctx["vehiculo"].get("id_modelo")
                filtrados = []
                for cmd in comandos:
                    try:
                        validar_comando_para_actor(
                            cur,
                            vehiculo=ctx["vehiculo"],
                            id_comando=int(cmd["id_comando"]),
                            es_invitado=True,
                        )
                        filtrados.append(cmd)
                    except HTTPException:
                        continue
                return filtrados
            return comandos


@router.post("/comandos", status_code=status.HTTP_201_CREATED)
def crear_comando(payload: ComandoLegacyCrearRequest, usuario: dict = Depends(requerir_roles(["admin"]))):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO comandos (id_vehiculo, nombre, codigo, descripcion, activo)
                VALUES (%s, %s, %s, %s, 1)
                """,
                (payload.id_vehiculo, payload.nombre, payload.codigo, payload.descripcion),
            )
            id_cmd = int(cur.lastrowid)
            conn.commit()
    return {"mensaje": "Comando creado", "id_comando": id_cmd}


@router.post("/comandos/{id_comando}/actualizar")
def actualizar_comando(
    id_comando: int,
    payload: ComandoLegacyCrearRequest,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE comandos SET nombre = %s, codigo = %s, descripcion = %s
                WHERE id_comando = %s AND id_vehiculo = %s
                """,
                (payload.nombre, payload.codigo, payload.descripcion, id_comando, payload.id_vehiculo),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Comando no encontrado")
            conn.commit()
    return {"mensaje": "Comando actualizado", "id_comando": id_comando}


@router.post("/comandos/{id_comando}/eliminar")
def eliminar_comando(id_comando: int, usuario: dict = Depends(requerir_roles(["admin"]))):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE comandos SET activo = 0 WHERE id_comando = %s", (id_comando,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Comando no encontrado")
            conn.commit()
    return {"mensaje": "Comando desactivado", "id_comando": id_comando}


# ---------------------------------------------------------------------------
# Estado, Historial y Movimientos en Tiempo Real
# ---------------------------------------------------------------------------
@router.get("/vehiculos/{id_vehiculo}/estado")
def obtener_estado_vehiculo(
    id_vehiculo: int,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            verificar_acceso_vehiculo(
                cur,
                id_vehiculo=id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
            estado = _extraer_estado_vehiculo(cur, id_vehiculo)
            if not estado:
                raise HTTPException(status_code=404, detail="Sin estado registrado aún para esta unidad")
            return estado


@router.post("/estado")
def actualizar_estado_vehiculo(
    payload: EstadoLegacyCrearRequest,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            verificar_acceso_vehiculo(
                cur,
                id_vehiculo=payload.id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=True,
            )
            cur.execute("SELECT id_estado FROM estado_vehiculo WHERE id_vehiculo = %s LIMIT 1", (payload.id_vehiculo,))
            existe = cur.fetchone()
            if existe:
                cur.execute(
                    """
                    UPDATE estado_vehiculo
                    SET id_comando = %s, conectado = %s, fecha_actualizacion = NOW()
                    WHERE id_vehiculo = %s
                    """,
                    (payload.id_comando, payload.conectado, payload.id_vehiculo),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO estado_vehiculo (id_vehiculo, id_comando, conectado, fecha_actualizacion)
                    VALUES (%s, %s, %s, NOW())
                    """,
                    (payload.id_vehiculo, payload.id_comando, payload.conectado),
                )
            conn.commit()
    return {"mensaje": "Estado actualizado"}


@router.get("/vehiculos/{id_vehiculo}/historial")
def obtener_historial_vehiculo(
    id_vehiculo: int,
    limit: int = Query(default=10, ge=1, le=50),
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            verificar_acceso_vehiculo(
                cur,
                id_vehiculo=id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
            cur.execute(
                """
                SELECT h.id_historial, h.id_vehiculo, h.id_comando, h.origen, h.fecha_hora,
                       c.nombre AS comando, c.codigo
                FROM historial_comandos h
                INNER JOIN comandos c ON c.id_comando = h.id_comando
                WHERE h.id_vehiculo = %s
                ORDER BY h.id_historial DESC
                LIMIT %s
                """,
                (id_vehiculo, limit),
            )
            movimientos = [_serializar_fechas_fila(r) for r in cur.fetchall()]
    return {"id_vehiculo": id_vehiculo, "movimientos": movimientos}


@router.post("/historial", status_code=status.HTTP_201_CREATED)
def registrar_historial_manual(
    payload: HistorialLegacyCrearRequest,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=payload.id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=True,
            )
            validar_comando_para_actor(
                cur,
                vehiculo=ctx["vehiculo"],
                id_comando=payload.id_comando,
                es_invitado=ctx["es_invitado"],
            )
            cur.execute(
                """
                INSERT INTO historial_comandos (id_vehiculo, id_comando, origen, fecha_hora)
                VALUES (%s, %s, %s, NOW())
                """,
                (payload.id_vehiculo, payload.id_comando, payload.origen),
            )
            id_h = int(cur.lastrowid)
            conn.commit()
    return {"mensaje": "Historial registrado", "id_historial": id_h}


@router.post("/movimientos", status_code=status.HTTP_201_CREATED)
async def enviar_movimiento(
    payload: MovimientoCrearRequest,
    request: Request,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    """Ejecuta un movimiento individual en el vehículo, persiste historial/estado y emite WSS."""
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=payload.id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=True,
            )
            cmd = validar_comando_para_actor(
                cur,
                vehiculo=ctx["vehiculo"],
                id_comando=payload.id_comando,
                es_invitado=ctx["es_invitado"],
            )

            clave_tasa = f"{ctx['actor_tipo']}:{ctx['id_usuario'] or x_guest_token or ip_origen}:{payload.id_vehiculo}"
            if not controlador_tasa.verificar_y_registrar(
                clave_tasa,
                id_comando=int(cmd["id_comando"]),
                codigo=int(cmd["codigo"]),
            ):
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Límite de ráfaga de comandos excedido. Reduce la frecuencia.",
                )

            # Prioridad absoluta a DETENER (9): cancela inmediatamente cualquier secuencia demo activa
            if int(cmd["codigo"]) == CODIGO_DETENER:
                gestor_demos.solicitar_cancelacion(payload.id_vehiculo)

            origen_final = payload.origen.strip()[:40]
            if ctx["actor_tipo"] == "invitado":
                origen_final = f"INVITADO_{origen_final}"[:40]
            elif ctx["actor_tipo"] == "admin_soporte":
                origen_final = f"SOPORTE_{origen_final}"[:40]

            cur.execute(
                """
                INSERT INTO historial_comandos (id_vehiculo, id_comando, origen, fecha_hora)
                VALUES (%s, %s, %s, NOW())
                """,
                (payload.id_vehiculo, int(cmd["id_comando"]), origen_final),
            )
            id_historial = int(cur.lastrowid)

            cur.execute(
                "SELECT id_estado FROM estado_vehiculo WHERE id_vehiculo = %s LIMIT 1",
                (payload.id_vehiculo,),
            )
            if cur.fetchone():
                cur.execute(
                    """
                    UPDATE estado_vehiculo
                    SET id_comando = %s, conectado = 1, fecha_actualizacion = NOW()
                    WHERE id_vehiculo = %s
                    """,
                    (int(cmd["id_comando"]), payload.id_vehiculo),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO estado_vehiculo (id_vehiculo, id_comando, conectado, fecha_actualizacion)
                    VALUES (%s, %s, 1, NOW())
                    """,
                    (payload.id_vehiculo, int(cmd["id_comando"])),
                )

            cur.execute(
                "SELECT fecha_hora FROM historial_comandos WHERE id_historial = %s LIMIT 1",
                (id_historial,),
            )
            hist_row = cur.fetchone() or {}
            fecha_iso = serializar_utc_iso(hist_row.get("fecha_hora")) or serializar_utc_iso(
                datetime.now(timezone.utc)
            )

            if ctx["actor_tipo"] == "admin_soporte":
                registrar_auditoria(
                    cur,
                    id_usuario=ctx["id_usuario"],
                    accion="MOVIMIENTO_SOPORTE_AUTORIZADO",
                    entidad_afectada="VEHICULO",
                    id_entidad=payload.id_vehiculo,
                    detalles={"id_comando": int(cmd["id_comando"]), "comando": cmd["nombre"], "codigo": int(cmd["codigo"])},
                    ip_origen=ip_origen,
                )

            conn.commit()

    evento_ws = {
        "evento": "movimiento_individual",
        "id_vehiculo": payload.id_vehiculo,
        "timestamp": fecha_iso,
        "datos": {
            "id_historial": id_historial,
            "id_vehiculo": payload.id_vehiculo,
            "vehiculo": ctx["vehiculo"]["nombre"],
            "id_comando": int(cmd["id_comando"]),
            "comando": cmd["nombre"],
            "codigo": int(cmd["codigo"]),
            "origen": origen_final,
            "conectado": 1,
            "fecha_hora": fecha_iso,
        },
    }
    await ws_manager.emitir_a_vehiculo(payload.id_vehiculo, evento_ws)

    return {
        "mensaje": "Movimiento enviado correctamente",
        "id_historial": id_historial,
        "id_vehiculo": payload.id_vehiculo,
        "id_comando": int(cmd["id_comando"]),
        "comando": cmd["nombre"],
        "codigo": int(cmd["codigo"]),
        "origen": origen_final,
        "fecha_hora": fecha_iso,
    }


# ---------------------------------------------------------------------------
# Demos (Consulta, Ejecución WSS y Cancelación Segura)
# ---------------------------------------------------------------------------
@router.get("/vehiculos/{id_vehiculo}/demos")
def obtener_demos_vehiculo(
    id_vehiculo: int,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
            if ctx["es_invitado"]:
                cur.execute(
                    """
                    SELECT id_demo, id_vehiculo, nombre, descripcion, es_fabrica, id_usuario, activo
                    FROM demos
                    WHERE id_vehiculo = %s AND activo = 1 AND es_fabrica = 1
                    ORDER BY id_demo ASC
                    """,
                    (id_vehiculo,),
                )
            elif ctx["actor_tipo"] == "propietario":
                cur.execute(
                    """
                    SELECT id_demo, id_vehiculo, nombre, descripcion, es_fabrica, id_usuario, activo
                    FROM demos
                    WHERE id_vehiculo = %s AND activo = 1 AND (es_fabrica = 1 OR id_usuario = %s)
                    ORDER BY id_demo ASC
                    """,
                    (id_vehiculo, ctx["id_usuario"]),
                )
            else:
                cur.execute(
                    """
                    SELECT id_demo, id_vehiculo, nombre, descripcion, es_fabrica, id_usuario, activo
                    FROM demos
                    WHERE id_vehiculo = %s AND activo = 1
                    ORDER BY id_demo ASC
                    """,
                    (id_vehiculo,),
                )
            return cur.fetchall()


@router.get("/demos/{id_demo}/movimientos")
def obtener_movimientos_demo(
    id_demo: int,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id_demo, id_vehiculo, es_fabrica, id_usuario, activo FROM demos WHERE id_demo = %s",
                (id_demo,),
            )
            demo = cur.fetchone()
            if not demo or not bool(demo.get("activo", 1)):
                raise HTTPException(status_code=404, detail="Demo no encontrada")

            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=int(demo["id_vehiculo"]),
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
            if not bool(demo.get("es_fabrica")) and ctx["actor_tipo"] == "propietario":
                if int(demo.get("id_usuario") or 0) != int(ctx["id_usuario"] or 0):
                    raise HTTPException(status_code=403, detail="No puedes consultar demos privadas de otro comprador")
            if ctx["es_invitado"] and not bool(demo.get("es_fabrica")):
                raise HTTPException(status_code=403, detail="El invitado solo puede ver demos de fábrica")

            cur.execute(
                """
                SELECT dm.id_movimiento_demo, dm.id_demo, dm.id_comando, dm.orden, dm.duracion_ms,
                       c.nombre AS comando, c.codigo
                FROM demo_movimientos dm
                INNER JOIN comandos c ON c.id_comando = dm.id_comando
                WHERE dm.id_demo = %s
                ORDER BY dm.orden ASC
                """,
                (id_demo,),
            )
            return cur.fetchall()


@router.post("/demos/ejecutar")
async def ejecutar_demo_vehiculo(
    payload: DemoEjecutarRequest,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            ctx = verificar_acceso_vehiculo(
                cur,
                id_vehiculo=payload.id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=True,
            )

            cur.execute(
                "SELECT id_demo, id_vehiculo, nombre, es_fabrica, id_usuario, activo FROM demos WHERE id_demo = %s",
                (payload.id_demo,),
            )
            demo = cur.fetchone()
            if not demo or not bool(demo.get("activo", 1)) or int(demo["id_vehiculo"]) != payload.id_vehiculo:
                raise HTTPException(status_code=404, detail="Secuencia demo no encontrada para esta unidad")

            if not bool(demo.get("es_fabrica")):
                if ctx["es_invitado"]:
                    raise HTTPException(status_code=403, detail="El invitado solo puede ejecutar demos de fábrica")
                if ctx["actor_tipo"] == "propietario" and int(demo.get("id_usuario") or 0) != int(ctx["id_usuario"] or 0):
                    raise HTTPException(status_code=403, detail="No puedes ejecutar demos privadas de otro comprador")

            if gestor_demos.obtener(payload.id_vehiculo):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ya hay una secuencia demo ejecutándose en esta unidad")

            cur.execute(
                """
                SELECT dm.id_comando, dm.orden, dm.duracion_ms, c.nombre AS comando, c.codigo
                FROM demo_movimientos dm
                INNER JOIN comandos c ON c.id_comando = dm.id_comando
                WHERE dm.id_demo = %s
                ORDER BY dm.orden ASC
                """,
                (payload.id_demo,),
            )
            pasos = cur.fetchall()
            if not pasos:
                raise HTTPException(status_code=422, detail="La secuencia demo no tiene pasos configurados")

            for paso in pasos:
                validar_comando_para_actor(
                    cur,
                    vehiculo=ctx["vehiculo"],
                    id_comando=int(paso["id_comando"]),
                    es_invitado=ctx["es_invitado"],
                )

    cancel_event = gestor_demos.registrar(payload.id_vehiculo, payload.id_demo, demo["nombre"])
    task = asyncio.create_task(
        _ejecutar_demo_async(payload.id_vehiculo, payload.id_demo, demo["nombre"], pasos, cancel_event)
    )
    gestor_demos.asociar_task(payload.id_vehiculo, task)

    return {
        "mensaje": f"Secuencia demo '{demo['nombre']}' iniciada",
        "id_vehiculo": payload.id_vehiculo,
        "id_demo": payload.id_demo,
        "total_pasos": len(pasos),
    }


@router.post("/demos/{id_vehiculo}/cancelar")
async def cancelar_demo_vehiculo(
    id_vehiculo: int,
    x_guest_token: Optional[str] = Header(default=None, alias="X-Guest-Token"),
    usuario: Optional[dict] = Depends(obtener_usuario_opcional),
):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            verificar_acceso_vehiculo(
                cur,
                id_vehiculo=id_vehiculo,
                usuario=usuario,
                guest_token=x_guest_token,
                requiere_control=True,
            )

    estaba_activa = gestor_demos.solicitar_cancelacion(id_vehiculo)
    return {
        "mensaje": "Solicitud de cancelación enviada" if estaba_activa else "No había demo activa ejecutándose",
        "id_vehiculo": id_vehiculo,
        "cancelada": estaba_activa,
    }

