# Control, Monitoreo y Administración Web en Tiempo Real — Vehículo IoT (AWS EC2, Amazon RDS & WSS)

Plataforma web **Mobile First** (HTML5 semántico, CSS3, Bootstrap 5 y JavaScript ES6+ modular sin paso de compilación) que integra:
- **Práctica 4.1 (`#control`):** Control remoto en tiempo real con joystick táctil continuo, botones dedicados, parada prioritaria `DETENER` (botón + tecla Espacio), estado persistente de LED/Sonido, indicador de transmisión y secuencias demo.
- **Práctica 4.2 (`#monitoreo`):** Monitoreo en tiempo real con tarjeta de último movimiento reportado, banner de demo activa y tabla dinámica de los 10 últimos movimientos individuales persistidos en Amazon RDS (`America/Mexico_City`).
- **Práctica 4.3 (`#administracion`):** Tercer módulo para gestión comercial e IoT separando **Modelos comerciales** de **Unidades físicas serializadas**, clientes compradores, asignaciones, **autorización explícita de soporte** sobre unidades vendidas, seguridad **RBAC + BOLA/IDOR** (REST y WSS), editor visual de demos privadas (`★`) y catálogo público con pruebas temporizadas de 3 minutos para Invitado.

> [!NOTE]
> Para el diagrama Entidad-Relación completo (`Mermaid`), la tabla de reutilización de las **21 APIs existentes** y el checklist paso a paso de despliegue AWS, consulta [docs/arquitectura_y_pruebas.md](file:///c:/Users/ajcr0/OneDrive/Documents/TecPachuca/9no%20Semestre/IOT/4%20ta%20Unidad/iot-vehiculo-control/docs/arquitectura_y_pruebas.md).

---

## 1. Diagnóstico Integral («EXISTE / SE REUTILIZA / SE MODIFICA / SE CREA»)

| Componente | Clasificación | Descripción Técnica |
| :--- | :--- | :--- |
| **Frontend 4.1 (Control)** | `SE REUTILIZA` | Joystick virtual continuo, botones de oruga/brazo/giro, display LCD con LED/Bocina y prioridad `DETENER`, ahora con filtro dinámico para sesiones de Invitado. |
| **Frontend 4.2 (Monitoreo)** | `SE REUTILIZA` | Tarjeta de último movimiento, tabla de 10 filas máximas desde Amazon RDS, normalización horaria local y aislamiento al cambiar de unidad activa. |
| **Navegación Tri-Vista** | `SE MODIFICA` | `navigation.js` gestiona `#control`, `#monitoreo` y `#administracion` con validación RBAC que bloquea `#administracion` para `invitado` y adapta la etiqueta para `usuario` ("Mis Vehículos"). |
| **Sesión JWT y Roles** | `SE CREA` | `auth-session.js` autentica vía `POST /auth/login` (JWT HS256), gestiona `token_sesion` de prueba Invitado y mantiene respaldo local estricto cuando EC2 no expone aún las rutas nuevas. |
| **Notificaciones No Intrusivas** | `SE CREA` | `toast.js` reemplaza alertas bloqueantes del navegador con notificaciones Bootstrap 5 compatibles con escritorio y móvil. |
| **Módulo Administración / Garage** | `SE CREA` | `admin-view.js` implementa KPIs, modelos + capacidades, unidades serializadas, clientes, asignaciones, bitácora de auditoría y panel Comprador de soporte técnico y demos privadas. |
| **Editor Visual de Demos** | `SE CREA` | `demo-editor.js` permite crear/editar rutinas personalizadas, agregar hasta 30 pasos, reordenarlos (`▲`/`▼`) y persistirlos en RDS. |
| **Catálogo y Prueba Invitado** | `SE CREA` | `guest-view.js` consulta `/invitado/catalogo`, reserva unidades de exhibición por 3 minutos (respetando `409 Conflict`) y ejecuta parada automática al expirar. |
| **21 APIs Existentes + Nuevas** | `SE REUTILIZA / CREA` | `backend/app/routers/vehiculos_control.py` conserva los endpoints 4.1/4.2 bajo RBAC + BOLA/IDOR; `auth.py`, `admin.py`, `usuario.py` e `invitado.py` amplían el sistema sin romper compatibilidad. |
| **Canal WebSocket WSS** | `SE MODIFICA` | `/ws/vehiculos/{id_vehiculo}` valida token JWT o `guest_token` antes de aceptar suscripciones y emite `DETENER` automático si la sesión de Invitado expira o se desconecta. |
| **Esquema MySQL Amazon RDS** | `SE MODIFICA / CREA` | Conserva tablas e IDs de 4.1/4.2 (`vehiculos`, `comandos`, `estado_vehiculo`, `historial_comandos`, `demos`, `demo_movimientos`) y agrega `roles`, `usuarios`, `modelos_vehiculo`, `modelo_comandos`, `asignaciones_vehiculo`, `soporte_autorizaciones`, `sesiones_invitado`, `auditoria_operaciones` y `tokens_revocados`. |

---

## 2. Modelo de Negocio, Seguridad RBAC y Privacidad del Comprador

| Rol | Alcance en la Plataforma | Restricciones de Seguridad (REST y WSS) |
| :--- | :--- | :--- |
| **`admin` (Empresa)** | Gestiona modelos comerciales, comandos permitidos, unidades serializadas, clientes, asignaciones, demos de fábrica y bitácora de auditoría; controla unidades `disponible` / `exhibicion` / `mantenimiento`. | **Privacidad del comprador:** Recibe `HTTP 403` si intenta operar o visualizar controles privados de una unidad `vendido`, salvo que el dueño le otorgue **autorización temporal explícita de soporte** (`soporte_autorizaciones`). |
| **`usuario` (Comprador)** | Accede únicamente a sus unidades en **Mis Vehículos**, controla y monitorea en vivo, crea/edita demos privadas (`★`) y concede o revoca soporte técnico temporal al administrador. | Aislamiento **BOLA/IDOR**: Bloqueado (`HTTP 403`) ante unidades ajenas, exhibiciones o rutas administrativas CRUD. |
| **`invitado` (Visitante)** | Consulta catálogo público de modelos e inicia sesiones exclusivas de 3 minutos en unidades de `exhibicion` disponibles con comandos básicos filtrados. | No accede a `#administracion`, unidades vendidas ni demos privadas; segundo cliente concurrente recibe `HTTP 409 Conflict`. |

---

## 3. Migración SQL Versionada y Despliegue Seguro en Amazon RDS

Los scripts de base de datos se ubican en `db/`:
- **[db/respaldo_instrucciones.md](file:///c:/Users/ajcr0/OneDrive/Documents/TecPachuca/9no%20Semestre/IOT/4%20ta%20Unidad/iot-vehiculo-control/db/respaldo_instrucciones.md):** Procedimiento obligatorio de respaldo con `mysqldump` y consideración de commits implícitos de DDL en MySQL.
- **[db/001_migracion_administracion_up.sql](file:///c:/Users/ajcr0/OneDrive/Documents/TecPachuca/9no%20Semestre/IOT/4%20ta%20Unidad/iot-vehiculo-control/db/001_migracion_administracion_up.sql):** Creación de tablas nuevas, `ALTER TABLE` condicionales vía `information_schema`, llaves foráneas, índices y datos semilla con hashes PBKDF2-SHA256 (310,000 iteraciones).
- **[db/001_verificacion_integridad.sql](file:///c:/Users/ajcr0/OneDrive/Documents/TecPachuca/9no%20Semestre/IOT/4%20ta%20Unidad/iot-vehiculo-control/db/001_verificacion_integridad.sql):** Comprobaciones post-migración de conteos, FKs, integridad de demos e historial previo.
- **[db/001_migracion_administracion_down.sql](file:///c:/Users/ajcr0/OneDrive/Documents/TecPachuca/9no%20Semestre/IOT/4%20ta%20Unidad/iot-vehiculo-control/db/001_migracion_administracion_down.sql):** Reversión controlada para entornos de prueba sin eliminar tablas históricas de 4.1/4.2.

---

## 4. Backend Modular FastAPI (`backend/`)

```text
backend/
├── requirements.txt                  # fastapi, uvicorn, pymysql, pydantic, PyJWT, bcrypt, cryptography, httpx, pytest
├── .env.example                      # Plantilla de variables DB_*, JWT_SECRET_KEY y CORS_ORIGINS (sin secretos)
├── app/
│   ├── main.py                       # FastAPI core, lifespan (expirador Invitado/Soporte), CORS estricto, WSS multi-unidad y /, /health, /monitor
│   ├── core/
│   │   ├── config.py                 # Lectura .env, CORS sin wildcard '*', tiempos de sesión y códigos
│   │   ├── db.py                     # Pool/context manager PyMySQL y verificar_salud_db()
│   │   ├── security.py               # PBKDF2/Bcrypt, JWT HS256, tokens_revocados, RBAC, BOLA/IDOR, soporte explícito y auditoría
│   │   └── ws_manager.py             # ControladorTasa (exime DETENER=9), salas WSS y GestorDemosActivas
│   ├── models/
│   │   └── schemas.py                # Modelos Pydantic v2 de entrada/salida y validaciones
│   └── routers/
│       ├── auth.py                   # /auth/login, /auth/me, /auth/logout
│       ├── admin.py                  # /admin/dashboard, modelos, capacidades, unidades, clientes, asignaciones, demos-fabrica, auditoría
│       ├── usuario.py                # /usuario/mis-vehiculos, soporte/{id}, demos privadas CRUD
│       ├── invitado.py               # /invitado/catalogo, solicitar-prueba, finalizar-prueba
│       └── vehiculos_control.py      # 18 rutas REST heredadas de 4.1 y 4.2 endurecidas con RBAC + BOLA/IDOR
└── tests/
    ├── test_rbac_unit.py             # Pruebas unitarias locales (PBKDF2, tasa DETENER, soporte vendido, CORS)
    └── test_api_integration.py       # Pruebas HTTP/WSS TestClient (requiere entorno con dependencias instaladas)
```

---

## 5. Estructura del Frontend (`index.html` + `assets/`)

```text
iot-vehiculo-control/
├── index.html                        # SPA Tri-Vista (Control, Monitoreo, Administración) + Modal Login JWT + Editor Demos
├── README.md                         # Guía general del proyecto
├── docs/
│   └── arquitectura_y_pruebas.md     # Diagrama ER (Mermaid), matriz de 21 APIs y checklist de despliegue AWS
└── assets/
    ├── css/styles.css                # Estética retro-tech Bootstrap 5 + responsivo móvil (`<= 575.98px`) a 4K
    ├── img/
    │   ├── excavadora.svg            # Ilustración vectorial catálogo Excavadora IoT
    │   ├── rover.svg                 # Ilustración vectorial catálogo Rover Explorador
    │   └── favicon.svg
    └── js/
        ├── config.js                 # URLs base EC2 y diccionario centralizado de endpoints
        ├── toast.js                  # Notificaciones visuales no bloqueantes
        ├── api-client.js             # Cliente Fetch con Bearer JWT, X-Guest-Token y timeouts
        ├── ws-client.js              # Canal WSS autenticado con reconexión y backoff exponencial
        ├── auth-session.js           # Sesión JWT + respaldo local estricto
        ├── navigation.js             # Enrutador de vistas #control / #monitoreo / #administracion
        ├── admin-view.js             # Panel de Administración + Vista Comprador (Mis Vehículos y Soporte)
        ├── demo-editor.js            # Editor visual de demos personalizadas
        ├── guest-view.js             # Catálogo público y temporizador exclusivo de Invitado
        ├── command-controller.js     # Envío atómico con filtro para Invitado y prioridad DETENER
        ├── joystick.js               # Joystick táctil/pointer continuo
        ├── demo-controller.js        # Orquestación de ejecución/cancelación de demos
        ├── monitoring-sync.js        # Sincronización WSS + REST y limpieza al cambiar de unidad
        ├── monitoring-view.js        # Renderizado de último movimiento y tabla de 10 filas
        ├── ui-manager.js             # Display LCD, LED/Bocina persistentes y punto pilot TX
        ├── format-utils.js           # Normalización horaria America/Mexico_City y limpieza de nombres
        └── main.js                   # Integración general y cambio dinámico de vehículo
```

---

## 6. Cuentas de Acceso (Login por Usuario/Correo, Contraseña y Rol)

El sistema implementa un **control de acceso basado en credenciales individuales y rol (RBAC)**. Desde el menú superior de cuenta (`Iniciar sesión / Cambiar usuario`), cada usuario ingresa su **usuario o correo** y su **contraseña**:

| Rol en el Sistema | Usuario Corto | Correo Electrónico | Contraseña | Permisos Asignados |
| :--- | :--- | :--- | :--- | :--- |
| **Administrador (`admin`)** | `admin` | `admin@iot.empresa.com` | `Admin123!*` | Gestión de modelos, unidades, alta/edición de usuarios y roles, asignaciones, demos de fábrica y bitácora de auditoría. Bloqueado en unidades `vendido` sin autorización de soporte del comprador. |
| **Comprador 1 (`usuario`)** | `carlos` | `comprador@cliente.com` | `Comprador123!*` | Acceso exclusivo a **Mis Vehículos**, control/monitoreo de unidades propias, autorización temporal de soporte técnico (30 min) y editor de demos privadas (`★`). |
| **Comprador 2 (`usuario`)** | `sofia` | `s.rivas@constructora.mx` | `CompradorB123!*` | Segunda cuenta de comprador para verificar aislamiento **BOLA/IDOR** entre clientes. |
| **Invitado (`invitado`)** | `invitado` | `invitado@demo.com` | `Invitado123!*` | Exploración del catálogo público y solicitud de sesión de prueba exclusiva de 3 minutos en unidades de exhibición. |

> **Alta dinámica de usuarios:** Cualquier usuario nuevo registrado por el Administrador en `Administración > Usuarios y Clientes` (eligiendo su nombre, correo, contraseña y rol `Comprador`, `Administrador` o `Invitado`) queda habilitado inmediatamente para iniciar sesión en el modal de Login.

---

## 7. Matriz de Pruebas Obligatorias (P01 – P17 · Punto 12.6)

| ID | Caso de Prueba | Rol | Acción a Ejecutar | Resultado Esperado | Clasificación | Evidencia |
| :- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P01** | Login Admin | `admin` | Abrir Login e ingresar `admin` (`admin@iot.empresa.com`) / `Admin123!*`. | Sesión autenticada; habilita las 3 vistas y el panel de Administración. | `Correcto` | `👑 Admin · admin` en cabecera |
| **P02** | Alta de unidad | `admin` | En `Administración > Inventario`, crear unidad física con serie único (`SN-EXCAV-003`). | Unidad guardada con estado `DISPONIBLE` y suma al KPI de unidades. | `Correcto` | Fila en tabla de Unidades |
| **P03** | Alta de cliente | `admin` | En `Administración > Usuarios y Clientes`, registrar nuevo usuario con correo, rol y contraseña (`>= 8` car.). | Usuario creado y habilitado de inmediato para iniciar sesión con su contraseña. | `Correcto` | Registro activo en Usuarios |
| **P04** | Asignación | `admin` | Asignar una unidad disponible a un usuario comprador. | La unidad cambia a estado `VENDIDO` y se vincula exclusivamente al comprador. | `Correcto` | Auditoría `ASIGNAR_VEHICULO` |
| **P05** | Aislamiento de comprador | `usuario` | Iniciar sesión con la cuenta del Comprador (`carlos` o nuevo comprador). | Solo visualiza sus unidades en `Mis Vehículos`; no ve inventario ajeno. | `Correcto` | Selector limitado por dueño |
| **P06** | Control | `usuario` | Operar joystick continuo, botones dedicados y parada prioritaria `DETENER` (botón o Espacio). | Respuesta continua, prioridad absoluta de parada e indicadores LED/Bocina activos. | `Correcto` | LCD + punto TX en verde |
| **P07** | WSS | `usuario` | Abrir segunda ventana sobre el mismo vehículo y enviar comandos. | Ambas ventanas actualizan LCD, iconos y Monitoreo en tiempo real vía WSS. | `Correcto` | Evento WSS en vivo |
| **P08** | Historial 10 | `usuario` | Generar más de 10 movimientos individuales y abrir `Monitoreo`. | La tabla muestra exactamente los 10 movimientos más recientes de Amazon RDS. | `Correcto` | Tabla RDS `10 / 10` |
| **P09** | Demo persistente | `usuario` | Abrir `Editor de Demos`, configurar pasos/duraciones (ms), reordenar (`▲/▼`) y guardar. | La rutina privada se guarda con prefijo `★` asociada al comprador y unidad. | `Correcto` | Demo `★` en selector |
| **P10** | Ejecución/cancelación | `usuario` | Ejecutar una demo y presionar `Cancelar demo` o `Detener vehículo`. | Se interrumpe la secuencia de inmediato y se envía `DETENER`. | `Correcto` | Banner `Demo cancelada` |
| **P11** | Prueba Invitado | `invitado` | En modo `Invitado`, elegir modelo disponible en el catálogo e iniciar prueba de 3 min. | Reloj `03:00` en cuenta regresiva y botones filtrados a comandos permitidos. | `Correcto` | Banner de prueba activo |
| **P12** | Rechazo Admin al Invitado | `invitado` | Con rol `Invitado`, intentar entrar a la pestaña `Administración` (`#administracion`). | Se bloquea el acceso mostrando notificación `HTTP 403 Prohibido`. | `Correcto` | Permanece en `Control` |
| **P13** | Rechazo vehículo ajeno | `usuario` / `admin` | Comprador intenta ver unidad ajena, o Admin intenta controlar unidad `VENDIDO` sin soporte. | Acceso bloqueado con `HTTP 403 Prohibido` hasta que el comprador autorice Soporte. | `Correcto` | Toast `403` + auditoría |
| **P14** | Exclusividad | `invitado` | Intentar iniciar una segunda prueba simultánea en la misma unidad de exhibición. | Rechazo `HTTP 409 Conflict` indicando que la unidad está en uso; al llegar a `00:00` emite `DETENER`. | `Correcto` | Mensaje de unidad ocupada |
| **P15** | Reconexión | Todos | Simular desconexión o pulsar `Verificar red` en la cabecera. | WSS reconecta automáticamente con backoff y reconcilia estado e historial vía REST. | `Correcto` | Indicadores WSS/API/RDS verdes |
| **P16** | Responsive | Todos | Evaluar la interfaz en móvil (`360px`–`430px` en DevTools `F12`), tablet y escritorio. | Sin desbordamiento horizontal; joystick, LCD, tablas y formularios adaptados. | `Correcto` | Vista móvil limpia |
| **P17** | Auditoría | `admin` | Iniciar sesión como `Admin` y consultar `Administración > Auditoría`. | Bitácora registra fecha/hora, usuario, acción (`LOGIN_EXITOSO`, `ALTA_USUARIO`, etc.) y detalles. | `Correcto` | Tabla de auditoría poblada |

---

## 8. Conclusiones Personales (Apartado 16 · Práctica 4.3)

1. **Integración modular y roles comerciales (16.1):** La ampliación hacia la aplicación de **Administración (4.3)** se construyó sobre el mismo repositorio e interfaz de **Control (4.1)** y **Monitoreo (4.2)** sin afectar el joystick continuo, la prioridad del comando `DETENER` ni la consulta de los 10 movimientos en RDS. El esquema de inicio de sesión individual con usuario, contraseña y rol permite separar con claridad las responsabilidades del **Administrador** (gestión comercial de catálogo, unidades, clientes y auditoría), del **Usuario Comprador** (control privado de sus unidades, soporte bajo consentimiento y demos propias) y del **Invitado** (catálogo público y prueba temporal acotada).
2. **Diseño relacional y migraciones no destructivas (16.2):** En la base de datos `vehiculo_iot` se preservaron íntegramente las tablas e identificadores históricos de las prácticas anteriores, separando el concepto de **Modelo comercial** (`modelos_vehiculo` y `modelo_comandos`) del de **Unidad física serializada** (`vehiculos` con `numero_serie` e inventario). Las tablas de `roles`, `usuarios`, `asignaciones_vehiculo`, `soporte_autorizaciones`, `sesiones_invitado`, `auditoria_operaciones` y `tokens_revocados` se estructuraron en scripts versionados (`UP`, `DOWN` y verificación) considerando el commit implícito de las sentencias DDL en MySQL.
3. **Reutilización de las 21 APIs y autorización por recurso (16.3):** Se reutilizaron los 21 endpoints existentes para estado, historial, comandos, demos y salud, añadiendo validación de sesión y propiedad por unidad (`BOLA/IDOR`) tanto en las rutas REST como en el canal WebSocket `/ws/vehiculos/{id_vehiculo}`, evitando que ocultar botones en el navegador sea la única barrera de seguridad.
4. **Pruebas multiusuario y privacidad del comprador (16.4):** Al validar el ciclo completo autenticando distintas cuentas de usuario, se comprobó que al asignar una unidad a un comprador se revocan permisos previos y ni siquiera el Administrador puede tomar control operativo de una unidad vendida salvo que el propietario habilite explícitamente la autorización temporal de soporte técnico.
5. **Seguridad operativa en exhibición y mejora futura (16.5):** Las sesiones de prueba de 3 minutos para invitados garantizan reserva exclusiva por unidad, restricción de comandos y detención automática (`DETENER`) al expirar el tiempo o cerrarse la conexión. Como mejora técnica futura, se plantea añadir autenticación criptográfica por token de dispositivo en el firmware del microcontrolador ESP8266/ESP32 y reporte de telemetría física de sensores y batería en tiempo real.

---

## 9. Despliegue Estático y Estado de Verificación

- **Frontend estático (GitHub Pages):** Configurado con rutas relativas `./assets/...` apuntando al backend `https://3.214.170.24.nip.io` (definido en [assets/js/config.js](file:///c:/Users/ajcr0/OneDrive/Documents/TecPachuca/9no%20Semestre/IOT/4%20ta%20Unidad/iot-vehiculo-control/assets/js/config.js)), sin exponer secretos ni credenciales de base de datos en el código fuente.

---

**Desarrollado por Andrés Jeriel Cruz Reséndiz · 2026**
