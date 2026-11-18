from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from app.database import DatabaseConfig, DatabaseConnection
from app.repositories import StoredProcedureRepository
from app.websocket_manager import WebSocketManager
from app.services import VehiculoIoTService
from app.schemas import (
    VehiculoCrearSchema,
    VehiculoActualizarSchema,
    ComandoCrearSchema,
    ComandoActualizarSchema,
    EstadoActualizarSchema,
    HistorialRegistrarSchema,
    MovimientoIndividualSchema,
    DemoCrearSchema,
    DemoActualizarSchema,
    MovimientoDemoCrearSchema,
    MovimientoDemoActualizarSchema,
    DemoEjecutarSchema
)
from app.routers import auth, admin, usuario, invitado

config = DatabaseConfig()
db_connection = DatabaseConnection(config)
repository = StoredProcedureRepository(db_connection)
ws_manager = WebSocketManager()
service = VehiculoIoTService(repository, ws_manager)

app = FastAPI(
    title="api vehiculo iot - control, monitoreo y administracion (ec2 & rds)",
    description="api publica con poo, 21 stored procedures en amazon rds, monitoreo wss y modulo 4.3 administracion rbac",
    version="3.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== modulos 4.3 administracion, login jwt, comprador e invitado ====================
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(usuario.router)
app.include_router(invitado.router)


def verificar_autorizacion(x_api_key: str = Header(default=None)):
    if not x_api_key or x_api_key != config.api_key:
        raise HTTPException(status_code=401, detail="no autorizado: header x-api-key invalido o ausente")
    return True


@app.get("/", tags=["salud"], summary="verificar estado del servidor en ec2")
def estado_servidor():
    return {
        "estado": "operativo",
        "servicio": "api vehiculo iot - control, monitoreo y administracion 4.3",
        "rds_conectada": True,
        "documentacion": "/docs",
        "monitor_wss": "/monitor"
    }


@app.get("/monitor", response_class=HTMLResponse, tags=["monitoreo wss"], summary="panel web dual para pruebas de websocket seguro (wss)")
def obtener_monitor_wss():
    ruta_html = Path(__file__).parent / "test_ws.html"
    return HTMLResponse(content=ruta_html.read_text(encoding="utf-8"))


# ==================== vehiculos (5 sp) ====================
@app.get("/vehiculos", tags=["vehiculos"], summary="obtener todos los vehiculos (sp_obtener_vehiculos)")
def listar_vehiculos():
    return service.obtener_vehiculos()


@app.get("/vehiculos/{id_vehiculo}", tags=["vehiculos"], summary="obtener vehiculo por id (sp_obtener_vehiculo)")
def obtener_vehiculo(id_vehiculo: int):
    return service.obtener_vehiculo(id_vehiculo)


@app.post("/vehiculos", status_code=201, tags=["vehiculos"], summary="crear vehiculo (sp_crear_vehiculo)")
def crear_vehiculo(datos: VehiculoCrearSchema):
    return service.crear_vehiculo(datos)


@app.post("/vehiculos/{id_vehiculo}/actualizar", tags=["vehiculos"], summary="actualizar vehiculo (sp_actualizar_vehiculo)")
def actualizar_vehiculo(id_vehiculo: int, datos: VehiculoActualizarSchema):
    return service.actualizar_vehiculo(id_vehiculo, datos)


@app.post("/vehiculos/{id_vehiculo}/eliminar", tags=["vehiculos"], summary="eliminar vehiculo (sp_eliminar_vehiculo)")
def eliminar_vehiculo(id_vehiculo: int, autorizado: bool = Depends(verificar_autorizacion)):
    return service.eliminar_vehiculo(id_vehiculo)


# ==================== comandos (4 sp) ====================
@app.get("/vehiculos/{id_vehiculo}/comandos", tags=["comandos"], summary="obtener comandos del vehiculo (sp_obtener_comandos_vehiculo)")
def listar_comandos_vehiculo(id_vehiculo: int):
    return service.obtener_comandos_vehiculo(id_vehiculo)


@app.post("/comandos", status_code=201, tags=["comandos"], summary="crear comando (sp_crear_comando)")
def crear_comando(datos: ComandoCrearSchema):
    return service.crear_comando(datos)


@app.post("/comandos/{id_comando}/actualizar", tags=["comandos"], summary="actualizar comando (sp_actualizar_comando)")
def actualizar_comando(id_comando: int, datos: ComandoActualizarSchema):
    return service.actualizar_comando(id_comando, datos)


@app.post("/comandos/{id_comando}/eliminar", tags=["comandos"], summary="eliminar comando (sp_eliminar_comando)")
def eliminar_comando(id_comando: int, autorizado: bool = Depends(verificar_autorizacion)):
    return service.eliminar_comando(id_comando)


# ==================== estado e historial (4 sp + movimiento individual) ====================
@app.get("/vehiculos/{id_vehiculo}/estado", tags=["estado"], summary="consultar ultimo estado del vehiculo (sp_obtener_estado)")
def obtener_estado(id_vehiculo: int):
    return service.obtener_estado(id_vehiculo)


@app.post("/estado", tags=["estado"], summary="actualizar estado directamente (sp_actualizar_estado)")
def actualizar_estado(datos: EstadoActualizarSchema):
    return service.actualizar_estado(datos)


@app.get("/vehiculos/{id_vehiculo}/historial", tags=["historial"], summary="consultar ultimos 10 movimientos del historial (sp_obtener_historial)")
def obtener_historial(id_vehiculo: int):
    return service.obtener_historial_ultimos_diez(id_vehiculo)


@app.post("/historial", status_code=201, tags=["historial"], summary="registrar en historial directamente (sp_registrar_historial)")
def registrar_historial(datos: HistorialRegistrarSchema):
    return service.registrar_historial(datos)


@app.post("/movimientos", status_code=201, tags=["estado", "historial"], summary="ejecutar movimiento individual atomico y notificar por websocket")
async def registrar_movimiento_individual(datos: MovimientoIndividualSchema):
    return await service.ejecutar_movimiento_individual(datos)


# ==================== demo y movimientos demo (8 sp + ejecucion ws) ====================
@app.get("/vehiculos/{id_vehiculo}/demos", tags=["demo"], summary="obtener demos del vehiculo (sp_obtener_demos)")
def listar_demos(id_vehiculo: int):
    return service.obtener_demos(id_vehiculo)


@app.post("/demos", status_code=201, tags=["demo"], summary="crear demo (sp_crear_demo)")
def crear_demo(datos: DemoCrearSchema):
    return service.crear_demo(datos)


@app.post("/demos/{id_demo}/actualizar", tags=["demo"], summary="actualizar demo (sp_actualizar_demo)")
def actualizar_demo(id_demo: int, datos: DemoActualizarSchema):
    return service.actualizar_demo(id_demo, datos)


@app.post("/demos/{id_demo}/eliminar", tags=["demo"], summary="eliminar demo (sp_eliminar_demo)")
def eliminar_demo(id_demo: int, autorizado: bool = Depends(verificar_autorizacion)):
    return service.eliminar_demo(id_demo)


@app.get("/demos/{id_demo}/movimientos", tags=["demo"], summary="obtener movimientos ordenados de una demo (sp_obtener_movimientos_demo)")
def listar_movimientos_demo(id_demo: int):
    return service.obtener_movimientos_demo(id_demo)


@app.post("/demos/movimientos", status_code=201, tags=["demo"], summary="agregar movimiento a una demo (sp_agregar_movimiento_demo)")
def agregar_movimiento_demo(datos: MovimientoDemoCrearSchema):
    return service.agregar_movimiento_demo(datos)


@app.post("/demos/movimientos/{id_movimiento_demo}/actualizar", tags=["demo"], summary="actualizar movimiento de demo (sp_actualizar_movimiento_demo)")
def actualizar_movimiento_demo(id_movimiento_demo: int, datos: MovimientoDemoActualizarSchema):
    return service.actualizar_movimiento_demo(id_movimiento_demo, datos)


@app.post("/demos/movimientos/{id_movimiento_demo}/eliminar", tags=["demo"], summary="eliminar movimiento de demo (sp_eliminar_movimiento_demo)")
def eliminar_movimiento_demo(id_movimiento_demo: int, autorizado: bool = Depends(verificar_autorizacion)):
    return service.eliminar_movimiento_demo(id_movimiento_demo)


@app.post("/demos/ejecutar", status_code=202, tags=["demo"], summary="iniciar demo por websocket sin registrar en historial")
async def ejecutar_demo_ws(datos: DemoEjecutarSchema):
    return await service.iniciar_demo(datos.id_vehiculo, datos.id_demo)


@app.post("/demos/{id_vehiculo}/cancelar", tags=["demo"], summary="cancelar demo activa inmediatamente")
async def cancelar_demo_ws(id_vehiculo: int):
    return await service.cancelar_demo(id_vehiculo)


# ==================== websocket por vehiculo ====================
@app.websocket("/ws/vehiculos/{id_vehiculo}")
async def websocket_vehiculo(websocket: WebSocket, id_vehiculo: int):
    await ws_manager.conectar(id_vehiculo, websocket)
    try:
        estado_inicial = service.obtener_estado(id_vehiculo)
        await ws_manager.enviar_personal(websocket, "estado_inicial", id_vehiculo, {"estado": estado_inicial})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.desconectar(id_vehiculo, websocket)
    except Exception:
        ws_manager.desconectar(id_vehiculo, websocket)
