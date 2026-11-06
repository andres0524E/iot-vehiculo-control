export class UiManager {
  constructor() {
    this.el_vehicle_name = document.getElementById("vehicle-name");
    this.el_vehicle_meta = document.getElementById("vehicle-meta");

    this.ind_ws = document.getElementById("ind-ws");
    this.ind_ws_icon = document.getElementById("ind-ws-icon");
    this.ind_ws_text = document.getElementById("ind-ws-text");

    this.ind_api = document.getElementById("ind-api");
    this.ind_api_icon = document.getElementById("ind-api-icon");
    this.ind_api_text = document.getElementById("ind-api-text");

    this.ind_rds = document.getElementById("ind-rds");
    this.ind_rds_icon = document.getElementById("ind-rds-icon");
    this.ind_rds_text = document.getElementById("ind-rds-text");

    this.action_badge = document.getElementById("action-phase-badge");
    this.action_text = document.getElementById("action-feedback-text");
    this.ws_last_event = document.getElementById("ws-last-event");

    this.commands_grid = document.getElementById("commands-grid");
    this.catalog_count = document.getElementById("catalog-count");
    this.joy_label = document.getElementById("joystick-direction-label");

    this.select_demo = document.getElementById("select-demo");
    this.btn_start_demo = document.getElementById("btn-start-demo");
    this.btn_cancel_demo = document.getElementById("btn-cancel-demo");
    this.demo_badge = document.getElementById("demo-status-badge");
    this.demo_progress = document.getElementById("demo-progress-text");
  }

  actualizar_datos_vehiculo(vehiculo) {
    if (!vehiculo) return;
    this.el_vehicle_name.textContent = vehiculo.nombre || `vehiculo #${vehiculo.id_vehiculo}`;
    const modelo = vehiculo.modelo || "iot";
    const mcu = vehiculo.microcontrolador || "mcu";
    this.el_vehicle_meta.textContent = `id: ${vehiculo.id_vehiculo} · ${modelo} (${mcu}) · sin telemetria fisica mcu`;
  }

  actualizar_indicador_ws(estado, texto) {
    this._aplicar_estilo_indicador(this.ind_ws, this.ind_ws_icon, this.ind_ws_text, estado, texto, {
      online: "bi-wifi",
      connecting: "bi-arrow-repeat",
      offline: "bi-wifi-off"
    });
  }

  actualizar_indicador_api(estado, texto) {
    this._aplicar_estilo_indicador(this.ind_api, this.ind_api_icon, this.ind_api_text, estado, texto, {
      online: "bi-cloud-check-fill",
      connecting: "bi-cloud-arrow-up",
      offline: "bi-cloud-slash-fill"
    });
  }

  actualizar_indicador_rds(estado, texto) {
    this._aplicar_estilo_indicador(this.ind_rds, this.ind_rds_icon, this.ind_rds_text, estado, texto, {
      online: "bi-database-fill-check",
      neutral: "bi-database-dash",
      offline: "bi-database-fill-exclamation"
    });
  }

  _aplicar_estilo_indicador(card, icon_el, text_el, estado, texto, iconos) {
    card.className = "status-card";
    if (estado === "online") {
      card.classList.add("status-online");
      icon_el.className = `bi ${iconos.online} status-icon`;
    } else if (estado === "connecting") {
      card.classList.add("status-warning");
      icon_el.className = `bi ${iconos.connecting} status-icon`;
    } else if (estado === "neutral") {
      card.classList.add("status-neutral");
      icon_el.className = `bi ${iconos.neutral} status-icon`;
    } else {
      card.classList.add("status-offline");
      icon_el.className = `bi ${iconos.offline} status-icon`;
    }
    text_el.textContent = texto;
  }

  mostrar_estado_accion(fase, mensaje) {
    const mapa_clases = {
      espera: "badge bg-secondary",
      solicitado: "badge bg-warning text-dark",
      aceptado: "badge bg-primary",
      evento: "badge bg-success",
      error: "badge bg-danger"
    };
    this.action_badge.className = mapa_clases[fase] || "badge bg-secondary";
    this.action_badge.textContent = fase.toUpperCase();
    this.action_text.textContent = mensaje;
  }

  mostrar_evento_ws(texto) {
    this.ws_last_event.textContent = texto;
  }

  actualizar_etiqueta_joystick(texto) {
    this.joy_label.textContent = texto;
  }

  renderizar_botones_comandos(comandos, on_click_comando) {
    this.commands_grid.innerHTML = "";
    const activos = comandos.filter((c) => Boolean(c.activo ?? 1));
    this.catalog_count.textContent = `${activos.length} activos`;

    if (activos.length === 0) {
      const vacio = document.createElement("div");
      vacio.className = "col-12 text-center py-3 text-secondary small";
      vacio.textContent = "no hay comandos activos registrados para este vehiculo.";
      this.commands_grid.appendChild(vacio);
      return;
    }

    activos.forEach((cmd) => {
      const col = document.createElement("div");
      col.className = "col-6 col-sm-4";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-outline-light w-100 cmd-btn";
      btn.dataset.idComando = String(cmd.id_comando);
      btn.dataset.nombreComando = String(cmd.nombre || "");

      const span_nombre = document.createElement("span");
      span_nombre.textContent = cmd.nombre;

      const small_cod = document.createElement("small");
      small_cod.className = "text-secondary font-monospace";
      small_cod.style.fontSize = "0.7rem";
      small_cod.textContent = `cód: ${cmd.codigo}`;

      btn.appendChild(span_nombre);
      btn.appendChild(small_cod);

      btn.addEventListener("click", () => on_click_comando(cmd));
      col.appendChild(btn);
      this.commands_grid.appendChild(col);
    });
  }

  marcar_estado_boton_comando(id_comando, estado) {
    const botones = this.commands_grid.querySelectorAll(".cmd-btn");
    botones.forEach((btn) => {
      btn.classList.remove("state-sending", "state-accepted", "state-error", "active");
      if (Number(btn.dataset.idComando) === Number(id_comando)) {
        if (estado === "sending") btn.classList.add("state-sending");
        if (estado === "accepted") btn.classList.add("state-accepted");
        if (estado === "error") btn.classList.add("state-error");
      }
    });
  }

  habilitar_controles_manuales(habilitar) {
    const botones = this.commands_grid.querySelectorAll(".cmd-btn");
    botones.forEach((btn) => {
      btn.disabled = !habilitar;
    });
  }

  renderizar_selector_demos(demos) {
    this.select_demo.innerHTML = "";
    const activas = (demos || []).filter((d) => Boolean(d.activo ?? 1));

    if (activas.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "sin secuencias demo disponibles";
      this.select_demo.appendChild(opt);
      this.btn_start_demo.disabled = true;
      return;
    }

    activas.forEach((demo) => {
      const opt = document.createElement("option");
      opt.value = String(demo.id_demo);
      opt.textContent = `${demo.nombre} (id: ${demo.id_demo})`;
      this.select_demo.appendChild(opt);
    });

    this.btn_start_demo.disabled = false;
  }

  actualizar_estado_demo_ui(en_ejecucion, texto_badge, detalle) {
    this.select_demo.disabled = en_ejecucion;
    this.btn_start_demo.disabled = en_ejecucion || !this.select_demo.value;
    this.btn_cancel_demo.disabled = !en_ejecucion;
    this.habilitar_controles_manuales(!en_ejecucion);

    this.demo_badge.className = en_ejecucion ? "badge bg-info text-dark" : "badge bg-secondary";
    this.demo_badge.textContent = texto_badge;
    if (detalle) {
      this.demo_progress.textContent = detalle;
    }
  }
}