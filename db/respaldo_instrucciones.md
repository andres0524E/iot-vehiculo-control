# Procedimiento de Respaldo y Verificación de Amazon RDS
## Base de Datos: `vehiculo_iot` (MySQL 8.x / InnoDB)

Antes de aplicar cualquier migración DDL (`ALTER TABLE`, `CREATE TABLE`) en producción sobre Amazon RDS, es obligatorio generar un respaldo completo verificable.

> [!WARNING]
> En MySQL InnoDB, las operaciones DDL realizan un **COMMIT implícito**. No es posible ejecutar un `ROLLBACK` sobre sentencias `CREATE TABLE` o `ALTER TABLE` si ocurre un error a mitad de ejecución. El respaldo previo es la única garantía de recuperación total.

---

### 1. Comando de Respaldo Completo (`mysqldump`)

Ejecuta el siguiente comando desde una terminal con acceso a la red de AWS RDS:

```bash
mysqldump -h tu-rds-endpoint.rds.amazonaws.com \
  -u admin_iot -p \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  vehiculo_iot > respaldo_vehiculo_iot_pre_administracion_$(date +%Y%m%d_%H%M%S).sql
```

#### Parámetros clave explicados:
- `--single-transaction`: Permite generar una copia consistente en caliente sin bloquear las lecturas/escrituras de la aplicación en vivo ni del microcontrolador ESP8266.
- `--routines`: Exporta intactos los **21 Stored Procedures** existentes (`sp_obtener_vehiculos`, `sp_obtener_historial`, etc.).
- `--triggers` y `--events`: Asegura que cualquier automatización definida en RDS quede respaldada.

---

### 2. Checklist de Verificación de Integridad Antes de la Migración

Ejecuta estas consultas en tu cliente MySQL (DBeaver, MySQL Workbench o consola) y anota los conteos:

```sql
USE vehiculo_iot;

-- 1. Verificar conteo de vehículos existentes (mínimo 1)
SELECT COUNT(*) AS total_vehiculos FROM vehiculos;

-- 2. Verificar catálogo de comandos (debe ser 15 para la excavadora)
SELECT COUNT(*) AS total_comandos FROM comandos WHERE id_vehiculo = 1;

-- 3. Verificar total de registros en historial físico de movimientos
SELECT COUNT(*) AS total_historial FROM historial_comandos;

-- 4. Verificar demos de fábrica existentes (mínimo 3: demo principal, demo 2, Prueba)
SELECT COUNT(*) AS total_demos FROM demos;

-- 5. Verificar total de pasos en demo_movimientos
SELECT COUNT(*) AS total_pasos_demos FROM demo_movimientos;
```

---

### 3. Procedimiento de Restauración de Emergencia (En caso de falla crítica)

Si por alguna razón fuera necesario restaurar la base de datos a su estado original de las prácticas 4.1 y 4.2:

```bash
mysql -h tu-rds-endpoint.rds.amazonaws.com \
  -u admin_iot -p \
  vehiculo_iot < respaldo_vehiculo_iot_pre_administracion_YYYYMMDD_HHMMSS.sql
```

Alternativamente, para revertir únicamente los cambios de estructura sin recrear toda la base de datos, ejecuta el script de reversión:
`db/001_migracion_administracion_down.sql`.

