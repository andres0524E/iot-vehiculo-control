"""Aplicación principal FastAPI: CORS estricto, salud RDS, WSS autenticado y watcher de expiraciones."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from app.core.config import settings
from app.core.db import obtener_conexion, verificar_salud_db
from app.core.security import (
    cargar_usuario_desde_token,
    extraer_bearer_token,
    serializar_utc_iso,
    verificar_acceso_vehiculo,
)
from app.core.ws_manager import emitir_detener_seguridad, ws_manager
from app.routers import admin, auth, invitado, usuario, vehiculos_control

logger = logging.getLogger("iot.main")


async def _vigilar_expiraciones_loop() -> None:
    """Expira sesiones de invitado y autorizaciones de soporte vencidas deteniendo el vehículo."""
    while True:
        try:
            await asyncio.sleep(5)
            sesiones_expiradas = []
            soportes_expirados = []

            with obtener_conexion() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT id_sesion, id_vehiculo
                        FROM sesiones_invitado
                        WHERE activa = 1 AND fecha_expiracion <= UTC_TIMESTAMP()
                        """
                    )
                    sesiones_expiradas = cur.fetchall()
                    if sesiones_expiradas:
                        cur.execute(
                            """
                            UPDATE sesiones_invitado
                            SET activa = 0
                            WHERE activa = 1 AND fecha_expiracion <= UTC_TIMESTAMP()
                            """
                        )

                    cur.execute(
                        """
                        SELECT id_soporte, id_vehiculo
                        FROM soporte_autorizaciones
                        WHERE activo = 1 AND fecha_expiracion <= UTC_TIMESTAMP()
                        """
                    )
                    soportes_expirados = cur.fetchall()
                    if soportes_expirados:
                        cur.execute(
                            """
                            UPDATE soporte_autorizaciones
                            SET activo = 0
                            WHERE activo = 1 AND fecha_expiracion <= UTC_TIMESTAMP()
                            """
                        )

                    if sesiones_expiradas or soportes_expirados:
                        conn.commit()

                for ses in sesiones_expiradas:
                    id_v = int(ses["id_vehiculo"])
                    id_s = int(ses["id_sesion"])
                    await emitir_detener_seguridad(
                        conn,
                        id_v,
                        origen="TTL_EXPIRADO_INVITADO",
                        motivo="Tiempo de prueba de invitado agotado",
                    )
                    await ws_manager.revocar_conexiones(
                        id_v,
                        id_sesion_invitado=id_s,
                        motivo="Tiempo de prueba de invitado concluido",
                        code=4008,
                    )

                for sop in soportes_expirados:
                    await ws_manager.revocar_conexiones(
                        int(sop["id_vehiculo"]),
                        actor_tipos={"admin_soporte"},
                        motivo="Ventana de soporte técnico expirada",
                        code=4003,
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("Watcher TTL en espera (%s)", exc)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    watcher = asyncio.create_task(_vigilar_expiraciones_loop())
    try:
        yield
    finally:
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watcher


app = FastAPI(
    title=settings.app_title,
    version=settings.app_version,
    description=(
        "Backend modular FastAPI para Control IoT (4.1), Monitoreo WSS (4.2) y "
        "Administración de Flota, Capacidades, Soporte y RBAC (4.3)."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Guest-Token"],
)

# Routers de Negocio y Seguridad (3ra Aplicación)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(usuario.router)
app.include_router(invitado.router)

# Routers de Control y Monitoreo 4.1 / 4.2 (Protegidos por RBAC/BOLA)
app.include_router(vehiculos_control.router)


@app.get("/", tags=["Salud y Diagnóstico"])
@app.get("/health", tags=["Salud y Diagnóstico"])
def verificar_salud():
    """Comprueba estado del servidor API y conectividad real hacia Amazon RDS."""
    rds_ok, rds_detalle = verificar_salud_db()
    return {
        "estado": "operativo" if rds_ok else "degradado",
        "servicio": settings.app_title,
        "version": settings.app_version,
        "base_datos": rds_detalle,
        "rds_disponible": rds_ok,
        "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
    }


@app.get("/monitor", response_class=HTMLResponse, tags=["Salud y Diagnóstico"])
def vista_diagnostico_ws():
    return """
    <!doctype html>
    <html lang="es">
      <head><meta charset="utf-8"><title>Diagnóstico WSS IoT</title></head>
      <body style="font-family: monospace; background:#141720; color:#e6edf5; padding:24px;">
        <h2>Diagnóstico WebSocket Seguro (/ws/vehiculos/{id_vehiculo})</h2>
        <p>Las suscripciones WSS exigen <code>?token=&lt;JWT&gt;</code> o <code>?guest_token=&lt;SESSION_TOKEN&gt;</code> válidos.</p>
      </body>
    </html>
    """


@app.websocket("/ws/vehiculos/{id_vehiculo}")
async def websocket_vehiculo(
    websocket: WebSocket,
    id_vehiculo: int,
    token: Optional[str] = Query(default=None),
    guest_token: Optional[str] = Query(default=None),
):
    """Canal WSS autenticado con aislamiento por vehículo/propietario/invitado y parada al desconectar."""
    auth_header = websocket.headers.get("authorization")
    jwt_token = token or extraer_bearer_token(auth_header)
    g_token = guest_token or websocket.headers.get("x-guest-token")

    conn_id: Optional[str] = None
    ctx: Optional[dict] = None
    estado_inicial = None

    try:
        with obtener_conexion() as conn:
            with conn.cursor() as cur:
                user = cargar_usuario_desde_token(cur, jwt_token) if jwt_token else None
                ctx = verificar_acceso_vehiculo(
                    cur,
                    id_vehiculo=id_vehiculo,
                    usuario=user,
                    guest_token=g_token,
                    requiere_control=False,
                    requiere_privacidad_vendido=True,
                )
                estado_inicial = vehiculos_control._extraer_estado_vehiculo(cur, id_vehiculo)
    except Exception as exc:
        code = 4401 if getattr(exc, "status_code", 403) == 401 else 4403
        reason = getattr(exc, "detail", "Acceso WSS denegado")
        await websocket.close(code=code, reason=str(reason)[:120])
        return

    meta = {
        "actor_tipo": ctx["actor_tipo"],
        "id_usuario": ctx["id_usuario"],
        "id_sesion_invitado": ctx["id_sesion_invitado"],
        "expira_en": ctx["expira_en"],
    }
    conn_id = await ws_manager.conectar(id_vehiculo, websocket, meta)

    try:
        if estado_inicial:
            await websocket.send_json(
                {
                    "evento": "estado_inicial",
                    "id_vehiculo": id_vehiculo,
                    "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                    "estado": estado_inicial,
                }
            )

        while True:
            msg = await websocket.receive_text()
            if msg.strip().lower() == "ping":
                await websocket.send_json(
                    {
                        "evento": "pong",
                        "id_vehiculo": id_vehiculo,
                        "timestamp": serializar_utc_iso(datetime.now(timezone.utc)),
                    }
                )
    except WebSocketDisconnect:
        pass
    finally:
        desconectado = ws_manager.desconectar(id_vehiculo, conn_id) if conn_id else None
        if desconectado and desconectado.get("actor_tipo") == "invitado":
            try:
                with obtener_conexion() as conn_stop:
                    await emitir_detener_seguridad(
                        conn_stop,
                        id_vehiculo,
                        origen="WS_DESCONEXION_INVITADO",
                        motivo="Cliente invitado desconectó el canal WebSocket",
                    )
            except Exception as exc:
                logger.debug("No se pudo emitir DETENER tras desconexión de invitado: %s", exc)
