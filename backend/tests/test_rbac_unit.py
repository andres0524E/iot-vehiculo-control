"""Pruebas unitarias reales (stdlib unittest) de criptografía, JWT, RBAC, BOLA/IDOR, soporte y WSS."""

from __future__ import annotations

import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.security import (  # noqa: E402
    HTTPException,
    cargar_usuario_desde_token,
    crear_token_acceso,
    decodificar_token_acceso,
    hash_password,
    validar_comando_para_actor,
    verificar_acceso_vehiculo,
    verificar_password,
)
from app.core.ws_manager import ControladorTasa, GestorWebSockets  # noqa: E402


# Hashes exactos sembrados en db/001_migracion_administracion_up.sql
SEED_HASHES = {
    "admin@iot.empresa.com": (
        "Admin123!*",
        "pbkdf2_sha256$310000$048d3f18d6e34a6f06b0545f59c59901$b78214522b53e59b1aedb12bcc56e2e8f4c17abd7700a5a5f778e53c4603af2d",
    ),
    "comprador@cliente.com": (
        "Comprador123!*",
        "pbkdf2_sha256$310000$a9c7b48d0d8c92d83fe773bbb7d91bc6$bf7c038ab9132910513c3dde4dcb2841423e8e49df5390aab1ae6bc5db916014",
    ),
    "invitado@demo.com": (
        "Invitado123!*",
        "pbkdf2_sha256$310000$0dd3b3f330938765c5635e6d5afa152f$bba9123f74f5481122e257161645d30fb06214890ef88b4a0a894f99d4740a4b",
    ),
    "s.rivas@constructora.mx": (
        "CompradorB123!*",
        "pbkdf2_sha256$310000$168f7e94f18b657fab3fddcb03347afd$f5ddd898c18a6925fa4725be807046b9cf8ce476089fde0e9e53fcc1ebc51466",
    ),
}


class FakeSecurityCursor:
    """Cursor en memoria que emula las consultas SQL reales de security.py."""

    def __init__(self) -> None:
        self._result = None
        ahora = datetime.now(timezone.utc).replace(tzinfo=None)
        self.roles = {
            1: {"id_rol": 1, "clave": "admin", "nombre": "Administrador"},
            2: {"id_rol": 2, "clave": "usuario", "nombre": "Comprador"},
            3: {"id_rol": 3, "clave": "invitado", "nombre": "Invitado"},
        }
        self.usuarios = {
            1: {"id_usuario": 1, "id_rol": 1, "email": "admin@iot.empresa.com", "nombre_completo": "Admin", "activo": 1},
            2: {"id_usuario": 2, "id_rol": 2, "email": "comprador@cliente.com", "nombre_completo": "Comprador A", "activo": 1},
            3: {"id_usuario": 3, "id_rol": 3, "email": "invitado@demo.com", "nombre_completo": "Invitado", "activo": 1},
            4: {"id_usuario": 4, "id_rol": 2, "email": "s.rivas@constructora.mx", "nombre_completo": "Comprador B", "activo": 1},
        }
        self.vehiculos = {
            1: {"id_vehiculo": 1, "id_modelo": 1, "numero_serie": "SN-EXH-01", "nombre": "Excavadora Exhibición", "modelo": "Pro", "microcontrolador": "ESP8266", "activo": 1, "estado_inventario": "exhibicion"},
            2: {"id_vehiculo": 2, "id_modelo": 1, "numero_serie": "SN-CA-02", "nombre": "Excavadora Comprador A", "modelo": "Pro", "microcontrolador": "ESP8266", "activo": 1, "estado_inventario": "vendido"},
            3: {"id_vehiculo": 3, "id_modelo": 2, "numero_serie": "SN-CB-03", "nombre": "Rover Comprador B", "modelo": "Rover X1", "microcontrolador": "ESP32", "activo": 1, "estado_inventario": "vendido"},
            4: {"id_vehiculo": 4, "id_modelo": 1, "numero_serie": "SN-BAJA-04", "nombre": "Unidad Inactiva", "modelo": "Pro", "microcontrolador": "ESP8266", "activo": 0, "estado_inventario": "inactivo"},
        }
        self.asignaciones = [
            {"id_asignacion": 10, "id_vehiculo": 2, "id_usuario": 2, "estado": "activo"},
            {"id_asignacion": 11, "id_vehiculo": 3, "id_usuario": 4, "estado": "activo"},
        ]
        self.soporte = []
        self.sesiones_invitado = [
            {
                "id_sesion": 50,
                "id_vehiculo": 1,
                "token_sesion": "guest-valid-token-50",
                "alias_cliente": "Visitante Test",
                "fecha_inicio": ahora - timedelta(seconds=30),
                "fecha_expiracion": ahora + timedelta(minutes=2),
                "activa": 1,
            },
            {
                "id_sesion": 51,
                "id_vehiculo": 1,
                "token_sesion": "guest-expired-token-51",
                "alias_cliente": "Visitante Expirado",
                "fecha_inicio": ahora - timedelta(minutes=5),
                "fecha_expiracion": ahora - timedelta(minutes=1),
                "activa": 1,
            },
        ]
        self.tokens_revocados = set()
        self.comandos = {
            (1, 1): {"id_comando": 1, "id_vehiculo": 1, "nombre": "avanzar", "codigo": 1, "descripcion": "", "activo": 1},
            (5, 1): {"id_comando": 5, "id_vehiculo": 1, "nombre": "bajar_brazo", "codigo": 5, "descripcion": "", "activo": 1},
            (9, 1): {"id_comando": 9, "id_vehiculo": 1, "nombre": "detener", "codigo": 9, "descripcion": "", "activo": 1},
            (11, 1): {"id_comando": 11, "id_vehiculo": 1, "nombre": "led", "codigo": 11, "descripcion": "", "activo": 1},
            (1, 2): {"id_comando": 1, "id_vehiculo": 2, "nombre": "avanzar", "codigo": 1, "descripcion": "", "activo": 1},
        }
        self.modelo_comandos = {
            (1, 1): {"permitido_invitado": 1, "activo": 1},
            (1, 5): {"permitido_invitado": 0, "activo": 1},
            (1, 9): {"permitido_invitado": 1, "activo": 1},
            (1, 11): {"permitido_invitado": 1, "activo": 1},
        }

    def execute(self, sql: str, params: tuple = ()) -> None:
        q = " ".join(sql.split()).lower()
        ahora = datetime.now(timezone.utc).replace(tzinfo=None)

        if "from tokens_revocados" in q:
            jti = params[0]
            self._result = {"revocado": 1} if jti in self.tokens_revocados else None
            return

        if "from usuarios u" in q and "where u.id_usuario = %s" in q:
            u = self.usuarios.get(int(params[0]))
            if not u:
                self._result = None
                return
            r = self.roles[u["id_rol"]]
            self._result = {**u, "rol": r["clave"], "rol_nombre": r["nombre"]}
            return

        if "from vehiculos v" in q and "where v.id_vehiculo = %s" in q:
            self._result = self.vehiculos.get(int(params[0]))
            return

        if "from asignaciones_vehiculo a" in q:
            id_v = int(params[0])
            asig = next((a for a in self.asignaciones if a["id_vehiculo"] == id_v and a["estado"] == "activo"), None)
            if not asig:
                self._result = None
                return
            u = self.usuarios[asig["id_usuario"]]
            self._result = {**asig, "email": u["email"], "nombre_completo": u["nombre_completo"]}
            return

        if "from soporte_autorizaciones" in q:
            id_v = int(params[0])
            sop = next(
                (s for s in self.soporte if s["id_vehiculo"] == id_v and s["activo"] == 1 and s["fecha_expiracion"] > ahora),
                None,
            )
            self._result = sop
            return

        if "from sesiones_invitado" in q:
            token = params[0]
            id_v = int(params[1]) if len(params) > 1 else None
            ses = next(
                (
                    s
                    for s in self.sesiones_invitado
                    if s["token_sesion"] == token
                    and s["activa"] == 1
                    and s["fecha_expiracion"] > ahora
                    and (id_v is None or s["id_vehiculo"] == id_v)
                ),
                None,
            )
            self._result = ses
            return

        if "from comandos" in q and "where id_comando = %s and id_vehiculo = %s" in q:
            self._result = self.comandos.get((int(params[0]), int(params[1])))
            return

        if "from modelo_comandos" in q:
            self._result = self.modelo_comandos.get((int(params[0]), int(params[1])))
            return

        self._result = None

    def fetchone(self):
        return self._result


class FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.sent = []
        self.closed = None

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, texto: str) -> None:
        self.sent.append(texto)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


class SecurityAndRbacTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cur = FakeSecurityCursor()

    def test_seed_pbkdf2_hashes_verify_strictly_without_bypass(self) -> None:
        for email, (password_ok, stored_hash) in SEED_HASHES.items():
            self.assertTrue(verificar_password(password_ok, stored_hash), f"Falló hash válido para {email}")
            self.assertFalse(verificar_password("Admin123!*", SEED_HASHES["comprador@cliente.com"][1]))
            self.assertFalse(verificar_password("clave-incorrecta", stored_hash))
            self.assertFalse(verificar_password("", stored_hash))

        nuevo_hash = hash_password("MiClaveSegura#2026", iteraciones=10000)
        self.assertTrue(verificar_password("MiClaveSegura#2026", nuevo_hash))
        self.assertFalse(verificar_password("OtraClave", nuevo_hash))

    def test_jwt_lifecycle_tamper_expiry_and_revocation(self) -> None:
        emitido = crear_token_acceso(id_usuario=2, email="comprador@cliente.com", rol="usuario", nombre_completo="Comprador A")
        token = emitido["access_token"]
        payload = decodificar_token_acceso(token)
        self.assertEqual(payload["sub"], "2")
        self.assertEqual(payload["rol"], "usuario")

        user_loaded = cargar_usuario_desde_token(self.cur, token)
        self.assertEqual(user_loaded["id_usuario"], 2)

        # Token manipulado debe rechazarse
        with self.assertRaises(ValueError):
            decodificar_token_acceso(token[:-4] + "XXXX")

        # Token expirado debe rechazarse
        expirado = crear_token_acceso(
            id_usuario=2,
            email="comprador@cliente.com",
            rol="usuario",
            expires_delta=timedelta(seconds=-10),
        )
        with self.assertRaises(ValueError):
            decodificar_token_acceso(expirado["access_token"])

        # Logout / revocación debe invalidar inmediatamente (401)
        self.cur.tokens_revocados.add(emitido["jti"])
        with self.assertRaises(HTTPException) as ctx:
            cargar_usuario_desde_token(self.cur, token)
        self.assertEqual(ctx.exception.status_code, 401)

    def test_bola_idor_buyer_isolation(self) -> None:
        comprador_a = {"id_usuario": 2, "rol": "usuario"}
        comprador_b = {"id_usuario": 4, "rol": "usuario"}

        # Comprador A accede a su propia unidad #2
        ctx_ok = verificar_acceso_vehiculo(self.cur, id_vehiculo=2, usuario=comprador_a, requiere_control=True)
        self.assertEqual(ctx_ok["actor_tipo"], "propietario")

        # Comprador A intenta controlar unidad #3 de Comprador B -> 403 BOLA
        with self.assertRaises(HTTPException) as err_ab:
            verificar_acceso_vehiculo(self.cur, id_vehiculo=3, usuario=comprador_a, requiere_control=True)
        self.assertEqual(err_ab.exception.status_code, 403)

        # Comprador B intenta entrar a unidad de exhibición #1 sin ser suya -> 403
        with self.assertRaises(HTTPException) as err_exh:
            verificar_acceso_vehiculo(self.cur, id_vehiculo=1, usuario=comprador_b, requiere_control=True)
        self.assertEqual(err_exh.exception.status_code, 403)

    def test_admin_privacy_requires_buyer_support_consent(self) -> None:
        admin = {"id_usuario": 1, "rol": "admin"}

        # Admin SÍ puede controlar unidad en exhibición #1 (no tiene comprador)
        ctx_exh = verificar_acceso_vehiculo(self.cur, id_vehiculo=1, usuario=admin, requiere_control=True)
        self.assertEqual(ctx_exh["actor_tipo"], "admin")

        # Admin NO puede controlar ni espiar telemetría privada de unidad vendida #2 sin soporte -> 403
        with self.assertRaises(HTTPException) as err_no_sup:
            verificar_acceso_vehiculo(self.cur, id_vehiculo=2, usuario=admin, requiere_control=True)
        self.assertEqual(err_no_sup.exception.status_code, 403)

        with self.assertRaises(HTTPException) as err_ws_priv:
            verificar_acceso_vehiculo(
                self.cur,
                id_vehiculo=2,
                usuario=admin,
                requiere_control=False,
                requiere_privacidad_vendido=True,
            )
        self.assertEqual(err_ws_priv.exception.status_code, 403)

        # Comprador A concede soporte temporal -> Admin ahora SÍ accede como admin_soporte
        self.cur.soporte.append(
            {
                "id_soporte": 99,
                "id_vehiculo": 2,
                "id_usuario_dueno": 2,
                "motivo": "Diagnóstico",
                "activo": 1,
                "fecha_inicio": datetime.now(timezone.utc).replace(tzinfo=None),
                "fecha_expiracion": datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=20),
            }
        )
        ctx_sup = verificar_acceso_vehiculo(self.cur, id_vehiculo=2, usuario=admin, requiere_control=True)
        self.assertEqual(ctx_sup["actor_tipo"], "admin_soporte")

    def test_guest_exclusivity_ttl_and_command_whitelist(self) -> None:
        invitado_user = {"id_usuario": 3, "rol": "invitado"}

        # Invitado sin token de reserva -> 403
        with self.assertRaises(HTTPException) as err_no_tok:
            verificar_acceso_vehiculo(self.cur, id_vehiculo=1, usuario=invitado_user, requiere_control=True)
        self.assertEqual(err_no_tok.exception.status_code, 403)

        # Token vencido -> 401
        with self.assertRaises(HTTPException) as err_exp:
            verificar_acceso_vehiculo(
                self.cur,
                id_vehiculo=1,
                usuario=invitado_user,
                guest_token="guest-expired-token-51",
                requiere_control=True,
            )
        self.assertEqual(err_exp.exception.status_code, 401)

        # Token válido en unidad exhibición #1 -> permitido
        ctx_g = verificar_acceso_vehiculo(
            self.cur,
            id_vehiculo=1,
            usuario=invitado_user,
            guest_token="guest-valid-token-50",
            requiere_control=True,
        )
        self.assertTrue(ctx_g["es_invitado"])

        # Token válido de #1 NO sirve para unidad vendida #2 -> 401
        with self.assertRaises(HTTPException) as err_cross:
            verificar_acceso_vehiculo(
                self.cur,
                id_vehiculo=2,
                guest_token="guest-valid-token-50",
                requiere_control=True,
            )
        self.assertEqual(err_cross.exception.status_code, 401)

        # Comandos permitidos vs bloqueados por capacidades del modelo
        cmd_avanzar = validar_comando_para_actor(self.cur, vehiculo=ctx_g["vehiculo"], id_comando=1, es_invitado=True)
        self.assertEqual(cmd_avanzar["codigo"], 1)
        cmd_detener = validar_comando_para_actor(self.cur, vehiculo=ctx_g["vehiculo"], id_comando=9, es_invitado=True)
        self.assertEqual(cmd_detener["codigo"], 9)

        with self.assertRaises(HTTPException) as err_cmd:
            validar_comando_para_actor(self.cur, vehiculo=ctx_g["vehiculo"], id_comando=5, es_invitado=True)
        self.assertEqual(err_cmd.exception.status_code, 403)

    def test_inactive_unit_and_anon_denied(self) -> None:
        with self.assertRaises(HTTPException) as err_anon:
            verificar_acceso_vehiculo(self.cur, id_vehiculo=1, usuario=None, permitir_anonimo_legacy=False)
        self.assertEqual(err_anon.exception.status_code, 401)

        with self.assertRaises(HTTPException) as err_baja:
            verificar_acceso_vehiculo(
                self.cur,
                id_vehiculo=4,
                usuario={"id_usuario": 1, "rol": "admin"},
                requiere_control=True,
            )
        self.assertEqual(err_baja.exception.status_code, 409)

    def test_rate_limiter_never_blocks_detener(self) -> None:
        limiter = ControladorTasa(max_peticiones=3, ventana_segundos=60)
        self.assertTrue(limiter.verificar_y_registrar("u2:v2", id_comando=1, codigo=1))
        self.assertTrue(limiter.verificar_y_registrar("u2:v2", id_comando=1, codigo=1))
        self.assertTrue(limiter.verificar_y_registrar("u2:v2", id_comando=1, codigo=1))
        self.assertFalse(limiter.verificar_y_registrar("u2:v2", id_comando=1, codigo=1))
        # Emergencia DETENER (9) siempre pasa
        self.assertTrue(limiter.verificar_y_registrar("u2:v2", id_comando=9, codigo=9))

    def test_ws_manager_room_isolation_and_revocation(self) -> None:
        async def _run():
            mgr = GestorWebSockets()
            ws_owner = FakeWebSocket()
            ws_guest = FakeWebSocket()
            ws_other_unit = FakeWebSocket()

            await mgr.conectar(1, ws_guest, {"actor_tipo": "invitado", "id_sesion_invitado": 50})
            await mgr.conectar(2, ws_owner, {"actor_tipo": "propietario", "id_usuario": 2})
            await mgr.conectar(3, ws_other_unit, {"actor_tipo": "propietario", "id_usuario": 4})

            await mgr.emitir_a_vehiculo(2, {"evento": "movimiento_individual", "id_vehiculo": 2})
            self.assertEqual(len(ws_owner.sent), 1)
            self.assertEqual(len(ws_other_unit.sent), 0)
            self.assertEqual(len(ws_guest.sent), 0)

            cerradas = await mgr.revocar_conexiones(1, id_sesion_invitado=50, motivo="Tiempo expirado", code=4008)
            self.assertEqual(cerradas, 1)
            self.assertEqual(ws_guest.closed, (4008, "Tiempo expirado"))
            self.assertIsNone(ws_owner.closed)

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main(verbosity=2)

