# Control y Monitoreo Web en Tiempo Real — Vehículo IoT (AWS EC2, Amazon RDS & WSS)

Aplicación web **Mobile First** (HTML5, CSS3, Bootstrap 5 y JavaScript ES6+ modular sin dependencias de compilación) destinada al **Control remoto (4.1)** y **Monitoreo en tiempo real (4.2)** de una excavadora IoT (`id_vehiculo = 1`, *Excavadora del IOT* con NodeMCU ESP8266), integrada mediante **HTTPS (Fetch API)** y **WebSocket Seguro (WSS)** con la API FastAPI desplegada en **Amazon EC2** (`https://3.214.170.24.nip.io`) y persistencia en **Amazon RDS MySQL** mediante 21 procedimientos almacenados.

---

## 1. Arquitectura General del Sistema

```text
┌───────────────────────────┐     HTTPS (REST) + WSS      ┌──────────────────────────┐
│  Frontend SPA (GitHub     │ ◄─────────────────────────► │  Backend FastAPI (AWS    │
│  Pages: Control + Mon.)   │   1 conexión WSS compartida │  EC2) · 21 Stored Procs  │
└───────────────────────────┘                             └────────────┬─────────────┘
                                                                       │
                                              ┌────────────────────────┴──────────────────────┐
                                              ▼                                               ▼
                                 ┌─────────────────────────┐                    ┌─────────────────────────┐
                                 │   Amazon RDS MySQL      │                    │   Vehículo Físico IoT   │
                                 │ estado_vehiculo +       │                    │ NodeMCU ESP8266 +       │
                                 │ historial_comandos      │                    │ 74HC595 (WSS cliente)   │
                                 └─────────────────────────┘                    └─────────────────────────┘
```

- **Vista única SPA (`index.html`):** El usuario navega entre **Control** (`#control`) y **Monitoreo** (`#monitoreo`) sin recargar el documento ni duplicar la conexión WSS.
- **Retroalimentación visual en Control:** Pantalla LCD limpia para el operador con estado persistente del **LED** y **Sonido** (inician encendidos igual que el vehículo físico y alternan en tiempo real al recibir comandos `LED` o `Sonido`, manteniendo su estado encendido/apagado con animación de ondas sonoras), un **puntito piloto de actividad** que brilla al enviar o ejecutar movimientos, y un banner destacado cuando hay una secuencia DEMO en curso.
- **Vista Monitoreo en tiempo real:** Muestra la tarjeta destacada de **Último movimiento reportado** (o la **Demo actualmente en ejecución** sin mezclar sus pasos internos en la tabla) y la tabla de los **Últimos 10 movimientos individuales persistidos** en Amazon RDS.

---

## 2. Estructura de Carpetas y Mapa de Módulos

```text
iot-vehiculo-control/
├── index.html                        # Shell principal SPA con navegación Control / Monitoreo e indicadores globales
├── README.md                         # Documentación técnica, contratos AWS, ejecución y matriz de pruebas
└── assets/
    ├── css/
    │   └── styles.css                # Identidad retro Mobile First, animaciones LED/bocina, demos y vista Monitoreo
    ├── img/
    │   └── favicon.svg               # Ícono/favicon vectorial del proyecto compatible con GitHub Pages
    └── js/
        ├── config.js                 # URLs base HTTPS/WSS, id_vehiculo, límites y tiempos de espera/reconexión
        ├── format-utils.js           # Normalización UTC -> hora local, formato legible y resolución de eventos
        ├── api-client.js             # Cliente HTTP Fetch modular con AbortController, timeouts y detección DB/SP
        ├── ws-client.js              # Cliente WSS único compartido con backoff exponencial y callback de reconexión
        ├── navigation.js             # Navegación accesible entre Control y Monitoreo vía hash sin recarga
        ├── ui-manager.js             # Renderizado DOM seguro para Control, LED piloto, bocina animada y demos
        ├── command-controller.js     # Despacho de comandos, control de secuencia, anti-spam y prioridad DETENER
        ├── joystick.js               # Control direccional Pointer Events (táctil/mouse) y flechas de teclado
        ├── demo-controller.js        # Ejecución, progreso visual y cancelación segura de secuencias DEMO
        ├── monitoring-sync.js        # Sincronización REST/WSS, deduplicación, concurrencia y aislamiento de DEMO
        ├── monitoring-view.js        # Renderizado seguro de tarjeta de último estado, demo activa y tabla de 10 filas
        └── main.js                   # Orquestador de conectividad independiente, Control, Monitoreo y WSS único
```

---

## 3. Contratos de AWS Consumidos (REST & WebSocket)

Todos los endpoints se consumen por **HTTPS / WSS** con rutas relativas compatibles con GitHub Pages y **sin incrustar credenciales, llaves ni secretos**.

### 3.1 Endpoints REST (`HTTPS` en `https://3.214.170.24.nip.io`)

| Método | Ruta | Propósito | Campos clave consumidos |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Salud real del servidor FastAPI en EC2 | `estado`, `servicio` |
| `GET` | `/vehiculos/1` | Metadatos del vehículo | `id_vehiculo`, `nombre`, `modelo`, `microcontrolador` |
| `GET` | `/vehiculos/1/comandos` | Catálogo activo de comandos | `id_comando`, `nombre`, `codigo`, `activo` |
| `GET` | `/vehiculos/1/demos` | Catálogo de secuencias DEMO | `id_demo`, `nombre`, `activo` |
| `GET` | `/vehiculos/1/estado` | Último estado persistido en RDS | `vehiculo`, `comando`, `codigo`, `conectado`, `fecha_actualizacion` |
| `GET` | `/vehiculos/1/historial` | Últimos 10 movimientos persistidos | `movimientos[]`: `id_historial`, `id_vehiculo`, `comando`, `codigo`, `fecha_hora`, `origen` |
| `POST` | `/movimientos` | Enviar movimiento individual desde Control | Payload: `{ id_vehiculo, id_comando, origen }` |
| `POST` | `/demos/ejecutar` | Iniciar secuencia DEMO en backend | Payload: `{ id_vehiculo, id_demo }` |
| `POST` | `/demos/{id_vehiculo}/cancelar` | Cancelación segura de DEMO activa | `mensaje` |

### 3.2 Canal en Tiempo Real (`WSS` en `wss://3.214.170.24.nip.io/ws/vehiculos/1`)

- **Conexión única compartida:** `WsClient` abre una sola sesión WSS para toda la aplicación. Al desconectarse aplica espera progresiva (`2s → 4s → 8s → 15s`) y al reconectar dispara resincronización REST automática.
- **Filtrado estricto:** Solo se procesan eventos donde `id_vehiculo === 1`.
- **Eventos soportados:**
  - `estado_inicial`: confirma conectividad WSS e hidrata el estado inicial si es más reciente.
  - `movimiento_individual`: actualiza la pantalla de Control (LED/bocina), la tarjeta de **Último movimiento reportado** en Monitoreo y programa una reconciliación controlada (`debounce 300 ms`) contra `GET /vehiculos/1/historial` y `GET /vehiculos/1/estado`.
  - `demo_inicio`, `demo_movimiento`, `demo_fin`, `demo_cancelada`, `demo_error`: en **Control** muestran progreso paso a paso, bloquean comandos incompatibles (manteniendo **Detener**) y animan LED/bocina; en **Monitoreo** muestran **qué DEMO se está ejecutando** (sin exponer los movimientos internos ni alterar el historial individual de RDS).

---

## 4. Reglas de Sincronización, Fechas e Indicadores

1. **Normalización de fechas y zona horaria:**
   - El backend envía `timestamp` WSS en UTC con sufijo `+00:00` y fechas de MySQL RDS (`fecha_actualizacion`, `fecha_hora`) en ISO naive UTC (`YYYY-MM-DDTHH:MM:SS`).
   - `format-utils.js` agrega `Z` a marcas naive válidas antes de convertirlas a la zona horaria local del navegador (`DD/MM/YYYY` y `HH:mm:ss`) y muestra la zona activa en Monitoreo. Si falta fecha, muestra `Sin fecha/hora reportada` sin fabricar marcas temporales.
2. **Protección contra sobrescritura y duplicados:**
   - Cada petición REST registra secuencia (`seq_estado`, `seq_historial`) y tiempo de inicio (`req_started_at`). Una respuesta REST antigua o tardía nunca sobrescribe una actualización WSS más reciente.
   - El historial deduplica por `id_historial`, ordena descendente (`fecha_hora` desc, `id_historial` desc) y limita la vista a máximo **10 filas** (sin eliminar registros de RDS).
3. **Tres indicadores de conectividad independientes (en ambas vistas):**
   - **WebSocket WSS:** refleja únicamente la sesión WebSocket del navegador (`En línea` / `Conectando` / `Reconectando` / `Desconectado`), nunca presencia física del microcontrolador.
   - **Servidor AWS · API:** consulta periódicamente `GET /` con timeout (`5 s`) y tolerancia a microcortes (requiere 2 fallos consecutivos en chequeo automático).
   - **Amazon RDS:** pasa a `Disponible (SP Verificado)` únicamente cuando un endpoint respaldado por stored procedure responde correctamente; errores 500/DB muestran `No disponible (Error SP/RDS)`.

---

## 5. Ejecución Local y Despliegue en GitHub Pages

### Ejecución local
1. Clonar o abrir la carpeta del proyecto `iot-vehiculo-control/`.
2. Iniciar un servidor HTTP estático desde la raíz (para habilitar módulos ES6):
   - Con Python: `python -m http.server 8080`
   - O con la extensión **Live Server** en VS Code sobre `index.html`.
3. Abrir `http://localhost:8080/` en navegador o dispositivo móvil en la misma red.

### Publicación en GitHub Pages
- Todas las referencias en `index.html` e imports en `assets/js/` son **rutas relativas** (`./assets/...`) compatibles con subrutas como `https://<usuario>.github.io/iot-vehiculo-control/`.
- La aplicación opera íntegramente bajo **HTTPS** y **WSS** sin contenido mixto HTTP.

---

## 6. Criterios de Comprobación (Pruebas Funcionales 4.2)

1. **Prueba A — Carga inicial (REST):** Abrir **Monitoreo** (`#monitoreo`) y verificar en DevTools → Network las llamadas `GET /vehiculos/1/estado` y `GET /vehiculos/1/historial`, mostrando máximo 10 filas ordenadas del más reciente al más antiguo (o estado vacío si no existen registros).
2. **Prueba B — Evento en vivo (WSS + reconciliación):** En **Control**, presionar `AVANZAR`, `GIRAR_DERECHA` o `DETENER`; verificar el cambio visual de LED/bocina, la llegada del evento en un cliente WSS externo (`/monitor` o Postman) y la actualización automática en **Monitoreo** sin recargar la página.
3. **Prueba C — Origen externo y límite de 10:** Enviar comandos al vehículo `1` desde otra pestaña o cliente REST/Postman; confirmar actualización inmediata en **Monitoreo** y que tras superar 10 movimientos solo permanecen visibles los 10 más recientes sin duplicados.
4. **Prueba D — Reconexión e indicadores independientes:** Interrumpir y restaurar la red/WSS; confirmar transición a `Desconectado` → `Reconectando` → `En línea`, preservación del último valor conocido (`Último conocido`) y resincronización REST automática.
5. **Prueba E — DEMO, fechas y responsividad:** Ejecutar y cancelar una **DEMO**; comprobar en **Control** el indicador activo de demo y en **Monitoreo** que se muestra **el nombre de la demo en ejecución** sin contaminar la tabla de 10 movimientos individuales. Verificar diseño sin desbordamiento horizontal en móvil vertical, móvil horizontal y escritorio.
