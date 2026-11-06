export class DemoController {
  constructor(api_client, ui_manager, command_controller) {
    this.api = api_client;
    this.ui = ui_manager;
    this.cmd_controller = command_controller;
    this.en_ejecucion = false;
  }

  async iniciar_demo_seleccionada(id_demo) {
    if (!id_demo || this.en_ejecucion) return;

    this._establecer_estado(true, "iniciando...", "solicitando ejecucion de secuencia demo al servidor aws...");
    try {
      const resp = await this.api.iniciar_demo(id_demo);
      this.ui.mostrar_estado_accion(
        "aceptado",
        `demo iniciada en backend: ${resp.nombre_demo || "secuencia"} (${resp.total_movimientos || 0} pasos)`
      );
      this._establecer_estado(
        true,
        "en ejecución",
        `ejecutando "${resp.nombre_demo}" (${resp.total_movimientos} movimientos coordinados por aws)`
      );
    } catch (error) {
      this._establecer_estado(false, "error", `no se pudo iniciar la demo: ${error.message}`);
      this.ui.mostrar_estado_accion("error", `error al iniciar demo: ${error.message}`);
    }
  }

  async cancelar_demo_activa() {
    if (!this.en_ejecucion) return;
    try {
      const resp = await this.api.cancelar_demo();
      this.ui.mostrar_estado_accion("solicitado", resp.mensaje || "cancelacion de demo enviada");
    } catch (error) {
      this.ui.mostrar_estado_accion("error", `error al cancelar demo: ${error.message}`);
      this._establecer_estado(false, "inactiva", "secuencia detenida localmente.");
    }
  }

  procesar_evento_ws_demo(evento, datos) {
    if (evento === "demo_inicio") {
      this._establecer_estado(
        true,
        "en ejecución",
        `wss demo_inicio: "${datos.nombre_demo}" · total pasos: ${datos.total_movimientos}`
      );
    } else if (evento === "demo_movimiento") {
      this._establecer_estado(
        true,
        `paso #${datos.orden}`,
        `wss demo_movimiento: [#${datos.orden}] ${datos.comando} (cód ${datos.codigo}) · dur: ${datos.duracion_ms}ms · pausa: ${datos.pausa_ms}ms`
      );
    } else if (evento === "demo_fin") {
      this._establecer_estado(
        false,
        "completada",
        `wss demo_fin: secuencia "${datos.nombre_demo}" finalizada correctamente.`
      );
      this.ui.mostrar_estado_accion("evento", `demo "${datos.nombre_demo}" completada por websocket`);
    } else if (evento === "demo_cancelada") {
      this._establecer_estado(
        false,
        "cancelada",
        `wss demo_cancelada: detencion segura ejecutada (${datos.accion_segura || "DETENER"}).`
      );
      this.ui.mostrar_estado_accion("evento", "demo cancelada con accion segura DETENER confirmada por wss");
    } else if (evento === "demo_error") {
      this._establecer_estado(
        false,
        "error demo",
        `wss demo_error: ${datos.detalle || "falla controlada"} (${datos.accion_segura || "DETENER"})`
      );
    }
  }

  _establecer_estado(activa, badge, detalle) {
    this.en_ejecucion = activa;
    this.cmd_controller.demo_activa = activa;
    this.ui.actualizar_estado_demo_ui(activa, badge, detalle);
  }
}