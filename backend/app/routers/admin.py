"""Router Administrativo (Rol 'admin'): KPIs, modelos, capacidades, unidades, asignaciones, clientes y auditoría."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.core.db import obtener_conexion
from app.core.security import (
    hash_password,
    obtener_ip_cliente,
    registrar_auditoria,
    requerir_roles,
    serializar_utc_iso,
)
from app.core.ws_manager import emitir_detener_seguridad, ws_manager
from app.models.schemas import (
    AsignacionCrearRequest,
    AsignacionRevocarRequest,
    ClienteActualizarRequest,
    ClienteCrearRequest,
    DemoCrearRequest,
    EstadoInventarioType,
    ModeloActualizarRequest,
    ModeloComandosActualizarRequest,
    ModeloCrearRequest,
    ModeloEstadoRequest,
    UnidadActualizarRequest,
    UnidadCrearRequest,
    UnidadEstadoRequest,
)

router = APIRouter(
    prefix="/admin",
    tags=["Administración de Flota (Admin)"],
    dependencies=[Depends(requerir_roles(["admin"]))],
)


def _serializar_fechas_fila(fila: dict) -> dict:
    resultado = dict(fila)
    for clave, valor in list(resultado.items()):
        if hasattr(valor, "isoformat"):
            resultado[clave] = serializar_utc_iso(valor)
    return resultado


def _sincronizar_comandos_unidad_desde_modelo(cursor, id_vehiculo: int, id_modelo: int) -> int:
    """Clona capacidades definidas en modelo_comandos (o vehículo 1 si aún no hay definidas) hacia comandos."""
    cursor.execute("SELECT COUNT(*) AS c FROM comandos WHERE id_vehiculo = %s", (id_vehiculo,))
    if (cursor.fetchone() or {}).get("c", 0) > 0:
        return 0

    cursor.execute(
        """
        SELECT nombre, codigo, descripcion, activo
        FROM modelo_comandos
        WHERE id_modelo = %s
        ORDER BY codigo ASC
        """,
        (id_modelo,),
    )
    plantilla = cursor.fetchall()
    if not plantilla:
        cursor.execute(
            """
            SELECT nombre, codigo, descripcion, activo
            FROM comandos
            WHERE id_vehiculo = 1
            ORDER BY codigo ASC
            """
        )
        plantilla = cursor.fetchall()

    insertados = 0
    for cmd in plantilla:
        cursor.execute(
            """
            INSERT INTO comandos (id_vehiculo, nombre, codigo, descripcion, activo)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                id_vehiculo,
                cmd["nombre"],
                cmd["codigo"],
                cmd.get("descripcion") or cmd["nombre"],
                int(cmd.get("activo", 1)),
            ),
        )
        insertados += 1
    return insertados


@router.get("/dashboard")
def obtener_dashboard():
    """Indicadores ejecutivos consolidados de flota, clientes, demos y sesiones activas."""
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS total FROM modelos_vehiculo WHERE activo = 1")
            total_modelos = int(cur.fetchone()["total"])

            cur.execute(
                """
                SELECT
                    COUNT(*) AS total_unidades,
                    SUM(CASE WHEN estado_inventario = 'disponible' THEN 1 ELSE 0 END) AS disponibles,
                    SUM(CASE WHEN estado_inventario = 'vendido' THEN 1 ELSE 0 END) AS vendidas,
                    SUM(CASE WHEN estado_inventario = 'exhibicion' THEN 1 ELSE 0 END) AS exhibicion,
                    SUM(CASE WHEN estado_inventario = 'mantenimiento' THEN 1 ELSE 0 END) AS mantenimiento,
                    SUM(CASE WHEN estado_inventario = 'inactivo' THEN 1 ELSE 0 END) AS inactivas
                FROM vehiculos
                """
            )
            inv = cur.fetchone() or {}

            cur.execute(
                """
                SELECT COUNT(*) AS total
                FROM usuarios u
                INNER JOIN roles r ON r.id_rol = u.id_rol
                WHERE r.clave = 'usuario' AND u.activo = 1
                """
            )
            total_clientes = int(cur.fetchone()["total"])

            cur.execute(
                """
                SELECT COUNT(*) AS total
                FROM sesiones_invitado
                WHERE activa = 1 AND fecha_expiracion > UTC_TIMESTAMP()
                """
            )
            sesiones_invitado = int(cur.fetchone()["total"])

            cur.execute(
                """
                SELECT
                    SUM(CASE WHEN es_fabrica = 1 THEN 1 ELSE 0 END) AS fabrica,
                    SUM(CASE WHEN es_fabrica = 0 THEN 1 ELSE 0 END) AS privadas
                FROM demos
                WHERE activo = 1
                """
            )
            demos_info = cur.fetchone() or {}

            cur.execute(
                """
                SELECT COUNT(*) AS total
                FROM soporte_autorizaciones
                WHERE activo = 1 AND fecha_expiracion > UTC_TIMESTAMP()
                """
            )
            soporte_activo = int(cur.fetchone()["total"])

    return {
        "total_modelos": total_modelos,
        "total_unidades": int(inv.get("total_unidades") or 0),
        "unidades_disponibles": int(inv.get("disponibles") or 0),
        "unidades_vendidas": int(inv.get("vendidas") or 0),
        "unidades_exhibicion": int(inv.get("exhibicion") or 0),
        "unidades_mantenimiento": int(inv.get("mantenimiento") or 0),
        "unidades_inactivas": int(inv.get("inactivas") or 0),
        "total_clientes": total_clientes,
        "sesiones_invitado_activas": sesiones_invitado,
        "demos_fabrica": int(demos_info.get("fabrica") or 0),
        "demos_privadas": int(demos_info.get("privadas") or 0),
        "soporte_activo": soporte_activo,
    }


# ---------------------------------------------------------------------------
# Modelos Comerciales y Capacidades
# ---------------------------------------------------------------------------
@router.get("/modelos")
def listar_modelos(
    q: Optional[str] = Query(default=None, max_length=100),
    activo: Optional[int] = Query(default=None, ge=0, le=1),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    filtros = ["1=1"]
    params: list = []
    if q:
        filtros.append("(m.nombre_comercial LIKE %s OR COALESCE(m.descripcion, '') LIKE %s)")
        like = f"%{q.strip()}%"
        params.extend([like, like])
    if activo is not None:
        filtros.append("m.activo = %s")
        params.append(activo)

    where_sql = " AND ".join(filtros)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS total FROM modelos_vehiculo m WHERE {where_sql}", params)
            total = int(cur.fetchone()["total"])

            cur.execute(
                f"""
                SELECT m.id_modelo, m.nombre_comercial, m.descripcion, m.tipo_microcontrolador,
                       m.imagen_url, m.activo, m.fecha_creacion,
                       (SELECT COUNT(*) FROM vehiculos v WHERE v.id_modelo = m.id_modelo) AS total_unidades,
                       (SELECT COUNT(*) FROM modelo_comandos mc WHERE mc.id_modelo = m.id_modelo AND mc.activo = 1) AS total_capacidades
                FROM modelos_vehiculo m
                WHERE {where_sql}
                ORDER BY m.id_modelo ASC
                LIMIT %s OFFSET %s
                """,
                [*params, limit, offset],
            )
            items = [_serializar_fechas_fila(f) for f in cur.fetchall()]

    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.post("/modelos", status_code=status.HTTP_201_CREATED)
def crear_modelo(payload: ModeloCrearRequest, request: Request, usuario: dict = Depends(requerir_roles(["admin"]))):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id_modelo FROM modelos_vehiculo WHERE nombre_comercial = %s LIMIT 1",
                (payload.nombre_comercial.strip(),),
            )
            if cur.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya existe un modelo comercial con ese nombre",
                )

            cur.execute(
                """
                INSERT INTO modelos_vehiculo (nombre_comercial, descripcion, tipo_microcontrolador, imagen_url, activo)
                VALUES (%s, %s, %s, %s, 1)
                """,
                (
                    payload.nombre_comercial.strip(),
                    payload.descripcion,
                    payload.tipo_microcontrolador.strip(),
                    payload.imagen_url or "./assets/img/rover.svg",
                ),
            )
            id_modelo = int(cur.lastrowid)

            # Sembrar capacidades básicas seguras en orden secuencial 1..12
            capacidades_base = [
                ("avanzar", 1, "Tracción adelante", 1),
                ("retroceder", 2, "Tracción reversa", 1),
                ("girar_palanca_izquierda", 3, "Giro palanca izquierda", 1),
                ("girar_palanca_derecha", 4, "Giro palanca derecha", 1),
                ("bajar_brazo", 5, "Descenso de brazo", 0),
                ("subir_brazo", 6, "Elevación de brazo", 0),
                ("girar_derecha", 7, "Giro derecha", 1),
                ("girar_izquierda", 8, "Giro izquierda", 1),
                ("detener", 9, "Parada prioritaria de seguridad", 1),
                ("sonido", 10, "Bocina de advertencia", 1),
                ("led", 11, "Iluminación LED", 1),
                ("demo_software", 12, "Secuencia interna MCU", 0),
            ]
            for nom, cod, desc, inv in capacidades_base:
                cur.execute(
                    """
                    INSERT INTO modelo_comandos (id_modelo, nombre, codigo, descripcion, permitido_invitado, activo)
                    VALUES (%s, %s, %s, %s, %s, 1)
                    """,
                    (id_modelo, nom, cod, desc, inv),
                )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="CREAR_MODELO",
                entidad_afectada="MODELO",
                id_entidad=id_modelo,
                detalles={"nombre_comercial": payload.nombre_comercial, "mcu": payload.tipo_microcontrolador},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Modelo creado correctamente", "id_modelo": id_modelo}


@router.put("/modelos/{id_modelo}")
def actualizar_modelo(
    id_modelo: int,
    payload: ModeloActualizarRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_modelo FROM modelos_vehiculo WHERE id_modelo = %s", (id_modelo,))
            if not cur.fetchone():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")

            cur.execute(
                "SELECT id_modelo FROM modelos_vehiculo WHERE nombre_comercial = %s AND id_modelo != %s",
                (payload.nombre_comercial.strip(), id_modelo),
            )
            if cur.fetchone():
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Otro modelo ya usa ese nombre")

            cur.execute(
                """
                UPDATE modelos_vehiculo
                SET nombre_comercial = %s,
                    descripcion = %s,
                    tipo_microcontrolador = %s,
                    imagen_url = COALESCE(%s, imagen_url)
                WHERE id_modelo = %s
                """,
                (
                    payload.nombre_comercial.strip(),
                    payload.descripcion,
                    payload.tipo_microcontrolador.strip(),
                    payload.imagen_url,
                    id_modelo,
                ),
            )
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ACTUALIZAR_MODELO",
                entidad_afectada="MODELO",
                id_entidad=id_modelo,
                detalles={"nombre_comercial": payload.nombre_comercial},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Modelo actualizado", "id_modelo": id_modelo}


@router.patch("/modelos/{id_modelo}/estado")
def cambiar_estado_modelo(
    id_modelo: int,
    payload: ModeloEstadoRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_modelo FROM modelos_vehiculo WHERE id_modelo = %s", (id_modelo,))
            if not cur.fetchone():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")

            cur.execute("UPDATE modelos_vehiculo SET activo = %s WHERE id_modelo = %s", (1 if payload.activo else 0, id_modelo))
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="CAMBIAR_ESTADO_MODELO",
                entidad_afectada="MODELO",
                id_entidad=id_modelo,
                detalles={"activo": payload.activo},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Estado del modelo actualizado", "id_modelo": id_modelo, "activo": payload.activo}


@router.get("/modelos/{id_modelo}/comandos")
def listar_comandos_modelo(id_modelo: int):
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_modelo, nombre_comercial FROM modelos_vehiculo WHERE id_modelo = %s", (id_modelo,))
            modelo = cur.fetchone()
            if not modelo:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")
            cur.execute(
                """
                SELECT id_modelo_comando, id_modelo, nombre, codigo, descripcion, permitido_invitado, activo
                FROM modelo_comandos
                WHERE id_modelo = %s
                ORDER BY codigo ASC
                """,
                (id_modelo,),
            )
            items = cur.fetchall()
    return {"modelo": modelo, "items": items}


@router.put("/modelos/{id_modelo}/comandos")
def actualizar_comandos_modelo(
    id_modelo: int,
    payload: ModeloComandosActualizarRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    codigos_vistos = set()
    for item in payload.comandos:
        if item.codigo in codigos_vistos:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Código de comando duplicado en la petición: {item.codigo}",
            )
        codigos_vistos.add(item.codigo)

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_modelo FROM modelos_vehiculo WHERE id_modelo = %s", (id_modelo,))
            if not cur.fetchone():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")

            cur.execute("DELETE FROM modelo_comandos WHERE id_modelo = %s", (id_modelo,))
            for item in payload.comandos:
                cur.execute(
                    """
                    INSERT INTO modelo_comandos (id_modelo, nombre, codigo, descripcion, permitido_invitado, activo)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        id_modelo,
                        item.nombre.strip(),
                        item.codigo,
                        item.descripcion or item.nombre.strip(),
                        1 if item.permitido_invitado else 0,
                        1 if item.activo else 0,
                    ),
                )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ACTUALIZAR_CAPACIDADES_MODELO",
                entidad_afectada="MODELO",
                id_entidad=id_modelo,
                detalles={"total_comandos": len(payload.comandos)},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Capacidades del modelo actualizadas", "id_modelo": id_modelo}


# ---------------------------------------------------------------------------
# Unidades Físicas (vehiculos)
# ---------------------------------------------------------------------------
@router.get("/unidades")
def listar_unidades(
    q: Optional[str] = Query(default=None, max_length=100),
    estado_inventario: Optional[EstadoInventarioType] = Query(default=None),
    id_modelo: Optional[int] = Query(default=None, gt=0),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    filtros = ["1=1"]
    params: list = []
    if q:
        filtros.append("(v.nombre LIKE %s OR COALESCE(v.numero_serie, '') LIKE %s OR COALESCE(m.nombre_comercial, '') LIKE %s)")
        like = f"%{q.strip()}%"
        params.extend([like, like, like])
    if estado_inventario:
        filtros.append("v.estado_inventario = %s")
        params.append(estado_inventario)
    if id_modelo is not None:
        filtros.append("v.id_modelo = %s")
        params.append(id_modelo)

    where_sql = " AND ".join(filtros)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT COUNT(*) AS total
                FROM vehiculos v
                LEFT JOIN modelos_vehiculo m ON m.id_modelo = v.id_modelo
                WHERE {where_sql}
                """,
                params,
            )
            total = int(cur.fetchone()["total"])

            cur.execute(
                f"""
                SELECT v.id_vehiculo, v.id_modelo, v.numero_serie, v.nombre, v.modelo,
                       v.descripcion, v.microcontrolador, v.activo, v.estado_inventario, v.fecha_alta,
                       m.nombre_comercial, m.imagen_url,
                       a.id_usuario AS id_propietario,
                       u.nombre_completo AS nombre_propietario,
                       u.email AS email_propietario,
                       (
                         SELECT s.fecha_expiracion
                         FROM soporte_autorizaciones s
                         WHERE s.id_vehiculo = v.id_vehiculo
                           AND s.activo = 1
                           AND s.fecha_expiracion > UTC_TIMESTAMP()
                         ORDER BY s.id_soporte DESC
                         LIMIT 1
                       ) AS soporte_expira_en
                FROM vehiculos v
                LEFT JOIN modelos_vehiculo m ON m.id_modelo = v.id_modelo
                LEFT JOIN asignaciones_vehiculo a ON a.id_vehiculo = v.id_vehiculo AND a.estado = 'activo'
                LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
                WHERE {where_sql}
                ORDER BY v.id_vehiculo ASC
                LIMIT %s OFFSET %s
                """,
                [*params, limit, offset],
            )
            items = []
            for fila in cur.fetchall():
                item = _serializar_fechas_fila(fila)
                item["soporte_activo"] = bool(item.get("soporte_expira_en"))
                items.append(item)

    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.post("/unidades", status_code=status.HTTP_201_CREATED)
def crear_unidad(payload: UnidadCrearRequest, request: Request, usuario: dict = Depends(requerir_roles(["admin"]))):
    ip_origen = obtener_ip_cliente(request)
    if payload.estado_inventario == "vendido":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Una unidad nueva no puede crearse directamente en estado 'vendido' sin asignación a cliente",
        )

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id_modelo, nombre_comercial, tipo_microcontrolador, activo FROM modelos_vehiculo WHERE id_modelo = %s",
                (payload.id_modelo,),
            )
            modelo = cur.fetchone()
            if not modelo or not bool(modelo.get("activo", 1)):
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="El modelo comercial seleccionado no existe o está inactivo",
                )

            cur.execute(
                "SELECT id_vehiculo FROM vehiculos WHERE numero_serie = %s LIMIT 1",
                (payload.numero_serie.strip(),),
            )
            if cur.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya existe una unidad física con ese número de serie",
                )

            activo_flag = 0 if payload.estado_inventario == "inactivo" else 1
            cur.execute(
                """
                INSERT INTO vehiculos
                    (id_modelo, numero_serie, nombre, modelo, descripcion, microcontrolador, activo, estado_inventario)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    payload.id_modelo,
                    payload.numero_serie.strip(),
                    payload.nombre.strip(),
                    modelo["nombre_comercial"],
                    payload.descripcion or f"Unidad {payload.numero_serie.strip()}",
                    modelo["tipo_microcontrolador"],
                    activo_flag,
                    payload.estado_inventario,
                ),
            )
            id_vehiculo = int(cur.lastrowid)

            cmds_insertados = _sincronizar_comandos_unidad_desde_modelo(cur, id_vehiculo, payload.id_modelo)

            cur.execute(
                "SELECT id_comando FROM comandos WHERE id_vehiculo = %s AND codigo = 9 LIMIT 1",
                (id_vehiculo,),
            )
            cmd_stop = cur.fetchone()
            if cmd_stop:
                cur.execute(
                    """
                    INSERT INTO estado_vehiculo (id_vehiculo, id_comando, conectado, fecha_actualizacion)
                    VALUES (%s, %s, 0, NOW())
                    """,
                    (id_vehiculo, int(cmd_stop["id_comando"])),
                )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ALTA_UNIDAD",
                entidad_afectada="VEHICULO",
                id_entidad=id_vehiculo,
                detalles={
                    "numero_serie": payload.numero_serie.strip(),
                    "id_modelo": payload.id_modelo,
                    "estado": payload.estado_inventario,
                    "comandos_iniciales": cmds_insertados,
                },
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Unidad registrada correctamente", "id_vehiculo": id_vehiculo}


@router.put("/unidades/{id_vehiculo}")
def actualizar_unidad(
    id_vehiculo: int,
    payload: UnidadActualizarRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_vehiculo, id_modelo FROM vehiculos WHERE id_vehiculo = %s", (id_vehiculo,))
            veh = cur.fetchone()
            if not veh:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unidad no encontrada")

            cur.execute(
                "SELECT id_vehiculo FROM vehiculos WHERE numero_serie = %s AND id_vehiculo != %s",
                (payload.numero_serie.strip(), id_vehiculo),
            )
            if cur.fetchone():
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Número de serie duplicado")

            cur.execute(
                "SELECT id_asignacion FROM asignaciones_vehiculo WHERE id_vehiculo = %s AND estado = 'activo' LIMIT 1",
                (id_vehiculo,),
            )
            tiene_dueno = cur.fetchone() is not None
            if tiene_dueno and payload.estado_inventario in {"disponible", "exhibicion"}:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="La unidad tiene una asignación activa; revócala antes de pasarla a disponible o exhibición",
                )

            id_modelo_final = payload.id_modelo or veh.get("id_modelo")
            nombre_modelo = None
            mcu = None
            if id_modelo_final:
                cur.execute(
                    "SELECT nombre_comercial, tipo_microcontrolador FROM modelos_vehiculo WHERE id_modelo = %s",
                    (id_modelo_final,),
                )
                mod = cur.fetchone()
                if not mod:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo indicado no existe")
                nombre_modelo = mod["nombre_comercial"]
                mcu = mod["tipo_microcontrolador"]

            activo_flag = 0 if payload.estado_inventario == "inactivo" else 1
            cur.execute(
                """
                UPDATE vehiculos
                SET id_modelo = COALESCE(%s, id_modelo),
                    numero_serie = %s,
                    nombre = %s,
                    modelo = COALESCE(%s, modelo),
                    descripcion = %s,
                    microcontrolador = COALESCE(%s, microcontrolador),
                    estado_inventario = %s,
                    activo = %s
                WHERE id_vehiculo = %s
                """,
                (
                    id_modelo_final,
                    payload.numero_serie.strip(),
                    payload.nombre.strip(),
                    nombre_modelo,
                    payload.descripcion,
                    mcu,
                    payload.estado_inventario,
                    activo_flag,
                    id_vehiculo,
                ),
            )
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ACTUALIZAR_UNIDAD",
                entidad_afectada="VEHICULO",
                id_entidad=id_vehiculo,
                detalles={"estado_inventario": payload.estado_inventario, "numero_serie": payload.numero_serie},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Unidad actualizada correctamente", "id_vehiculo": id_vehiculo}


@router.patch("/unidades/{id_vehiculo}/estado")
async def cambiar_estado_unidad(
    id_vehiculo: int,
    payload: UnidadEstadoRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_vehiculo, estado_inventario FROM vehiculos WHERE id_vehiculo = %s", (id_vehiculo,))
            veh = cur.fetchone()
            if not veh:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unidad no encontrada")

            cur.execute(
                "SELECT id_asignacion FROM asignaciones_vehiculo WHERE id_vehiculo = %s AND estado = 'activo' LIMIT 1",
                (id_vehiculo,),
            )
            if cur.fetchone() and payload.estado_inventario in {"disponible", "exhibicion"}:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Revoca la asignación del comprador antes de pasar la unidad a disponible o exhibición",
                )

            activo_flag = 0 if payload.estado_inventario == "inactivo" else 1
            cur.execute(
                "UPDATE vehiculos SET estado_inventario = %s, activo = %s WHERE id_vehiculo = %s",
                (payload.estado_inventario, activo_flag, id_vehiculo),
            )

            if payload.estado_inventario in {"inactivo", "mantenimiento"}:
                cur.execute(
                    "UPDATE sesiones_invitado SET activa = 0 WHERE id_vehiculo = %s AND activa = 1",
                    (id_vehiculo,),
                )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="CAMBIAR_ESTADO_UNIDAD",
                entidad_afectada="VEHICULO",
                id_entidad=id_vehiculo,
                detalles={"anterior": veh.get("estado_inventario"), "nuevo": payload.estado_inventario},
                ip_origen=ip_origen,
            )
            conn.commit()

        if payload.estado_inventario in {"inactivo", "mantenimiento"}:
            await emitir_detener_seguridad(
                conn,
                id_vehiculo,
                origen="ADMIN_ESTADO_UNIDAD",
                id_usuario=usuario["id_usuario"],
                motivo=f"Unidad movida a estado {payload.estado_inventario}",
            )
            await ws_manager.revocar_conexiones(
                id_vehiculo,
                motivo=f"La unidad pasó a estado {payload.estado_inventario}",
                code=4003,
            )

    return {"mensaje": "Estado de inventario actualizado", "estado_inventario": payload.estado_inventario}


# ---------------------------------------------------------------------------
# Clientes y Asignaciones
# ---------------------------------------------------------------------------
@router.get("/clientes")
def listar_clientes(
    q: Optional[str] = Query(default=None, max_length=100),
    activo: Optional[int] = Query(default=None, ge=0, le=1),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    filtros = ["r.clave = 'usuario'"]
    params: list = []
    if q:
        filtros.append("(u.nombre_completo LIKE %s OR u.email LIKE %s)")
        like = f"%{q.strip()}%"
        params.extend([like, like])
    if activo is not None:
        filtros.append("u.activo = %s")
        params.append(activo)

    where_sql = " AND ".join(filtros)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT COUNT(*) AS total
                FROM usuarios u
                INNER JOIN roles r ON r.id_rol = u.id_rol
                WHERE {where_sql}
                """,
                params,
            )
            total = int(cur.fetchone()["total"])

            cur.execute(
                f"""
                SELECT u.id_usuario, u.email, u.nombre_completo, u.activo, u.fecha_creacion,
                       (
                         SELECT COUNT(*)
                         FROM asignaciones_vehiculo a
                         WHERE a.id_usuario = u.id_usuario AND a.estado = 'activo'
                       ) AS unidades_asignadas
                FROM usuarios u
                INNER JOIN roles r ON r.id_rol = u.id_rol
                WHERE {where_sql}
                ORDER BY u.id_usuario ASC
                LIMIT %s OFFSET %s
                """,
                [*params, limit, offset],
            )
            items = [_serializar_fechas_fila(f) for f in cur.fetchall()]

    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.post("/clientes", status_code=status.HTTP_201_CREATED)
def crear_cliente(payload: ClienteCrearRequest, request: Request, usuario: dict = Depends(requerir_roles(["admin"]))):
    ip_origen = obtener_ip_cliente(request)
    pwd_hash = hash_password(payload.password)

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_usuario FROM usuarios WHERE email = %s LIMIT 1", (payload.email,))
            if cur.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Ya existe una cuenta registrada con ese correo electrónico",
                )

            cur.execute("SELECT id_rol FROM roles WHERE clave = 'usuario' LIMIT 1")
            rol_fila = cur.fetchone()
            if not rol_fila:
                raise HTTPException(status_code=500, detail="Rol 'usuario' no configurado en RDS")

            cur.execute(
                """
                INSERT INTO usuarios (id_rol, email, password_hash, nombre_completo, activo)
                VALUES (%s, %s, %s, %s, 1)
                """,
                (int(rol_fila["id_rol"]), payload.email, pwd_hash, payload.nombre_completo.strip()),
            )
            id_cliente = int(cur.lastrowid)

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ALTA_CLIENTE",
                entidad_afectada="USUARIO",
                id_entidad=id_cliente,
                detalles={"email": payload.email, "nombre": payload.nombre_completo.strip()},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Cliente comprador registrado", "id_usuario": id_cliente, "email": payload.email}


@router.put("/clientes/{id_cliente}")
async def actualizar_cliente(
    id_cliente: int,
    payload: ClienteActualizarRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    unidades_afectadas = []
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id_usuario
                FROM usuarios u
                INNER JOIN roles r ON r.id_rol = u.id_rol
                WHERE u.id_usuario = %s AND r.clave = 'usuario'
                LIMIT 1
                """,
                (id_cliente,),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado")

            cur.execute(
                "UPDATE usuarios SET nombre_completo = %s, activo = %s WHERE id_usuario = %s",
                (payload.nombre_completo.strip(), 1 if payload.activo else 0, id_cliente),
            )
            if not payload.activo:
                cur.execute(
                    "SELECT id_vehiculo FROM asignaciones_vehiculo WHERE id_usuario = %s AND estado = 'activo'",
                    (id_cliente,),
                )
                unidades_afectadas = [int(r["id_vehiculo"]) for r in cur.fetchall()]

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ACTUALIZAR_CLIENTE",
                entidad_afectada="USUARIO",
                id_entidad=id_cliente,
                detalles={"activo": payload.activo, "nombre": payload.nombre_completo},
                ip_origen=ip_origen,
            )
            conn.commit()

    for id_v in unidades_afectadas:
        await ws_manager.revocar_conexiones(
            id_v,
            id_usuario=id_cliente,
            motivo="Cuenta de cliente desactivada",
            code=4003,
        )

    return {"mensaje": "Cliente actualizado correctamente", "id_usuario": id_cliente}


@router.post("/asignaciones", status_code=status.HTTP_201_CREATED)
async def asignar_unidad_a_cliente(
    payload: AsignacionCrearRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    anterior_propietario_id: Optional[int] = None

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id_vehiculo, estado_inventario, activo FROM vehiculos WHERE id_vehiculo = %s LIMIT 1",
                (payload.id_vehiculo,),
            )
            veh = cur.fetchone()
            if not veh:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unidad no encontrada")
            if veh.get("estado_inventario") == "inactivo" or not bool(veh.get("activo", 1)):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="No se puede asignar una unidad dada de baja lógica",
                )

            cur.execute(
                """
                SELECT u.id_usuario, u.activo, r.clave AS rol
                FROM usuarios u
                INNER JOIN roles r ON r.id_rol = u.id_rol
                WHERE u.id_usuario = %s
                LIMIT 1
                """,
                (payload.id_usuario,),
            )
            comprador = cur.fetchone()
            if not comprador or comprador["rol"] != "usuario" or not bool(comprador["activo"]):
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="El cliente comprador no existe, no es rol comprador o está desactivado",
                )

            cur.execute(
                """
                SELECT id_asignacion, id_usuario
                FROM asignaciones_vehiculo
                WHERE id_vehiculo = %s AND estado = 'activo'
                LIMIT 1
                """,
                (payload.id_vehiculo,),
            )
            previa = cur.fetchone()
            if previa:
                anterior_propietario_id = int(previa["id_usuario"])
                cur.execute(
                    """
                    UPDATE asignaciones_vehiculo
                    SET estado = 'transferido', fecha_baja = UTC_TIMESTAMP()
                    WHERE id_asignacion = %s
                    """,
                    (previa["id_asignacion"],),
                )

            # Cerrar soporte previo y sesiones de exhibición activas si existían
            cur.execute(
                "UPDATE soporte_autorizaciones SET activo = 0 WHERE id_vehiculo = %s AND activo = 1",
                (payload.id_vehiculo,),
            )
            cur.execute(
                "UPDATE sesiones_invitado SET activa = 0 WHERE id_vehiculo = %s AND activa = 1",
                (payload.id_vehiculo,),
            )

            cur.execute(
                """
                INSERT INTO asignaciones_vehiculo (id_vehiculo, id_usuario, estado, fecha_asignacion, notas)
                VALUES (%s, %s, 'activo', UTC_TIMESTAMP(), %s)
                """,
                (payload.id_vehiculo, payload.id_usuario, payload.notas),
            )
            id_asignacion = int(cur.lastrowid)

            cur.execute(
                "UPDATE vehiculos SET estado_inventario = 'vendido', activo = 1 WHERE id_vehiculo = %s",
                (payload.id_vehiculo,),
            )

            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="ASIGNAR_UNIDAD",
                entidad_afectada="ASIGNACION",
                id_entidad=id_asignacion,
                detalles={
                    "id_vehiculo": payload.id_vehiculo,
                    "id_usuario": payload.id_usuario,
                    "transferido_desde": anterior_propietario_id,
                },
                ip_origen=ip_origen,
            )
            conn.commit()

    await ws_manager.revocar_conexiones(
        payload.id_vehiculo,
        actor_tipos={"invitado", "admin_soporte"},
        motivo="Unidad asignada a propietario privado",
        code=4003,
    )
    if anterior_propietario_id and anterior_propietario_id != payload.id_usuario:
        await ws_manager.revocar_conexiones(
            payload.id_vehiculo,
            id_usuario=anterior_propietario_id,
            motivo="Propiedad de unidad transferida",
            code=4003,
        )

    return {
        "mensaje": "Unidad asignada exclusivamente al comprador",
        "id_asignacion": id_asignacion,
        "id_vehiculo": payload.id_vehiculo,
        "id_usuario": payload.id_usuario,
    }


@router.post("/asignaciones/{id_vehiculo}/revocar")
async def revocar_asignacion(
    id_vehiculo: int,
    payload: AsignacionRevocarRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    id_dueno_previo: Optional[int] = None

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id_asignacion, id_usuario
                FROM asignaciones_vehiculo
                WHERE id_vehiculo = %s AND estado = 'activo'
                LIMIT 1
                """,
                (id_vehiculo,),
            )
            asig = cur.fetchone()
            if not asig:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="La unidad no tiene una asignación activa que revocar",
                )
            id_dueno_previo = int(asig["id_usuario"])

            cur.execute(
                """
                UPDATE asignaciones_vehiculo
                SET estado = 'revocado', fecha_baja = UTC_TIMESTAMP(),
                    notas = COALESCE(%s, notas)
                WHERE id_asignacion = %s
                """,
                (payload.motivo, asig["id_asignacion"]),
            )
            cur.execute(
                "UPDATE soporte_autorizaciones SET activo = 0 WHERE id_vehiculo = %s AND activo = 1",
                (id_vehiculo,),
            )
            cur.execute(
                "UPDATE vehiculos SET estado_inventario = 'disponible' WHERE id_vehiculo = %s",
                (id_vehiculo,),
            )
            registrar_auditoria(
                cur,
                id_usuario=usuario["id_usuario"],
                accion="REVOCAR_ASIGNACION",
                entidad_afectada="ASIGNACION",
                id_entidad=int(asig["id_asignacion"]),
                detalles={"id_vehiculo": id_vehiculo, "id_usuario_previo": id_dueno_previo, "motivo": payload.motivo},
                ip_origen=ip_origen,
            )
            conn.commit()

    await ws_manager.revocar_conexiones(
        id_vehiculo,
        id_usuario=id_dueno_previo,
        motivo="Asignación de propiedad revocada",
        code=4003,
    )
    return {"mensaje": "Asignación revocada; la unidad vuelve a inventario disponible", "id_vehiculo": id_vehiculo}


# ---------------------------------------------------------------------------
# Demos de Fábrica
# ---------------------------------------------------------------------------
@router.get("/demos-fabrica")
def listar_demos_fabrica(id_vehiculo: Optional[int] = Query(default=None, gt=0)):
    filtro = "WHERE d.es_fabrica = 1 AND d.activo = 1"
    params: list = []
    if id_vehiculo is not None:
        filtro += " AND d.id_vehiculo = %s"
        params.append(id_vehiculo)

    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT d.id_demo, d.id_vehiculo, d.nombre, d.descripcion, d.es_fabrica,
                       v.nombre AS nombre_vehiculo
                FROM demos d
                INNER JOIN vehiculos v ON v.id_vehiculo = d.id_vehiculo
                {filtro}
                ORDER BY d.id_demo ASC
                """,
                params,
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
    return {"total": len(demos), "items": demos}


@router.post("/demos-fabrica", status_code=status.HTTP_201_CREATED)
def crear_demo_fabrica(
    payload: DemoCrearRequest,
    request: Request,
    usuario: dict = Depends(requerir_roles(["admin"])),
):
    ip_origen = obtener_ip_cliente(request)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id_vehiculo FROM vehiculos WHERE id_vehiculo = %s", (payload.id_vehiculo,))
            if not cur.fetchone():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehículo no encontrado")

            for paso in payload.pasos:
                cur.execute(
                    "SELECT id_comando FROM comandos WHERE id_comando = %s AND id_vehiculo = %s AND activo = 1",
                    (paso.id_comando, payload.id_vehiculo),
                )
                if not cur.fetchone():
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=f"El comando {paso.id_comando} no pertenece o no está activo en la unidad {payload.id_vehiculo}",
                    )

            cur.execute(
                """
                INSERT INTO demos (id_vehiculo, nombre, descripcion, es_fabrica, id_usuario, activo)
                VALUES (%s, %s, %s, 1, NULL, 1)
                """,
                (payload.id_vehiculo, payload.nombre.strip(), payload.descripcion or ""),
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
                accion="CREAR_DEMO_FABRICA",
                entidad_afectada="DEMO",
                id_entidad=id_demo,
                detalles={"id_vehiculo": payload.id_vehiculo, "nombre": payload.nombre, "pasos": len(payload.pasos)},
                ip_origen=ip_origen,
            )
            conn.commit()
    return {"mensaje": "Demo oficial de fábrica creada", "id_demo": id_demo}


# ---------------------------------------------------------------------------
# Auditoría de Operaciones
# ---------------------------------------------------------------------------
@router.get("/auditoria")
def consultar_auditoria(
    accion: Optional[str] = Query(default=None, max_length=64),
    entidad: Optional[str] = Query(default=None, max_length=64),
    id_usuario: Optional[int] = Query(default=None, gt=0),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    filtros = ["1=1"]
    params: list = []
    if accion:
        filtros.append("a.accion LIKE %s")
        params.append(f"%{accion.strip()}%")
    if entidad:
        filtros.append("a.entidad_afectada = %s")
        params.append(entidad.strip())
    if id_usuario is not None:
        filtros.append("a.id_usuario = %s")
        params.append(id_usuario)

    where_sql = " AND ".join(filtros)
    with obtener_conexion() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS total FROM auditoria_operaciones a WHERE {where_sql}", params)
            total = int(cur.fetchone()["total"])

            cur.execute(
                f"""
                SELECT a.id_auditoria, a.id_usuario, u.email AS email_usuario, r.clave AS rol_usuario,
                       a.accion, a.entidad_afectada, a.id_entidad, a.detalles_json, a.ip_origen, a.fecha_hora
                FROM auditoria_operaciones a
                LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
                LEFT JOIN roles r ON r.id_rol = u.id_rol
                WHERE {where_sql}
                ORDER BY a.id_auditoria DESC
                LIMIT %s OFFSET %s
                """,
                [*params, limit, offset],
            )
            items = [_serializar_fechas_fila(f) for f in cur.fetchall()]

    return {"total": total, "limit": limit, "offset": offset, "items": items}
