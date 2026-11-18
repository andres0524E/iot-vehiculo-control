-- =============================================================================
-- VERIFICACIÓN PRE Y POST MIGRACIÓN (Amazon RDS MySQL 8.x)
-- Ejecutar antes y después de aplicar 001_migracion_administracion_up.sql
-- =============================================================================

USE vehiculo_iot;

-- 1. Conteos históricos preservados (no deben disminuir tras migrar)
SELECT 'vehiculos' AS tabla, COUNT(*) AS filas FROM vehiculos
UNION ALL
SELECT 'comandos', COUNT(*) FROM comandos
UNION ALL
SELECT 'estado_vehiculo', COUNT(*) FROM estado_vehiculo
UNION ALL
SELECT 'historial_comandos', COUNT(*) FROM historial_comandos
UNION ALL
SELECT 'demos', COUNT(*) FROM demos
UNION ALL
SELECT 'demo_movimientos', COUNT(*) FROM demo_movimientos;

-- 2. Verificar que la unidad histórica #1 conserve su ID y comandos intactos
SELECT *
FROM vehiculos
WHERE id_vehiculo = 1;

-- 3. Conteo de nuevas tablas creadas y sembradas
SELECT 'roles' AS tabla_nueva, COUNT(*) AS filas FROM roles
UNION ALL
SELECT 'usuarios', COUNT(*) FROM usuarios
UNION ALL
SELECT 'modelos_vehiculo', COUNT(*) FROM modelos_vehiculo
UNION ALL
SELECT 'modelo_comandos', COUNT(*) FROM modelo_comandos
UNION ALL
SELECT 'asignaciones_vehiculo', COUNT(*) FROM asignaciones_vehiculo
UNION ALL
SELECT 'soporte_autorizaciones', COUNT(*) FROM soporte_autorizaciones
UNION ALL
SELECT 'sesiones_invitado', COUNT(*) FROM sesiones_invitado
UNION ALL
SELECT 'auditoria_operaciones', COUNT(*) FROM auditoria_operaciones;

-- 4. Verificar compatibilidad de Stored Procedures de 4.1 y 4.2 tras ALTER TABLE
SHOW PROCEDURE STATUS WHERE Db = 'vehiculo_iot';
-- Ejecutar manualmente en entorno de pruebas:
-- CALL sp_obtener_vehiculo(1);
-- CALL sp_obtener_comandos_vehiculo(1);
-- CALL sp_obtener_estado(1);
-- CALL sp_obtener_historial(1);
-- CALL sp_obtener_demos(1);

