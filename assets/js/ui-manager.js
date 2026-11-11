import { formatear_nombre_comando } from "./format-utils.js";

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

    this.el_tx_dot = document.getElementById("ctrl-tx-dot");
    this.el_led = document.getElementById("ctrl-led");
    this.el_speaker = document.getElementById("ctrl-speaker");
    this.el_speaker_icon = document.getElementById("ctrl-speaker-icon");
    this._tx_timer = null;

    // el vehiculo fisico inicia con led y sonido encendidos
    this.led_encendido = true;
    this.sonido_encendido = true;
    this.ws_en_linea = false;

    this.panel_ctl = document.getElementById("panel-control-ctl");
    this.panel_cat = document.getElementById("panel-control-cat");
    this.panel_demo = document.getElementById("panel-control-demo");
    this.demo_live_banner = document.getElementById("demo-live-banner");
    this.demo_live_text = document.getElementById("demo-live-text");

    this.commands_grid = document.getElementById("commands-grid");
    this.catalog_count = document.getElementById("catalog-count");
    this.joy_label = document.getElementById("joystick-direction-label");

    this.select_demo = document.getElementById("select-demo");
    this.btn_start_demo = document.getElementById("btn-start-demo");
    this.btn_cancel_demo = document.getElementById("btn-cancel-demo");
    this.demo_badge = document.getElementById("demo-status-badge");
    this.demo_progress = document.getElementById("demo-progress-text");

    this.establecer_led(true);
    this.establecer_bocina(true);
    this.actualizar_puntito_actividad("idle", "En espera");
  }

  actualizar_datos_vehiculo(vehiculo) {
    if (!vehiculo) return;
    this.el_vehicle_name.textContent = vehiculo.nombre || "Vehículo";
    this.el_vehicle_meta.textContent = "Control remoto en tiempo real";
  }

  actualizar_indicador_ws(estado, texto) {
    this.ws_en_linea = estado === "online";
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

  establecer_led(encendido) {
    this.led_encendido = Boolean(encendido);
    if (!this.el_led) return;
    this.el_led.dataset.state = this.led_encendido ? "on" : "off";
    const texto = this.led_encendido ? "LED: Encendido" : "LED: Apagado";
    this.el_led.title = texto;
    this.el_led.setAttribute("aria-label", texto);
  }

  alternar_led() {
    this.establecer_led(!this.led_encendido);
  }

  establecer_bocina(encendido) {
    this.sonido_encendido = Boolean(encendido);
    if (!this.el_speaker || !this.el_speaker_icon) return;
    this.el_speaker.dataset.state = this.sonido_encendido ? "sounding" : "off";
    this.el_speaker_icon.className = this.sonido_encendido ? "bi bi-volume-up-fill" : "bi bi-volume-mute-fill";
    const texto = this.sonido_encendido ? "Sonido: Encendido" : "Sonido: Apagado";
    this.el_speaker.title = texto;
    this.el_speaker.setAttribute("aria-label", texto);
  }

  alternar_bocina() {
    this.establecer_bocina(!this.sonido_encendido);
  }

  actualizar_puntito_actividad(estado, texto = "En espera", duracion_ms = 0) {
    if (!this.el_tx_dot) return;
    if (this._tx_timer) {
      clearTimeout(this._tx_timer);
      this._tx_timer = null;
    }
    this.el_tx_dot.dataset.state = estado;
    this.el_tx_dot.title = `Actividad: ${texto}`;
    this.el_tx_dot.setAttribute("aria-label", `Actividad de movimiento: ${texto}`);

    if (duracion_ms > 0) {
      this._tx_timer = setTimeout(() => {
        this._tx_timer = null;
        this.actualizar_puntito_actividad("idle", "En espera");
      }, duracion_ms);
    }
  }

  reflejar_comando_visual(cmd, opciones = {}) {
    if (!cmd) return;
    const { alternar_toggles = true } = opciones;
    const cod = Number(cmd.codigo);
    const nom = String(cmd.nombre || cmd.comando || "").toLowerCase();

    if (cod === 11 || nom.includes("led") || nom.includes("luz")) {
      if (alternar_toggles) this.alternar_led();
      this.actualizar_puntito_actividad("active", "LED alternado", 800);
      return;
    }

    if (cod === 10 || nom.includes("sonido") || nom.includes("claxon") || nom.includes("bocina")) {
      if (alternar_toggles) this.alternar_bocina();
      this.actualizar_puntito_actividad("active", "Sonido alternado", 800);
      return;
    }

    if (cod === 9 || cod === 0 || nom.includes("detener") || nom.includes("stop") || nom.includes("parar")) {
      this.actualizar_puntito_actividad("idle", "Detenido");
      return;
    }

    if (cod === 13 || cod === 14 || nom.includes("90")) {
      this.actualizar_puntito_actividad("active", "Giro 90°", 1700);
      return;
    }

    if (cod === 15 || nom.includes("360") || nom.includes("vuelta")) {
      this.actualizar_puntito_actividad("active", "Vuelta 360°", 6000);
      return;
    }

    this.actualizar_puntito_actividad("active", "En movimiento");
  }

  mostrar_estado_accion(fase, mensaje) {
    const mapa_clases = {
      espera: "badge bg-secondary",
      solicitado: "badge bg-warning text-dark",
      aceptado: "badge bg-primary",
      evento: "badge bg-success",
      error: "badge bg-danger"
    };
    const mapa_etiquetas = {
      espera: "LISTO",
      solicitado: "ENVIANDO",
      aceptado: "ENVIADO",
      evento: "ACTIVO",
      error: "ERROR"
    };
    this.action_badge.className = mapa_clases[fase] || "badge bg-secondary";
    this.action_badge.textContent = mapa_etiquetas[fase] || fase.toUpperCase();
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
      vacio.textContent = "No hay movimientos disponibles.";
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
      span_nombre.textContent = formatear_nombre_comando(cmd.nombre);

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
      opt.textContent = "Sin secuencias disponibles";
      this.select_demo.appendChild(opt);
      this.btn_start_demo.disabled = true;
      return;
    }

    activas.forEach((demo) => {
      const opt = document.createElement("option");
      opt.value = String(demo.id_demo);
      opt.textContent = String(demo.nombre || "Secuencia");
      this.select_demo.appendChild(opt);
    });

    this.btn_start_demo.disabled = false;
  }

  actualizar_estado_demo_ui(en_ejecucion, texto_badge, detalle, nombre_banner = "") {
    this.select_demo.disabled = en_ejecucion;
    this.btn_start_demo.disabled = en_ejecucion || !this.select_demo.value;
    this.btn_cancel_demo.disabled = !en_ejecucion;
    this.habilitar_controles_manuales(!en_ejecucion);

    if (this.panel_demo) {
      this.panel_demo.classList.toggle("demo-running", en_ejecucion);
    }
    if (this.panel_ctl) {
      this.panel_ctl.classList.toggle("is-demo-locked", en_ejecucion);
    }
    if (this.panel_cat) {
      this.panel_cat.classList.toggle("is-demo-locked", en_ejecucion);
    }
    if (this.demo_live_banner && this.demo_live_text) {
      this.demo_live_banner.hidden = !en_ejecucion;
      if (en_ejecucion) {
        this.demo_live_text.textContent = nombre_banner || "Demo activa";
      }
    }

    this.demo_badge.className = en_ejecucion ? "badge bg-success" : "badge bg-secondary";
    this.demo_badge.textContent = texto_badge;
    this.demo_progress.classList.toggle("is-active", Boolean(detalle));
    if (detalle !== undefined) {
      this.demo_progress.textContent = detalle;
    }
  }
}
