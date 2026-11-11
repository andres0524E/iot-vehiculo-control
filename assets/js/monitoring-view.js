import { formatear_nombre_comando, obtener_info_zona_horaria } from "./format-utils.js";

export class MonitoringView {
  constructor() {
    this.el_badge = document.getElementById("mon-last-source-badge");
    this.el_demo_banner = document.getElementById("mon-demo-banner");
    this.el_demo_banner_text = document.getElementById("mon-demo-banner-text");
    this.el_vehicle = document.getElementById("mon-last-vehicle");
    this.el_command = document.getElementById("mon-last-command");
    this.el_code = document.getElementById("mon-last-code");
    this.el_date = document.getElementById("mon-last-date");
    this.el_time = document.getElementById("mon-last-time");
    this.el_origin = document.getElementById("mon-last-origin");
    this.el_note = document.getElementById("mon-last-note");
    this.el_tz = document.getElementById("mon-tz-info");

    this.el_hist_count = document.getElementById("mon-hist-count");
    this.el_hist_banner = document.getElementById("mon-hist-banner");
    this.el_hist_tbody = document.getElementById("mon-hist-tbody");

    if (this.el_tz) {
      this.el_tz.textContent = `Zona horaria: ${obtener_info_zona_horaria()}`;
    }
  }

  renderizar(snapshot) {
    this._renderizar_ultimo_movimiento(snapshot);
    this._renderizar_historial(snapshot);
  }

  _renderizar_ultimo_movimiento(snap) {
    const { carga_estado, estado_actual, vehiculo, error_estado, demo_activa } = snap;

    if (this.el_demo_banner && this.el_demo_banner_text) {
      const hay_demo = Boolean(demo_activa?.nombre_demo);
      this.el_demo_banner.hidden = !hay_demo;
      this.el_demo_banner.className = "mon-demo-banner";
      if (hay_demo) {
        if (demo_activa.estado === "cancelada") {
          this.el_demo_banner.classList.add("is-cancelled");
          this.el_demo_banner_text.textContent = `Demo cancelada: ${demo_activa.nombre_demo}`;
        } else if (demo_activa.estado === "finalizada") {
          this.el_demo_banner.classList.add("is-finished");
          this.el_demo_banner_text.textContent = `Demo finalizada: ${demo_activa.nombre_demo}`;
        } else if (demo_activa.estado === "error") {
          this.el_demo_banner.classList.add("is-cancelled");
          this.el_demo_banner_text.textContent = `Demo detenida: ${demo_activa.nombre_demo}`;
        } else {
          this.el_demo_banner_text.textContent = `Ejecutando demo: ${demo_activa.nombre_demo}`;
        }
      }
    }

    if (this.el_vehicle) {
      this.el_vehicle.textContent = estado_actual?.vehiculo || vehiculo || "Vehículo #1";
    }

    if (carga_estado === "cargando" && !estado_actual) {
      this._aplicar_badge("badge bg-warning text-dark", "Cargando");
      this.el_command.textContent = "Consultando último estado...";
      this.el_code.hidden = true;
      this.el_date.textContent = "—";
      this.el_time.textContent = "—";
      this.el_origin.textContent = "REST AWS";
      this.el_note.textContent = "Esperando respuesta de Amazon RDS...";
      return;
    }

    if (carga_estado === "sin_movimientos" && !estado_actual) {
      this._aplicar_badge("badge bg-secondary", "Sin movimientos");
      this.el_command.textContent = "Sin movimientos";
      this.el_code.hidden = true;
      this.el_date.textContent = "—";
      this.el_time.textContent = "—";
      this.el_origin.textContent = "Sin registros";
      this.el_note.textContent = "No hay estado previo registrado para este vehículo.";
      return;
    }

    if (carga_estado === "error" && !estado_actual) {
      this._aplicar_badge("badge bg-danger", "Sin datos actualizados");
      this.el_command.textContent = "Sin datos actualizados";
      this.el_code.hidden = true;
      this.el_date.textContent = "—";
      this.el_time.textContent = "—";
      this.el_origin.textContent = "Error de conexión";
      this.el_note.textContent = error_estado || "No se pudo consultar el estado actual en AWS.";
      return;
    }

    if (!estado_actual) return;

    if (estado_actual.es_ultimo_conocido) {
      this._aplicar_badge("badge bg-warning text-dark", "Último conocido");
    } else if (estado_actual.demo_en_curso) {
      this._aplicar_badge("badge bg-success", "DEMO en ejecución");
    } else if (estado_actual.es_demo) {
      this._aplicar_badge("badge bg-info text-dark", "DEMO · No persistido");
    } else if (estado_actual.fuente === "wss") {
      this._aplicar_badge("badge bg-success", "WSS en vivo");
    } else if (estado_actual.fuente === "wss_inicial") {
      this._aplicar_badge("badge bg-primary", "WSS inicial");
    } else {
      this._aplicar_badge("badge bg-primary", "Persistido RDS");
    }

    this.el_command.textContent = estado_actual.es_demo
      ? estado_actual.comando
      : formatear_nombre_comando(estado_actual.comando);

    if (estado_actual.codigo !== null && estado_actual.codigo !== undefined && estado_actual.codigo !== "") {
      this.el_code.hidden = false;
      this.el_code.textContent = `Cód: ${estado_actual.codigo}`;
    } else {
      this.el_code.hidden = true;
      this.el_code.textContent = "";
    }

    const fi = estado_actual.fecha_info;
    this.el_date.textContent = fi?.valido ? fi.fecha : "—";
    this.el_time.textContent = fi?.valido ? fi.hora : "Sin fecha/hora";

    let origen_texto = estado_actual.origen || "Reportado";
    if (estado_actual.conectado !== null && estado_actual.conectado !== undefined && !estado_actual.es_demo) {
      const flag_txt = Number(estado_actual.conectado) === 1 ? "Estado BD: activo" : "Estado BD: inactivo";
      origen_texto = `${origen_texto} · ${flag_txt}`;
    }
    this.el_origin.textContent = origen_texto;

    if (estado_actual.es_ultimo_conocido) {
      this.el_note.textContent = error_estado
        ? `Sin datos actualizados (${error_estado}) · Mostrando último valor conocido`
        : "Sin datos actualizados (reconectando) · Mostrando último valor conocido";
    } else {
      this.el_note.textContent = estado_actual.nota || "Movimiento reportado por el backend AWS.";
    }
  }

  _renderizar_historial(snap) {
    const { historial, carga_historial, error_historial } = snap;
    const total = Array.isArray(historial) ? historial.length : 0;

    if (this.el_hist_count) {
      this.el_hist_count.textContent = `${total} / 10`;
    }

    if (this.el_hist_banner) {
      if (error_historial && total > 0) {
        this.el_hist_banner.hidden = false;
        this.el_hist_banner.className = "mon-banner mon-banner-warn";
        this.el_hist_banner.textContent = `Sin datos actualizados (${error_historial}). Mostrando últimos registros conocidos.`;
      } else if (carga_historial === "cargando" && total > 0) {
        this.el_hist_banner.hidden = false;
        this.el_hist_banner.className = "mon-banner mon-banner-info";
        this.el_hist_banner.textContent = "Sincronizando historial con Amazon RDS...";
      } else {
        this.el_hist_banner.hidden = true;
        this.el_hist_banner.textContent = "";
      }
    }

    if (!this.el_hist_tbody) return;
    this.el_hist_tbody.innerHTML = "";

    if (carga_historial === "cargando" && total === 0) {
      this._agregar_fila_mensaje("Cargando historial desde Amazon RDS...");
      return;
    }

    if (carga_historial === "error" && total === 0) {
      this._agregar_fila_mensaje(`Error al consultar historial: ${error_historial || "Sin conexión con AWS"}`);
      return;
    }

    if (total === 0) {
      this._agregar_fila_mensaje("Sin movimientos individuales registrados en RDS.");
      return;
    }

    historial.forEach((mov, idx) => {
      const tr = document.createElement("tr");
      if (idx === 0) {
        tr.classList.add("mon-row-latest");
      }

      const td_num = document.createElement("td");
      td_num.className = "col-num font-monospace";
      td_num.textContent = String(idx + 1);

      const td_mov = document.createElement("td");
      td_mov.className = "col-mov";

      const span_nom = document.createElement("span");
      span_nom.className = "mon-mov-name";
      span_nom.textContent = formatear_nombre_comando(mov.comando);
      td_mov.appendChild(span_nom);

      if (idx === 0 || mov.id_historial !== null) {
        const meta = document.createElement("small");
        meta.className = "mon-mov-meta";
        const partes = [];
        if (idx === 0) partes.push("Más reciente");
        if (mov.id_historial !== null) partes.push(`ID #${mov.id_historial}`);
        meta.textContent = partes.join(" · ");
        td_mov.appendChild(meta);
      }

      const td_cod = document.createElement("td");
      td_cod.className = "col-cod font-monospace";
      td_cod.textContent = mov.codigo !== null && mov.codigo !== undefined ? String(mov.codigo) : "—";

      const td_fecha = document.createElement("td");
      td_fecha.className = "col-date font-monospace";
      td_fecha.textContent = mov.fecha_info?.valido ? mov.fecha_info.fecha : "—";

      const td_hora = document.createElement("td");
      td_hora.className = "col-time font-monospace";
      td_hora.textContent = mov.fecha_info?.valido ? mov.fecha_info.hora : "—";

      tr.appendChild(td_num);
      tr.appendChild(td_mov);
      tr.appendChild(td_cod);
      tr.appendChild(td_fecha);
      tr.appendChild(td_hora);
      this.el_hist_tbody.appendChild(tr);
    });
  }

  _agregar_fila_mensaje(texto) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "mon-empty-cell";
    td.textContent = texto;
    tr.appendChild(td);
    this.el_hist_tbody.appendChild(tr);
  }

  _aplicar_badge(clase, texto) {
    if (!this.el_badge) return;
    this.el_badge.className = clase;
    this.el_badge.textContent = texto;
  }
}
