# Aplicación Web de Control - Vehículo IoT (AWS EC2, RDS & WebSocket)

Aplicación frontend Mobile First destinada exclusivamente al **Control** del vehículo IoT (`id_vehiculo = 1`), integrada mediante HTTPS (`Fetch API`) y WebSocket Seguro (`WSS`) con el backend existente en Amazon EC2 y persistencia en Amazon RDS MySQL mediante 21 procedimientos almacenados.

## 1. Arquitectura y Estructura del Proyecto

```text
iot-vehiculo-control/
├── index.html               # Vista principal semántica Mobile First + Bootstrap 5
├── README.md                # Documentación técnica y guía de pruebas
├── assets/
│   └── favicon.svg          # Favicon original del proyecto IoT compatible con GitHub Pages
├── css/
│   └── styles.css           # Estilos responsivos, indicadores accesibles y joystick táctil
└── js/
    ├── config.js            # Configuración centralizada de URLs y endpoints (sin secretos)
    ├── api-client.js        # Cliente HTTP Fetch modular con AbortController y manejo de errores
    ├── ws-client.js         # Cliente WebSocket WSS con reconexión automática
    ├── ui-manager.js        # Actualización segura del DOM mediante textContent
    ├── command-controller.js# Lógica de negocio de comandos, anti-spam y prioridad DETENER
    ├── joystick.js          # Controlador Pointer Events (mouse/touch) y teclado
    ├── demo-controller.js   # Ejecución y cancelación de secuencias DEMO
    └── main.js              # Punto de entrada y coordinación de salud de servicios