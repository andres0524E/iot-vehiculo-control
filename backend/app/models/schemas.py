"""Esquemas Pydantic de entrada/salida para FastAPI (Control, Monitoreo y Administración)."""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Autenticación
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    email: str = Field(..., min_length=4, max_length=128)
    password: str = Field(..., min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _normalizar_email(cls, v: str) -> str:
        val = v.strip().lower()
        if "@" not in val or "." not in val.split("@")[-1]:
            raise ValueError("Formato de correo electrónico inválido")
        return val


class UsuarioActualResponse(BaseModel):
    id_usuario: int
    email: str
    nombre_completo: str
    rol: str
    rol_nombre: Optional[str] = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expira_en: datetime
    usuario: UsuarioActualResponse


# ---------------------------------------------------------------------------
# Modelos Comerciales y Capacidades de Comandos
# ---------------------------------------------------------------------------
class ModeloCrearRequest(BaseModel):
    nombre_comercial: str = Field(..., min_length=3, max_length=100)
    descripcion: Optional[str] = Field(default=None, max_length=500)
    tipo_microcontrolador: str = Field(default="ESP8266", min_length=2, max_length=64)
    imagen_url: Optional[str] = Field(default=None, max_length=255)


class ModeloActualizarRequest(BaseModel):
    nombre_comercial: str = Field(..., min_length=3, max_length=100)
    descripcion: Optional[str] = Field(default=None, max_length=500)
    tipo_microcontrolador: str = Field(default="ESP8266", min_length=2, max_length=64)
    imagen_url: Optional[str] = Field(default=None, max_length=255)


class ModeloEstadoRequest(BaseModel):
    activo: bool


class ModeloComandoItem(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=64)
    codigo: int = Field(..., ge=1, le=99)
    descripcion: Optional[str] = Field(default=None, max_length=255)
    permitido_invitado: bool = False
    activo: bool = True


class ModeloComandosActualizarRequest(BaseModel):
    comandos: List[ModeloComandoItem] = Field(..., min_length=1, max_length=50)


# ---------------------------------------------------------------------------
# Unidades Físicas y Asignaciones
# ---------------------------------------------------------------------------
EstadoInventarioType = Literal["disponible", "vendido", "exhibicion", "mantenimiento", "inactivo"]


class UnidadCrearRequest(BaseModel):
    id_modelo: int = Field(..., gt=0)
    numero_serie: str = Field(..., min_length=3, max_length=64)
    nombre: str = Field(..., min_length=2, max_length=100)
    descripcion: Optional[str] = Field(default=None, max_length=255)
    estado_inventario: EstadoInventarioType = "disponible"


class UnidadActualizarRequest(BaseModel):
    id_modelo: Optional[int] = Field(default=None, gt=0)
    numero_serie: str = Field(..., min_length=3, max_length=64)
    nombre: str = Field(..., min_length=2, max_length=100)
    descripcion: Optional[str] = Field(default=None, max_length=255)
    estado_inventario: EstadoInventarioType = "disponible"


class UnidadEstadoRequest(BaseModel):
    estado_inventario: EstadoInventarioType


class AsignacionCrearRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    id_usuario: int = Field(..., gt=0)
    notas: Optional[str] = Field(default=None, max_length=255)


class AsignacionRevocarRequest(BaseModel):
    motivo: Optional[str] = Field(default="Revocación administrativa de propiedad", max_length=255)


# ---------------------------------------------------------------------------
# Clientes (Compradores)
# ---------------------------------------------------------------------------
class ClienteCrearRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=128)
    nombre_completo: str = Field(..., min_length=3, max_length=128)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def _normalizar_email(cls, v: str) -> str:
        val = v.strip().lower()
        if "@" not in val or "." not in val.split("@")[-1]:
            raise ValueError("Correo inválido")
        return val


class ClienteActualizarRequest(BaseModel):
    nombre_completo: str = Field(..., min_length=3, max_length=128)
    activo: bool = True


# ---------------------------------------------------------------------------
# Soporte Técnico Explícito (Privacidad Comprador -> Admin)
# ---------------------------------------------------------------------------
class AutorizacionSoporteRequest(BaseModel):
    duracion_minutos: int = Field(default=30, ge=5, le=120)
    motivo: str = Field(default="Diagnóstico remoto autorizado por comprador", min_length=4, max_length=255)


# ---------------------------------------------------------------------------
# Demos (Fábrica y Privadas)
# ---------------------------------------------------------------------------
class DemoPasoItem(BaseModel):
    orden: int = Field(..., ge=1, le=30)
    id_comando: int = Field(..., gt=0)
    duracion_ms: int = Field(..., ge=200, le=10000)


class DemoCrearRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    nombre: str = Field(..., min_length=3, max_length=60)
    descripcion: Optional[str] = Field(default="", max_length=255)
    pasos: List[DemoPasoItem] = Field(..., min_length=1, max_length=30)


class DemoActualizarRequest(BaseModel):
    nombre: str = Field(..., min_length=3, max_length=60)
    descripcion: Optional[str] = Field(default="", max_length=255)
    pasos: List[DemoPasoItem] = Field(..., min_length=1, max_length=30)


class DemoEjecutarRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    id_demo: int = Field(..., gt=0)


# ---------------------------------------------------------------------------
# Invitado (Sesión de exhibición exclusiva)
# ---------------------------------------------------------------------------
class SolicitudPruebaRequest(BaseModel):
    id_vehiculo: Optional[int] = Field(default=None, gt=0)
    id_modelo: Optional[int] = Field(default=None, gt=0)
    alias_cliente: str = Field(default="Visitante Demo", min_length=2, max_length=64)


# ---------------------------------------------------------------------------
# Control / Monitoreo 4.1 y 4.2 (Compatibilidad + RBAC)
# ---------------------------------------------------------------------------
class MovimientoCrearRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    id_comando: int = Field(..., gt=0)
    origen: str = Field(default="WEB", min_length=1, max_length=40)


class VehiculoLegacyCrearRequest(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=100)
    modelo: str = Field(default="Excavadora IoT", min_length=2, max_length=100)
    descripcion: Optional[str] = Field(default="", max_length=255)
    microcontrolador: str = Field(default="ESP8266", min_length=2, max_length=64)


class ComandoLegacyCrearRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    nombre: str = Field(..., min_length=2, max_length=64)
    codigo: int = Field(..., ge=1, le=99)
    descripcion: Optional[str] = Field(default="", max_length=255)


class EstadoLegacyCrearRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    id_comando: int = Field(..., gt=0)
    conectado: int = Field(default=1, ge=0, le=1)


class HistorialLegacyCrearRequest(BaseModel):
    id_vehiculo: int = Field(..., gt=0)
    id_comando: int = Field(..., gt=0)
    origen: str = Field(default="WEB", min_length=1, max_length=40)
