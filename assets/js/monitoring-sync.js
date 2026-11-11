import { config } from "./config.js";
import { formatear_fecha_hora, resolver_nombre_evento } from "./format-utils.js";

export class MonitoringSync {
  constructor(api_client, on_state_change, on_rds_status = null) {
    this.api = api_client;
    this.on_state_change = on_state_change;
    this.on_rds_status = on_rds_status;

    this.id_vehiculo = Number(config.id_vehiculo);
    this.nombre_vehiculo = `Vehículo #${this.id_vehiculo}`;
    this.catalogo_demos = [];
    this.demo_activa = null;

    this.estado_actual = null;
    this.historial = [];
    this.carga_estado = "cargando";
    this.carga_historial = "cargando";
    this.error_estado = "";
    this.error_historial = "";
    this.ws_en_linea = false;

    this.seq_estado = 0;
    this.seq_historial = 0;
    this._ultimo_wss_recibido_en = 0;
    this._claves_wss_vistas = [];
    this._debounce_timer = null;
    this._sync_en_curso = false;
    this._sync_pendiente = false;
  }

  establecer_nombre_vehiculo(nombre) {
    if (nombre && String(nombre).trim()) {
      this.nombre_vehiculo = String(nombre).trim();
      if (this.estado_actual && !this.estado_actual.vehiculo) {
        this.estado_actual.vehiculo = this.nombre_vehiculo;
      }
      this._notificar();
    }
  }

  establecer_catalogo_demos(demos) {
    this.catalogo_demos = Array.isArray(demos) ? demos : [];
  }

  registrar_demo_local(estado, nombre_demo) {
    if (!nombre_demo) return;
    this.demo_activa = {
      estado,
      en_ejecucion: estado === "ejecutando",
      nombre_demo: String(nombre_demo).trim(),
      fecha_info: this.demo_activa?.fecha_info || null
    };
    this._notificar();
  }

  actualizar_estado_ws(ws_estado) {
    const previo = this.ws_en_linea;
    this.ws_en_linea = ws_estado === "online";

    if (previo && !this.ws_en_linea && this.estado_actual) {
      this.estado_actual = {
        ...this.estado_actual,
        es_ultimo_conocido: true
      };
      this._notificar();
    } else if (!previo && this.ws_en_linea && this.estado_actual?.es_ultimo_conocido) {
      this.estado_actual = {
        ...this.estado_actual,
        es_ultimo_conocido: false
      };
      this._notificar();
    }
  }

  async sincronizar_todo(_razon = "manual", opciones = {}) {
    const { silencioso = false } = opciones;

    if (this._sync_en_curso) {
      this._sync_pendiente = true;
      return;
    }

    this._sync_en_curso = true;
    const req_started_at = Date.now();
    const seq_e = ++this.seq_estado;
    const seq_h = ++this.seq_historial;

    if (!silencioso && !this.estado_actual) {
      this.carga_estado = "cargando";
    }
    if (!silencioso && this.historial.length === 0) {
      this.carga_historial = "cargando";
    }
    this.error_estado = "";
    this.error_historial = "";
    this._notificar();

    try {
      const [res_estado, res_historial] = await Promise.allSettled([
        this.api.obtener_estado(this.id_vehiculo),
        this.api.obtener_historial(this.id_vehiculo)
      ]);

      let rds_ok = false;
      let rds_db_error = false;

      if (res_estado.status === "fulfilled") {
        rds_ok = true;
        this._aplicar_estado_rest(res_estado.value, seq_e, req_started_at);
      } else {
        const err = res_estado.reason;
        if (err?.status === 404) {
          rds_ok = true;
          this._aplicar_estado_vacio(seq_e);
        } else {
          if (err?.is_db_error || err?.status === 500) rds_db_error = true;
          this._manejar_error_estado(err, seq_e);
        }
      }

      if (res_historial.status === "fulfilled") {
        rds_ok = true;
        this._aplicar_historial_rest(res_historial.value, seq_h);
      } else {
        const err = res_historial.reason;
        if (err?.status === 404) {
          rds_ok = true;
          this._aplicar_historial_rest({ movimientos: [] }, seq_h);
        } else {
          if (err?.is_db_error || err?.status === 500) rds_db_error = true;
          this._manejar_error_historial(err, seq_h);
        }
      }

      if (typeof this.on_rds_status === "function") {
        if (rds_db_error) {
          this.on_rds_status(false, true);
        } else if (rds_ok) {
          this.on_rds_status(true, false);
        } else {
          this.on_rds_status(false, false);
        }
      }
    } finally {
      this._sync_en_curso = false;
      this._notificar();

      if (this._sync_pendiente) {
        this._sync_pendiente = false;
        await this.sincronizar_todo("reconciliacion_pendiente", { silencioso: true });
      }
    }
  }

  async reconciliar_historial() {
    const seq_h = ++this.seq_historial;
    try {
      const data = await this.api.obtener_historial(this.id_vehiculo);
      this._aplicar_historial_rest(data, seq_h);
      if (typeof this.on_rds_status === "function") {
        this.on_rds_status(true, false);
      }
    } catch (err) {
      if (err?.status === 404) {
        this._aplicar_historial_rest({ movimientos: [] }, seq_h);
        if (typeof this.on_rds_status === "function") this.on_rds_status(true, false);
      } else {
        this._manejar_error_historial(err, seq_h);
        if (typeof this.on_rds_status === "function") {
          this.on_rds_status(false, Boolean(err?.is_db_error || err?.status === 500));
        }
      }
    } finally {
      this._notificar();
    }
  }

  procesar_evento_ws(payload) {
    if (!payload || typeof payload !== "object") return;

    if (payload.id_vehiculo !== undefined && payload.id_vehiculo !== null) {
      if (Number(payload.id_vehiculo) !== this.id_vehiculo) {
        return;
      }
    }

    const ev = String(payload.evento || "").toLowerCase().trim();
    if (!ev) return;

    if (ev === "estado_inicial") {
      this._procesar_estado_inicial_ws(payload);
      return;
    }

    if (ev === "movimiento_individual") {
      this._procesar_movimiento_individual_ws(payload);
      return;
    }

    if (ev.startsWith("demo_")) {
      this._procesar_evento_demo_ws(ev, payload);
    }
  }

  _procesar_estado_inicial_ws(payload) {
    const est = payload.estado;
    if (!est || typeof est !== "object") return;
    if (est.vehiculo) this.establecer_nombre_vehiculo(est.vehiculo);
    if (!est.comando) return;

    const fecha_info = formatear_fecha_hora(est.fecha_actualizacion || payload.timestamp);
    if (this._es_mas_antiguo_que_actual(fecha_info.ms)) {
      return;
    }

    this._ultimo_wss_recibido_en = Date.now();
    this.estado_actual = {
      comando: String(est.comando),
      codigo: est.codigo ?? null,
      id_comando: est.id_comando ?? null,
      vehiculo: est.vehiculo || this.nombre_vehiculo,
      origen: est.origen || "Estado inicial WSS",
      conectado: est.conectado ?? null,
      fecha_info,
      fuente: "wss_inicial",
      es_demo: false,
      demo_en_curso: false,
      es_ultimo_conocido: false,
      nota: "Estado inicial reportado por backend al conectar WSS"
    };
    this.carga_estado = "listo";
    this.error_estado = "";
    this._notificar();
  }

  _procesar_movimiento_individual_ws(payload) {
    const datos = payload.datos && typeof payload.datos === "object" ? payload.datos : {};
    const comando = resolver_nombre_evento(payload);
    if (!comando) {
      this._programar_reconciliacion();
      return;
    }

    const marca_raw = datos.fecha_hora || datos.fecha_actualizacion || payload.timestamp || null;
    const clave_dedup = datos.id_historial
      ? `hist:${datos.id_historial}`
      : `mov:${this.id_vehiculo}:${datos.codigo ?? ""}:${comando}:${marca_raw ?? ""}`;

    if (this._ya_visto_wss(clave_dedup)) {
      return;
    }
    this._registrar_clave_wss(clave_dedup);

    const fecha_info = formatear_fecha_hora(marca_raw);
    if (this._es_mas_antiguo_que_actual(fecha_info.ms)) {
      this._programar_reconciliacion();
      return;
    }

    this.demo_activa = null;
    this._ultimo_wss_recibido_en = Date.now();
    this.estado_actual = {
      comando: String(comando),
      codigo: datos.codigo ?? null,
      id_comando: datos.id_comando ?? null,
      id_historial: datos.id_historial ?? null,
      vehiculo: datos.vehiculo || this.nombre_vehiculo,
      origen: datos.origen || "Evento en vivo WSS",
      conectado: datos.conectado ?? null,
      fecha_info,
      fuente: "wss",
      es_demo: false,
      demo_en_curso: false,
      es_ultimo_conocido: false,
      nota: "Reportado por WSS en tiempo real · reconciliando RDS"
    };
    this.carga_estado = "listo";
    this.error_estado = "";
    this._notificar();

    this._programar_reconciliacion();
  }

  _resolver_nombre_demo(datos, payload) {
    const directo = datos.nombre_demo || datos.nombre || payload?.nombre_demo || payload?.nombre || "";
    if (String(directo).trim()) return String(directo).trim();

    const id_demo = datos.id_demo ?? payload?.id_demo;
    if (id_demo !== undefined && id_demo !== null) {
      const encontrada = this.catalogo_demos.find((d) => Number(d.id_demo) === Number(id_demo));
      if (encontrada?.nombre) return String(encontrada.nombre).trim();
    }

    if (this.demo_activa?.nombre_demo) return this.demo_activa.nombre_demo;
    return "Secuencia demo";
  }

  _procesar_evento_demo_ws(ev, payload) {
    const datos_raw = payload.datos && typeof payload.datos === "object" ? payload.datos : {};
    const datos = { ...payload, ...datos_raw };
    const marca_raw = payload.timestamp || null;
    const clave_dedup = `demo:${ev}:${datos.orden ?? datos.paso ?? ""}:${datos.nombre_demo ?? ""}:${marca_raw ?? ""}`;

    if (this._ya_visto_wss(clave_dedup)) {
      return;
    }
    this._registrar_clave_wss(clave_dedup);

    const fecha_info = formatear_fecha_hora(marca_raw);
    const nombre_demo = this._resolver_nombre_demo(datos, payload);
    let titulo_mov = `Demo: ${nombre_demo}`;
    let origen_detalle = "Secuencia demo en ejecución";
    let en_ejecucion = false;
    let estado_demo = "ejecutando";

    if (ev === "demo_inicio" || ev === "demo_movimiento" || ev === "demo_pausa") {
      en_ejecucion = true;
      estado_demo = "ejecutando";
      titulo_mov = `Demo: ${nombre_demo}`;
      origen_detalle = "Secuencia demo en ejecución";
    } else if (ev === "demo_fin") {
      estado_demo = "finalizada";
      titulo_mov = `Demo finalizada: ${nombre_demo}`;
      origen_detalle = "Secuencia demo completada";
    } else if (ev === "demo_cancelada") {
      estado_demo = "cancelada";
      titulo_mov = `Demo cancelada: ${nombre_demo}`;
      origen_detalle = "Secuencia demo detenida";
    } else if (ev === "demo_error") {
      estado_demo = "error";
      titulo_mov = `Demo detenida: ${nombre_demo}`;
      origen_detalle = datos.detalle || "Error controlado en secuencia demo";
    }

    this.demo_activa = {
      estado: estado_demo,
      en_ejecucion,
      nombre_demo,
      fecha_info
    };

    this._ultimo_wss_recibido_en = Date.now();
    this.estado_actual = {
      comando: titulo_mov,
      codigo: null,
      id_comando: null,
      vehiculo: this.nombre_vehiculo,
      origen: origen_detalle,
      conectado: null,
      fecha_info,
      fuente: "wss_demo",
      es_demo: true,
      demo_en_curso: en_ejecucion,
      es_ultimo_conocido: false,
      nota: "Secuencia DEMO por WSS (el historial inferior conserva solo los 10 movimientos individuales de RDS)"
    };
    this.carga_estado = "listo";
    this.error_estado = "";
    this._notificar();

    if (!en_ejecucion) {
      this._programar_reconciliacion(true);
    }
  }

  _programar_reconciliacion(solo_historial = false) {
    if (this._debounce_timer) {
      clearTimeout(this._debounce_timer);
    }
    const espera = config.historial_resync_debounce_ms || 300;
    this._debounce_timer = setTimeout(() => {
      this._debounce_timer = null;
      if (solo_historial) {
        this.reconciliar_historial();
      } else {
        this.sincronizar_todo("evento_wss", { silencioso: true });
      }
    }, espera);
  }

  _aplicar_estado_rest(data, seq, req_started_at) {
    if (seq !== this.seq_estado) return;

    if (data?.vehiculo) {
      this.establecer_nombre_vehiculo(data.vehiculo);
    }

    if (!data || !data.comando) {
      this._aplicar_estado_vacio(seq);
      return;
    }

    if (this.demo_activa?.en_ejecucion) {
      return;
    }

    const fecha_info = formatear_fecha_hora(data.fecha_actualizacion);

    // protege respuestas rest viejas o del mismo segundo frente a actualizaciones wss/demo recientes
    const llego_wss_en_vuelo = this._ultimo_wss_recibido_en > req_started_at;
    if (this.estado_actual && this.estado_actual.fuente?.startsWith("wss")) {
      const actual_ms = this.estado_actual.fecha_info?.ms || 0;
      const actual_segundo_ms = Math.floor(actual_ms / 1000) * 1000;

      if (llego_wss_en_vuelo && fecha_info.ms <= actual_ms) {
        return;
      }
      if (fecha_info.valido && actual_ms > 0 && fecha_info.ms < actual_segundo_ms) {
        return;
      }
      if (this.estado_actual.es_demo && (!fecha_info.valido || fecha_info.ms <= actual_segundo_ms)) {
        return;
      }
    }

    this.estado_actual = {
      comando: String(data.comando),
      codigo: data.codigo ?? null,
      id_comando: data.id_comando ?? null,
      vehiculo: data.vehiculo || this.nombre_vehiculo,
      origen: "Consultado desde RDS",
      conectado: data.conectado ?? null,
      fecha_info,
      fuente: "rest",
      es_demo: false,
      demo_en_curso: false,
      es_ultimo_conocido: false,
      nota: "Último estado persistido en Amazon RDS (sin telemetría física MCU)"
    };
    this.carga_estado = "listo";
    this.error_estado = "";
  }

  _aplicar_estado_vacio(seq) {
    if (seq !== this.seq_estado) return;
    if (!this.estado_actual) {
      this.carga_estado = "sin_movimientos";
      this.error_estado = "";
    }
  }

  _manejar_error_estado(err, seq) {
    if (seq !== this.seq_estado) return;
    this.error_estado = err?.message || "No se pudo consultar el estado en AWS";
    if (this.estado_actual) {
      this.estado_actual = {
        ...this.estado_actual,
        es_ultimo_conocido: true
      };
      this.carga_estado = "listo";
    } else {
      this.carga_estado = "error";
    }
  }

  _aplicar_historial_rest(data, seq) {
    if (seq !== this.seq_historial) return;

    const lista_raw = Array.isArray(data?.movimientos)
      ? data.movimientos
      : (Array.isArray(data) ? data : []);

    const mapa_dedup = new Map();
    lista_raw.forEach((item) => {
      if (!item || typeof item !== "object") return;
      if (item.id_vehiculo !== undefined && Number(item.id_vehiculo) !== this.id_vehiculo) return;

      const fecha_info = formatear_fecha_hora(item.fecha_hora || item.fecha_ejecucion || item.fecha);
      const id_hist = item.id_historial !== undefined && item.id_historial !== null
        ? Number(item.id_historial)
        : null;
      const clave = id_hist !== null
        ? `id:${id_hist}`
        : `row:${item.comando ?? ""}:${item.codigo ?? ""}:${fecha_info.iso_origen}`;

      if (!mapa_dedup.has(clave)) {
        mapa_dedup.set(clave, {
          id_historial: id_hist,
          comando: String(item.comando || "Desconocido"),
          codigo: item.codigo ?? null,
          origen: item.origen || "",
          fecha_info
        });
      }
    });

    const ordenados = Array.from(mapa_dedup.values()).sort((a, b) => {
      const diff_ms = (b.fecha_info?.ms || 0) - (a.fecha_info?.ms || 0);
      if (diff_ms !== 0) return diff_ms;
      return (b.id_historial || 0) - (a.id_historial || 0);
    });

    this.historial = ordenados.slice(0, config.max_historial_rows || 10);
    this.carga_historial = this.historial.length > 0 ? "listo" : "vacio";
    this.error_historial = "";
  }

  _manejar_error_historial(err, seq) {
    if (seq !== this.seq_historial) return;
    this.error_historial = err?.message || "No se pudo consultar el historial en AWS";
    if (this.historial.length === 0) {
      this.carga_historial = "error";
    }
  }

  _es_mas_antiguo_que_actual(nuevo_ms) {
    if (!this.estado_actual || !nuevo_ms) return false;
    const actual_ms = this.estado_actual.fecha_info?.ms || 0;
    if (!actual_ms) return false;
    return nuevo_ms < actual_ms;
  }

  _ya_visto_wss(clave) {
    return this._claves_wss_vistas.includes(clave);
  }

  _registrar_clave_wss(clave) {
    this._claves_wss_vistas.push(clave);
    if (this._claves_wss_vistas.length > 50) {
      this._claves_wss_vistas.shift();
    }
  }

  _notificar() {
    if (typeof this.on_state_change === "function") {
      this.on_state_change({
        vehiculo: this.nombre_vehiculo,
        demo_activa: this.demo_activa,
        estado_actual: this.estado_actual,
        historial: this.historial,
        carga_estado: this.carga_estado,
        carga_historial: this.carga_historial,
        error_estado: this.error_estado,
        error_historial: this.error_historial,
        ws_en_linea: this.ws_en_linea
      });
    }
  }
}
