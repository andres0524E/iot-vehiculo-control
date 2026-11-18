-- =============================================================================
-- MIGRACIÓN UP: 001_migracion_administracion_up.sql
-- Módulo: Ampliación a Tercera Aplicación (Administración, Capacidades, Soporte y RBAC)
-- Motor: MySQL 8.x / Amazon RDS (InnoDB)
-- NOTA: Las sentencias DDL generan COMMIT implícito en MySQL; aplicar respaldo previo.
-- =============================================================================

USE vehiculo_iot;

-- -----------------------------------------------------------------------------
-- 1. TABLA: roles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id_rol INT AUTO_INCREMENT PRIMARY KEY,
    clave VARCHAR(32) NOT NULL UNIQUE,
    nombre VARCHAR(64) NOT NULL,
    descripcion VARCHAR(255) NULL,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 2. TABLA: usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id_usuario INT AUTO_INCREMENT PRIMARY KEY,
    id_rol INT NOT NULL,
    email VARCHAR(128) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    nombre_completo VARCHAR(128) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_usuarios_roles FOREIGN KEY (id_rol) REFERENCES roles (id_rol)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 3. TABLA: modelos_vehiculo (Catálogo comercial independiente de unidades físicas)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS modelos_vehiculo (
    id_modelo INT AUTO_INCREMENT PRIMARY KEY,
    nombre_comercial VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT NULL,
    tipo_microcontrolador VARCHAR(64) NOT NULL DEFAULT 'ESP8266',
    imagen_url VARCHAR(255) NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 4. TABLA: modelo_comandos (Capacidades y comandos permitidos por modelo comercial)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS modelo_comandos (
    id_modelo_comando INT AUTO_INCREMENT PRIMARY KEY,
    id_modelo INT NOT NULL,
    nombre VARCHAR(64) NOT NULL,
    codigo INT NOT NULL,
    descripcion VARCHAR(255) NULL,
    permitido_invitado TINYINT(1) NOT NULL DEFAULT 0,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_modelo_codigo (id_modelo, codigo),
    CONSTRAINT fk_modcmd_modelo FOREIGN KEY (id_modelo) REFERENCES modelos_vehiculo (id_modelo)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 5. ALTER NO DESTRUCTIVO EN: vehiculos
-- -----------------------------------------------------------------------------
SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'id_modelo'
);
SET @sql_cmd := IF(@col_existe = 0,
    'ALTER TABLE vehiculos ADD COLUMN id_modelo INT NULL AFTER id_vehiculo, ADD CONSTRAINT fk_vehiculos_modelos FOREIGN KEY (id_modelo) REFERENCES modelos_vehiculo (id_modelo) ON UPDATE CASCADE ON DELETE SET NULL;',
    'SELECT "Columna id_modelo ya existe en vehiculos";'
);
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'numero_serie'
);
SET @sql_cmd := IF(@col_existe = 0,
    'ALTER TABLE vehiculos ADD COLUMN numero_serie VARCHAR(64) NULL UNIQUE AFTER id_modelo;',
    'SELECT "Columna numero_serie ya existe en vehiculos";'
);
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'estado_inventario'
);
SET @sql_cmd := IF(@col_existe = 0,
    'ALTER TABLE vehiculos ADD COLUMN estado_inventario ENUM("disponible", "vendido", "exhibicion", "mantenimiento", "inactivo") NOT NULL DEFAULT "exhibicion";',
    'SELECT "Columna estado_inventario ya existe en vehiculos";'
);
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'fecha_alta'
);
SET @sql_cmd := IF(@col_existe = 0,
    'ALTER TABLE vehiculos ADD COLUMN fecha_alta DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER estado_inventario;',
    'SELECT "Columna fecha_alta ya existe en vehiculos";'
);
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -----------------------------------------------------------------------------
-- 6. TABLA: asignaciones_vehiculo (Propiedad y vinculación con compradores)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asignaciones_vehiculo (
    id_asignacion INT AUTO_INCREMENT PRIMARY KEY,
    id_vehiculo INT NOT NULL,
    id_usuario INT NOT NULL,
    estado ENUM('activo', 'transferido', 'revocado') NOT NULL DEFAULT 'activo',
    fecha_asignacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_baja DATETIME NULL,
    notas VARCHAR(255) NULL,
    INDEX idx_asig_vehiculo (id_vehiculo),
    INDEX idx_asig_usuario (id_usuario),
    CONSTRAINT fk_asig_vehiculos FOREIGN KEY (id_vehiculo) REFERENCES vehiculos (id_vehiculo)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_asig_usuarios FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 7. TABLA: soporte_autorizaciones (Consentimiento explícito del comprador para Admin)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soporte_autorizaciones (
    id_soporte INT AUTO_INCREMENT PRIMARY KEY,
    id_vehiculo INT NOT NULL,
    id_usuario_dueno INT NOT NULL,
    motivo VARCHAR(255) NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    fecha_inicio DATETIME NOT NULL,
    fecha_expiracion DATETIME NOT NULL,
    INDEX idx_soporte_vehiculo (id_vehiculo, activo, fecha_expiracion),
    CONSTRAINT fk_soporte_vehiculo FOREIGN KEY (id_vehiculo) REFERENCES vehiculos (id_vehiculo)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_soporte_usuario FOREIGN KEY (id_usuario_dueno) REFERENCES usuarios (id_usuario)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 8. ALTER NO DESTRUCTIVO EN: demos (Fábrica vs Privadas de Comprador)
-- -----------------------------------------------------------------------------
SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demos' AND COLUMN_NAME = 'es_fabrica'
);
SET @sql_cmd := IF(@col_existe = 0,
    'ALTER TABLE demos ADD COLUMN es_fabrica TINYINT(1) NOT NULL DEFAULT 1;',
    'SELECT "Columna es_fabrica ya existe en demos";'
);
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demos' AND COLUMN_NAME = 'id_usuario'
);
SET @sql_cmd := IF(@col_existe = 0,
    'ALTER TABLE demos ADD COLUMN id_usuario INT NULL AFTER es_fabrica, ADD CONSTRAINT fk_demos_usuarios FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario) ON UPDATE CASCADE ON DELETE SET NULL;',
    'SELECT "Columna id_usuario ya existe en demos";'
);
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -----------------------------------------------------------------------------
-- 9. TABLA: sesiones_invitado (Reserva exclusiva temporal con tiempos UTC)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sesiones_invitado (
    id_sesion INT AUTO_INCREMENT PRIMARY KEY,
    id_vehiculo INT NOT NULL,
    token_sesion VARCHAR(128) NOT NULL UNIQUE,
    alias_cliente VARCHAR(64) NOT NULL,
    fecha_inicio DATETIME NOT NULL,
    fecha_expiracion DATETIME NOT NULL,
    activa TINYINT(1) NOT NULL DEFAULT 1,
    ip_origen VARCHAR(45) NULL,
    INDEX idx_sesion_vehiculo (id_vehiculo),
    INDEX idx_sesion_activa (activa, fecha_expiracion),
    CONSTRAINT fk_sesion_vehiculos FOREIGN KEY (id_vehiculo) REFERENCES vehiculos (id_vehiculo)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 10. TABLA: auditoria_operaciones (Bitácora de acciones administrativas y seguridad)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auditoria_operaciones (
    id_auditoria INT AUTO_INCREMENT PRIMARY KEY,
    id_usuario INT NULL,
    accion VARCHAR(64) NOT NULL,
    entidad_afectada VARCHAR(64) NOT NULL,
    id_entidad INT NULL,
    detalles_json JSON NULL,
    ip_origen VARCHAR(45) NULL,
    fecha_hora DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_fecha (fecha_hora),
    INDEX idx_audit_usuario (id_usuario),
    CONSTRAINT fk_audit_usuarios FOREIGN KEY (id_usuario) REFERENCES usuarios (id_usuario)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 11. TABLA: tokens_revocados (Invalidación persistente de sesiones al hacer logout)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens_revocados (
    jti VARCHAR(64) PRIMARY KEY,
    id_usuario INT NULL,
    fecha_revocacion DATETIME NOT NULL,
    fecha_expiracion DATETIME NULL,
    INDEX idx_token_exp (fecha_expiracion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 12. DATOS SEMILLA (Idempotentes; hashes PBKDF2-SHA256 verificados)
-- -----------------------------------------------------------------------------
INSERT IGNORE INTO roles (id_rol, clave, nombre, descripcion) VALUES
(1, 'admin', 'Administrador', 'Control total de modelos, inventario, clientes y auditoría'),
(2, 'usuario', 'Usuario Comprador', 'Acceso exclusivo a unidades propias y demos privadas'),
(3, 'invitado', 'Cliente Potencial / Invitado', 'Consulta catálogo y prueba temporal en unidad de exhibición');

-- Contraseñas demo reales verificadas:
-- admin@iot.empresa.com     -> Admin123!*
-- comprador@cliente.com     -> Comprador123!*
-- invitado@demo.com         -> Invitado123!*
-- s.rivas@constructora.mx   -> CompradorB123!*
INSERT IGNORE INTO usuarios (id_usuario, id_rol, email, password_hash, nombre_completo, activo) VALUES
(1, 1, 'admin@iot.empresa.com', 'pbkdf2_sha256$310000$048d3f18d6e34a6f06b0545f59c59901$b78214522b53e59b1aedb12bcc56e2e8f4c17abd7700a5a5f778e53c4603af2d', 'Administrador General de Flota', 1),
(2, 2, 'comprador@cliente.com', 'pbkdf2_sha256$310000$a9c7b48d0d8c92d83fe773bbb7d91bc6$bf7c038ab9132910513c3dde4dcb2841423e8e49df5390aab1ae6bc5db916014', 'Ing. Carlos Mendoza (Comprador)', 1),
(3, 3, 'invitado@demo.com', 'pbkdf2_sha256$310000$0dd3b3f330938765c5635e6d5afa152f$bba9123f74f5481122e257161645d30fb06214890ef88b4a0a894f99d4740a4b', 'Visitante Demo (Invitado)', 1),
(4, 2, 's.rivas@constructora.mx', 'pbkdf2_sha256$310000$168f7e94f18b657fab3fddcb03347afd$f5ddd898c18a6925fa4725be807046b9cf8ce476089fde0e9e53fcc1ebc51466', 'Dra. Sofía Rivas (Constructora)', 1);

INSERT IGNORE INTO modelos_vehiculo (id_modelo, nombre_comercial, descripcion, tipo_microcontrolador, imagen_url, activo) VALUES
(1, 'Excavator 3000', 'Vehículo industrial a escala con orugas, brazo articulado, bocina y LED frontal.', 'ESP8266', './assets/img/excavadora.svg', 1),
(2, 'Rover Explorador X1', 'Vehículo de exploración 4x4 para terreno irregular y telemetría ultrasónica.', 'ESP32', './assets/img/rover.svg', 1);

-- Capacidades base por modelo (15 comandos para Excavadora Pro; subconjunto 4x4 para Rover X1)
INSERT IGNORE INTO modelo_comandos (id_modelo, nombre, codigo, descripcion, permitido_invitado, activo) VALUES
(1, 'avanzar', 1, 'Tracción adelante', 1, 1),
(1, 'retroceder', 2, 'Tracción reversa', 1, 1),
(1, 'girar_palanca_izquierda', 3, 'Giro palanca izquierda', 1, 1),
(1, 'girar_palanca_derecha', 4, 'Giro palanca derecha', 1, 1),
(1, 'bajar_brazo', 5, 'Descenso hidráulico de brazo', 0, 1),
(1, 'subir_brazo', 6, 'Elevación de brazo', 0, 1),
(1, 'girar_derecha', 7, 'Giro chasis derecha', 0, 1),
(1, 'girar_izquierda', 8, 'Giro chasis izquierda', 0, 1),
(1, 'detener', 9, 'Parada prioritaria de seguridad', 1, 1),
(1, 'sonido', 10, 'Bocina de advertencia', 1, 1),
(1, 'led', 11, 'Iluminación LED frontal', 1, 1),
(1, 'demo_software', 12, 'Secuencia interna MCU', 0, 1),
(1, 'giro 90 izq', 13, 'Giro cronometrado 90 grados izq', 0, 1),
(1, 'giro 90 der', 14, 'Giro cronometrado 90 grados der', 0, 1),
(1, 'vuelta 360', 15, 'Rotación completa 360 grados', 0, 1),
(2, 'avanzar', 1, 'Avance diferencial 4x4', 1, 1),
(2, 'retroceder', 2, 'Reversa diferencial 4x4', 1, 1),
(2, 'girar_izquierda', 8, 'Giro izquierda sobre eje', 1, 1),
(2, 'girar_derecha', 7, 'Giro derecha sobre eje', 1, 1),
(2, 'detener', 9, 'Freno electromagnético prioritario', 1, 1),
(2, 'sonido', 10, 'Buzzer acústico', 1, 1),
(2, 'led', 11, 'Faro explorador LED', 1, 1);

-- Preservar unidad física histórica #1 y etiquetarla como exhibición del modelo #1 (Excavator 3000)
UPDATE vehiculos
SET nombre = 'Excavator 3000',
    id_modelo = 1,
    numero_serie = COALESCE(numero_serie, 'SN-EXCAV-001'),
    estado_inventario = 'exhibicion'
WHERE id_vehiculo = 1;

-- Etiquetar demos históricas como demos oficiales de fábrica
UPDATE demos
SET es_fabrica = 1,
    id_usuario = NULL
WHERE id_vehiculo = 1;

INSERT INTO auditoria_operaciones (id_usuario, accion, entidad_afectada, id_entidad, detalles_json, ip_origen)
VALUES (1, 'MIGRACION_INICIAL_ADMIN', 'SISTEMA', 1, '{"version": "001", "descripcion": "Esquema Administracion, Capacidades, Soporte, RBAC y Sesiones Invitado"}', '127.0.0.1');
