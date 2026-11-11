import { resolver_nombre_evento } from "./format-utils.js";

export class DemoController {
  constructor(api_client, ui_manager, command_controller) {
    this.api = api_client;
    this.ui = ui_manager;
    this.cmd_controller = command_controller;
    this.en_ejecucion = false;
    this.nombre_demo_activa = "";
  }

  async iniciar_demo_seleccionada(id_demo) {
    if (!id_demo || this.en_ejecucion) return;

    const opcion = this.ui.select_demo?.selectedOptions?.[0]?.textContent || "Secuencia";
    this.nombre_demo_activa = opcion;

    this._establecer_estado(true, "Iniciando...", "", `Demo activa: ${opcion}`);
    this.ui.actualizar_puntito_actividad("sending", "Iniciando demo");

    try {
      const resp = await this.api.iniciar_demo(id_demo);
      const nom = resp.nombre_demo || opcion;
      this.nombre_demo_activa = nom;
      this.ui.mostrar_estado_accion("aceptado", `Iniciando secuencia: ${nom}`);
      this._establecer_estado(true, "En ejecución", "", `Demo activa: ${nom}`);
      this.ui.actualizar_puntito_actividad("active", `Demo: ${nom}`);
    } catch (_error) {
      this.nombre_demo_activa = "";
      this._establecer_estado(false, "Error", "No se pudo iniciar la secuencia.");
      this.ui.mostrar_estado_accion("error", "No se pudo iniciar la secuencia");
      this.ui.actualizar_puntito_actividad("error", "Error en demo", 1800);
    }
  }

  async cancelar_demo_activa() {
    if (!this.en_ejecucion) return;
    try {
      await this.api.cancelar_demo();
      this.ui.mostrar_estado_accion("solicitado", "Deteniendo secuencia...");
    } catch (_error) {
      this.ui.mostrar_estado_accion("error", "No se pudo cancelar la secuencia");
      this._establecer_estado(false, "Inactiva", "");
      this.ui.actualizar_puntito_actividad("idle", "En espera");
    }
  }

  procesar_evento_ws_demo(evento, payload_o_datos, catalogo = []) {
    const datos = payload_o_datos && typeof payload_o_datos === "object" ? payload_o_datos : {};

    if (evento === "demo_inicio") {
      const nom = datos.nombre_demo || datos.nombre || this.nombre_demo_activa || "Secuencia";
      this.nombre_demo_activa = nom;
      this._establecer_estado(true, "En ejecución", "", `Demo activa: ${nom}`);
      this.ui.actualizar_puntito_actividad("active", `Demo: ${nom}`);
    } else if (evento === "demo_movimiento") {
      const nom = datos.nombre_demo || this.nombre_demo_activa || "Secuencia";
      const cmd_nombre = resolver_nombre_evento(payload_o_datos, catalogo);
      const cod = datos.codigo ?? datos.id_comando ?? null;

      this._establecer_estado(true, "En ejecución", "", `Demo activa: ${nom}`);
      if (cmd_nombre || cod !== null) {
        this.ui.reflejar_comando_visual(
          { codigo: cod, nombre: cmd_nombre },
          { alternar_toggles: true }
        );
      }
      this.ui.actualizar_puntito_actividad("active", `Demo activa: ${nom}`);
    } else if (evento === "demo_pausa") {
      const nom = datos.nombre_demo || this.nombre_demo_activa || "Secuencia";
      this._establecer_estado(true, "En ejecución", "", `Demo activa: ${nom}`);
      this.ui.actualizar_puntito_actividad("active", `Demo activa: ${nom}`);
    } else if (evento === "demo_fin") {
      const nom = datos.nombre_demo || this.nombre_demo_activa || "Secuencia";
      this.nombre_demo_activa = "";
      this._establecer_estado(false, "Completada", "");
      this.ui.mostrar_estado_accion("evento", `Secuencia "${nom}" finalizada`);
      this.ui.actualizar_puntito_actividad("idle", "En espera");
    } else if (evento === "demo_cancelada") {
      const nom = datos.nombre_demo || this.nombre_demo_activa || "Secuencia";
      this.nombre_demo_activa = "";
      this._establecer_estado(false, "Cancelada", "");
      this.ui.mostrar_estado_accion("evento", `Secuencia "${nom}" cancelada`);
      this.ui.actualizar_puntito_actividad("idle", "En espera");
    } else if (evento === "demo_error") {
      this.nombre_demo_activa = "";
      this._establecer_estado(false, "Detenida", "La secuencia se detuvo por un inconveniente.");
      this.ui.actualizar_puntito_actividad("error", "Error en demo", 1800);
    }
  }

  _establecer_estado(activa, badge, detalle, nombre_banner = "") {
    this.en_ejecucion = activa;
    this.cmd_controller.demo_activa = activa;
    this.ui.actualizar_estado_demo_ui(activa, badge, detalle, nombre_banner);
  }
}
