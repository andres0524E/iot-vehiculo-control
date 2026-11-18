-- =============================================================================
-- MIGRACIÓN DOWN: 001_migracion_administracion_down.sql
-- Módulo: Reversión segura hacia esquema base de Prácticas 4.1 y 4.2
-- Motor: MySQL 8.x / Amazon RDS (InnoDB)
-- NOTA: DDL ejecuta COMMIT implícito en MySQL; asegure respaldo previo.
-- =============================================================================

USE vehiculo_iot;

-- 1. Eliminar tablas hijas dependientes
DROP TABLE IF EXISTS tokens_revocados;
DROP TABLE IF EXISTS soporte_autorizaciones;
DROP TABLE IF EXISTS auditoria_operaciones;
DROP TABLE IF EXISTS sesiones_invitado;
DROP TABLE IF EXISTS asignaciones_vehiculo;
DROP TABLE IF EXISTS modelo_comandos;

-- 2. Revertir columnas añadidas en demos
SET @fk_existe := (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demos' AND CONSTRAINT_NAME = 'fk_demos_usuarios'
);
SET @sql_cmd := IF(@fk_existe > 0, 'ALTER TABLE demos DROP FOREIGN KEY fk_demos_usuarios;', 'SELECT "FK fk_demos_usuarios no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demos' AND COLUMN_NAME = 'id_usuario'
);
SET @sql_cmd := IF(@col_existe > 0, 'ALTER TABLE demos DROP COLUMN id_usuario;', 'SELECT "Columna id_usuario no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demos' AND COLUMN_NAME = 'es_fabrica'
);
SET @sql_cmd := IF(@col_existe > 0, 'ALTER TABLE demos DROP COLUMN es_fabrica;', 'SELECT "Columna es_fabrica no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Revertir columnas añadidas en vehiculos
SET @fk_existe := (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND CONSTRAINT_NAME = 'fk_vehiculos_modelos'
);
SET @sql_cmd := IF(@fk_existe > 0, 'ALTER TABLE vehiculos DROP FOREIGN KEY fk_vehiculos_modelos;', 'SELECT "FK fk_vehiculos_modelos no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'id_modelo'
);
SET @sql_cmd := IF(@col_existe > 0, 'ALTER TABLE vehiculos DROP COLUMN id_modelo;', 'SELECT "Columna id_modelo no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'numero_serie'
);
SET @sql_cmd := IF(@col_existe > 0, 'ALTER TABLE vehiculos DROP COLUMN numero_serie;', 'SELECT "Columna numero_serie no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'estado_inventario'
);
SET @sql_cmd := IF(@col_existe > 0, 'ALTER TABLE vehiculos DROP COLUMN estado_inventario;', 'SELECT "Columna estado_inventario no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_existe := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'fecha_alta'
);
SET @sql_cmd := IF(@col_existe > 0, 'ALTER TABLE vehiculos DROP COLUMN fecha_alta;', 'SELECT "Columna fecha_alta no existe";');
PREPARE stmt FROM @sql_cmd; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Eliminar tablas principales nuevas
DROP TABLE IF EXISTS modelos_vehiculo;
DROP TABLE IF EXISTS usuarios;
DROP TABLE IF EXISTS roles;
