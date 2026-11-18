"""Suite de integración FastAPI TestClient (se ejecuta en EC2/CI con pytest y dependencias instaladas)."""

from __future__ import annotations

import contextlib
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

try:
    import fastapi  # noqa: F401
    from fastapi.testclient import TestClient  # noqa: F401
    FASTAPI_DISPONIBLE = True
except ImportError:
    FASTAPI_DISPONIBLE = False


@unittest.skipUnless(
    FASTAPI_DISPONIBLE,
    "Requiere FastAPI/TestClient instalado (entorno AWS EC2 o venv de pruebas)",
)
class ApiIntegrationMatrixTests(unittest.TestCase):
    """Cubre flujo HTTP + Swagger + RBAC usando TestClient con fake DB parcheable."""

    def setUp(self) -> None:
        from app import main as app_main
        from app.core import security as sec_mod
        from app.routers import admin as admin_mod
        from app.routers import auth as auth_mod
        from app.routers import invitado as inv_mod
        from app.routers import usuario as usr_mod
        from app.routers import vehiculos_control as vc_mod
        from tests.test_rbac_unit import SEED_HASHES, FakeSecurityCursor

        self.fake_cur = FakeSecurityCursor()
        self.fake_cur.usuarios[1]["password_hash"] = SEED_HASHES["admin@iot.empresa.com"][1]
        self.fake_cur.usuarios[2]["password_hash"] = SEED_HASHES["comprador@cliente.com"][1]
        self.fake_cur.usuarios[3]["password_hash"] = SEED_HASHES["invitado@demo.com"][1]
        self.fake_cur.usuarios[4]["password_hash"] = SEED_HASHES["s.rivas@constructora.mx"][1]

        cur_ref = self.fake_cur

        class _Conn:
            def cursor(self):
                @contextlib.contextmanager
                def _cm():
                    yield cur_ref

                return _cm()

            def commit(self):
                pass

            def rollback(self):
                pass

            def close(self):
                pass

        @contextlib.contextmanager
        def _fake_db(auto_commit: bool = False):
            yield _Conn()

        self._orig = []
        for mod in (app_main, sec_mod, auth_mod, admin_mod, usr_mod, inv_mod, vc_mod):
            if hasattr(mod, "obtener_conexion"):
                self._orig.append((mod, "obtener_conexion", mod.obtener_conexion))
                setattr(mod, "obtener_conexion", _fake_db)

        self.orig_health = app_main.verificar_salud_db
        app_main.verificar_salud_db = lambda: (True, "Disponible (Mock)")
        self.app_main = app_main
        self.client = TestClient(app_main.app)

    def tearDown(self) -> None:
        for mod, attr, fn in self._orig:
            setattr(mod, attr, fn)
        self.app_main.verificar_salud_db = self.orig_health

    def test_health_and_openapi_routes_exist(self) -> None:
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["rds_disponible"])

        openapi = self.client.get("/openapi.json")
        self.assertEqual(openapi.status_code, 200)
        paths = openapi.json()["paths"]
        for expected in (
            "/auth/login",
            "/auth/logout",
            "/admin/dashboard",
            "/admin/modelos/{id_modelo}/comandos",
            "/usuario/mis-vehiculos",
            "/usuario/soporte/{id_vehiculo}/autorizar",
            "/invitado/catalogo",
            "/invitado/solicitar-prueba",
            "/movimientos",
            "/demos/ejecutar",
        ):
            self.assertIn(expected, paths)

    def test_unauthenticated_endpoints_return_401(self) -> None:
        self.assertEqual(self.client.get("/admin/dashboard").status_code, 401)
        self.assertEqual(self.client.get("/usuario/mis-vehiculos").status_code, 401)
        self.assertEqual(
            self.client.post("/movimientos", json={"id_vehiculo": 1, "id_comando": 1}).status_code,
            401,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

