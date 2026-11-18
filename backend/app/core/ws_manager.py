"""Gestor centralizado de WebSockets por vehículo, tasa de comandos y demos activas."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, Iterable, Optional

from app.core.security import CODIGO_DETENER, registrar_auditoria, serializar_utc_iso


def _json_default(valor: Any) -> Any:
    if isinstance(valor, datetime):
        return serializar_utc_iso(valor)
    return str(valor)


class ControladorTasa:
    """Limitador simple en ventana deslizante para evitar inundación de comandos IoT."""

    def __init__(self, max_peticiones: int = 120, ventana_segundos: int = 60) -> None:
        self.max_peticiones = max(1, int(max_peticiones))
        self.ventana_segundos = max(1, int(ventana_segundos))
        self._eventos: Dict[str, Deque[float]] = defaultdict(deque)

    def verificar_y_registrar(self, clave: str, id_comando: Optional[int] = None, codigo: Optional[int] = None) -> bool:
        """Permite siempre DETENER (9) y limita otros comandos dentro de la ventana."""
        if codigo == CODIGO_DETENER or (id_comando == CODIGO_DETENER and codigo is None):
            return True
        ahora = time.monotonic()
        limite_inferior = ahora - self.ventana_segundos
        cola = self._eventos[clave]
        while cola and cola[0] < limite_inferior:
            cola.popleft()
        if len(cola) >= self.max_peticiones:
            return False
        cola.append(ahora)
        return True


class GestorWebSockets:
    """Administra conexiones WSS autenticadas por id_vehiculo con revocación activa."""

    def __init__(self) -> None:
        self._conexiones: Dict[int, Dict[str, Dict[str, Any]]] = defaultdict(dict)

    async def conectar(
        self,
        id_vehiculo: int,
        websocket: Any,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        await websocket.accept()
        conn_id = uuid.uuid4().hex
        registro = dict(metadata or {})
        registro["ws"] = websocket
        registro["conn_id"] = conn_id
        self._conexiones[int(id_vehiculo)][conn_id] = registro
        return conn_id

    def desconectar(self, id_vehiculo: int, conn_id: str) -> Optional[Dict[str, Any]]:
        grupo = self._conexiones.get(int(id_vehiculo))
        if not grupo:
            return None
        meta = grupo.pop(conn_id, None)
        if not grupo:
            self._conexiones.pop(int(id_vehiculo), None)
        return meta

    def contar_conexiones(self, id_vehiculo: int) -> int:
        return len(self._conexiones.get(int(id_vehiculo), {}))

    async def emitir_a_vehiculo(self, id_vehiculo: int, payload: Dict[str, Any]) -> int:
        grupo = self._conexiones.get(int(id_vehiculo))
        if not grupo:
            return 0
        mensaje = json.dumps(payload, default=_json_default, ensure_ascii=False)
        enviados = 0
        muertos = []
        for conn_id, meta in list(grupo.items()):
            ws = meta.get("ws")
            if ws is None:
                muertos.append(conn_id)
                continue
            try:
                await ws.send_text(mensaje)
                enviados += 1
            except Exception:
                muertos.append(conn_id)
        for conn_id in muertos:
            self.desconectar(id_vehiculo, conn_id)
        return enviados

    async def revocar_conexiones(
        self,
        id_vehiculo: int,
        *,
        actor_tipos: Optional[Iterable[str]] = None,
        id_usuario: Optional[int] = None,
        id_sesion_invitado: Optional[int] = None,
        motivo: str = "Acceso revocado o sesión finalizada",
        code: int = 4003,
    ) -> int:
        grupo = self._conexiones.get(int(id_vehiculo))
        if not grupo:
            return 0
        tipos_set = set(actor_tipos) if actor_tipos else None
        cerradas = 0
        for conn_id, meta in list(grupo.items()):
            coincide = True
            if tipos_set is not None and meta.get("actor_tipo") not in tipos_set:
                coincide = False
            if id_usuario is not None and meta.get("id_usuario") != id_usuario:
                coincide = False
            if id_sesion_invitado is not None and meta.get("id_sesion_invitado") != id_sesion_invitado:
                coincide = False
            if not coincide:
                continue
            ws = meta.get("ws")
            self.desconectar(id_vehiculo, conn_id)
            cerradas += 1
            if ws is not None:
                try:
                    await ws.send_text(
                        json.dumps(
                            {
                                "tipo": "sesion_revocada",
                                "id_vehiculo": int(id_vehiculo),
                                "motivo": motivo,
                                "timestamp": _json_default(datetime.now(timezone.utc)),
                            },
                            ensure_ascii=False,
                        )
                    )
                except Exception:
                    pass
                try:
                    await ws.close(code=code, reason=motivo[:120])
                except Exception:
                    pass
        return cerradas


class GestorDemosActivas:
    """Coordina ejecuciones asíncronas de secuencias demo y su cancelación prioritaria."""

    def __init__(self) -> None:
        self._activas: Dict[int, Dict[str, Any]] = {}

    def registrar(self, id_vehiculo: int, id_demo: int, nombre_demo: str) -> asyncio.Event:
        evento = asyncio.Event()
        self._activas[int(id_vehiculo)] = {
            "id_demo": int(id_demo),
            "nombre": nombre_demo,
            "cancel_event": evento,
            "task": None,
        }
        return evento

    def asociar_task(self, id_vehiculo: int, task: asyncio.Task) -> None:
        info = self._activas.get(int(id_vehiculo))
        if info:
            info["task"] = task

    def obtener(self, id_vehiculo: int) -> Optional[Dict[str, Any]]:
        return self._activas.get(int(id_vehiculo))

    def solicitar_cancelacion(self, id_vehiculo: int) -> bool:
        info = self._activas.get(int(id_vehiculo))
        if not info:
            return False
        info["cancel_event"].set()
        return True

    def limpiar(self, id_vehiculo: int, id_demo: Optional[int] = None) -> None:
        info = self._activas.get(int(id_vehiculo))
        if info and (id_demo is None or info["id_demo"] == int(id_demo)):
            self._activas.pop(int(id_vehiculo), None)


async def emitir_detener_seguridad(
    conn: Any,
    id_vehiculo: int,
    *,
    origen: str = "SEGURIDAD_SESION",
    id_usuario: Optional[int] = None,
    motivo: str = "Parada automática de seguridad",
) -> Optional[Dict[str, Any]]:
    """Persiste estado y movimiento DETENER (9) y transmite broadcast por WSS."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id_comando, nombre, codigo
            FROM comandos
            WHERE id_vehiculo = %s AND codigo = %s
            LIMIT 1
            """,
            (id_vehiculo, CODIGO_DETENER),
        )
        cmd = cur.fetchone()
        if not cmd:
            return None

        id_cmd = int(cmd["id_comando"])
        cur.execute(
            """
            INSERT INTO historial_comandos (id_vehiculo, id_comando, origen, fecha_hora)
            VALUES (%s, %s, %s, NOW())
            """,
            (id_vehiculo, id_cmd, origen[:40]),
        )
        id_hist = cur.lastrowid

        cur.execute("SELECT id_estado FROM estado_vehiculo WHERE id_vehiculo = %s LIMIT 1", (id_vehiculo,))
        est = cur.fetchone()
        if est:
            cur.execute(
                """
                UPDATE estado_vehiculo
                SET id_comando = %s, conectado = 1, fecha_actualizacion = NOW()
                WHERE id_vehiculo = %s
                """,
                (id_cmd, id_vehiculo),
            )
        else:
            cur.execute(
                """
                INSERT INTO estado_vehiculo (id_vehiculo, id_comando, conectado, fecha_actualizacion)
                VALUES (%s, %s, 1, NOW())
                """,
                (id_vehiculo, id_cmd),
            )

        registrar_auditoria(
            cur,
            id_usuario=id_usuario,
            accion="PARADA_SEGURIDAD_DETENER",
            entidad_afectada="VEHICULO",
            id_entidad=id_vehiculo,
            detalles={"origen": origen, "motivo": motivo, "codigo_comando": CODIGO_DETENER},
            ip_origen="127.0.0.1",
        )
        conn.commit()

    gestor_demos.solicitar_cancelacion(id_vehiculo)

    payload = {
        "tipo": "movimiento_individual",
        "id_vehiculo": int(id_vehiculo),
        "id_comando": id_cmd,
        "codigo_comando": int(cmd["codigo"]),
        "nombre_comando": cmd["nombre"],
        "origen": origen,
        "motivo": motivo,
        "id_historial": id_hist,
        "fecha_hora": serializar_utc_iso(datetime.now(timezone.utc)),
    }
    await ws_manager.emitir_a_vehiculo(id_vehiculo, payload)
    return payload


ws_manager = GestorWebSockets()
gestor_demos = GestorDemosActivas()
controlador_tasa = ControladorTasa()
