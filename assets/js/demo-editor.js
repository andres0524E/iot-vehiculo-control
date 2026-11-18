import { config } from "./config.js";
import { formatear_nombre_comando } from "./format-utils.js";
import { mostrar_notificacion } from "./toast.js";

/**
 * Editor visual de rutinas Demo personalizadas (Crear y Editar, reordenar pasos y validar duraciones).
 */
export class DemoEditorController {
  constructor(api_client, auth_session, on_demos_actualizadas = null) {
    this.api = api_client;
    this.auth = auth_session;
    this.on_demos_actualizadas = on_demos_actualizadas;

    this.comandos_disponibles = [
      { id_comando: 1, nombre: "avanzar", codigo: 1 },
      { id_comando: 2, nombre: "retroceder", codigo: 2 },
      { id_comando: 3, nombre: "girar_palanca_izquierda", codigo: 3 },
      { id_comando: 4, nombre: "girar_palanca_derecha", codigo: 4 },
      { id_comando: 5, nombre: "bajar_brazo", codigo: 5 },
      { id_comando: 6, nombre: "subir_brazo", codigo: 6 },
      { id_comando: 7, nombre: "girar_derecha", codigo: 7 },
      { id_comando: 8, nombre: "girar_izquierda", codigo: 8 },
      { id_comando: 9, nombre: "detener", codigo: 9 },
      { id_comando: 10, nombre: "sonido", codigo: 10 },
      { id_comando: 11, nombre: "led", codigo: 11 },
      { id_comando: 12, nombre: "demo_software", codigo: 12 }
    ];

    this.pasos = [
      { id_comando: 1, duracion_ms: 1000 },
      { id_comando: 2, duracion_ms: 800 },
      { id_comando: 3, duracion_ms: 800 }
    ];
  }

  configurar_comandos_unidad(catalogo) {
    if (!Array.isArray(catalogo) || catalogo.length === 0) return;
    const filtrados = catalogo
      .filter((cmd) => Boolean(cmd.activo ?? 1))
      .sort((a, b) => Number(a.codigo ?? a.id_comando) - Number(b.codigo ?? b.id_comando));
    if (filtrados.length > 0) {
      this.comandos_disponibles = filtrados;
      this.renderizar_pasos();
    }
  }

  iniciar() {
    document.getElementById("btn-toggle-editor-demo")?.addEventListener("click", () => {
      this.abrir_modal(null);
    });

    document.getElementById("btn-editor-agregar-paso")?.addEventListener("click", () => {
      this._agregar_paso();
    });

    document.getElementById("form-editor-demo")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._guardar_demo();
    });

    this.renderizar_pasos();
  }

  abrir_modal(demo_existente = null) {
    const input_id = document.getElementById("input-demo-editor-id");
    const input_nom = document.getElementById("input-demo-editor-nombre");
    const input_desc = document.getElementById("input-demo-editor-desc");
    const titulo = document.getElementById("modalEditorDemoLabel");

    if (demo_existente) {
      if (input_id) input_id.value = String(demo_existente.id_demo || "");
      if (input_nom) input_nom.value = demo_existente.nombre || "";
      if (input_desc) input_desc.value = demo_existente.descripcion || "";
      if (titulo) titulo.innerHTML = `<i class="bi bi-pencil-square me-1"></i> Editar Demo Privada #${demo_existente.id_demo}`;
      if (Array.isArray(demo_existente.pasos) && demo_existente.pasos.length > 0) {
        this.pasos = demo_existente.pasos.map((p) => ({
          id_comando: Number(p.id_comando),
          duracion_ms: Number(p.duracion_ms) || 800
        }));
      }
    } else {
      if (input_id) input_id.value = "";
      if (input_nom) input_nom.value = "Mi Rutina de Excavación";
      if (input_desc) input_desc.value = "";
      if (titulo) titulo.innerHTML = `<i class="bi bi-pencil-square me-1"></i> Editor Visual de Rutinas Demo`;
      this.pasos = [
        { id_comando: this.comandos_disponibles[0]?.id_comando || 1, duracion_ms: 1000 },
        { id_comando: this.comandos_disponibles[1]?.id_comando || 2, duracion_ms: 800 }
      ];
    }

    this.renderizar_pasos();
    const modal_el = document.getElementById("modal-editor-demo");
    if (modal_el && window.bootstrap?.Modal) {
      bootstrap.Modal.getOrCreateInstance(modal_el).show();
    }
  }

  renderizar_pasos() {
    const lista = document.getElementById("lista-pasos-editor");
    if (!lista) return;

    lista.innerHTML = "";
    this.pasos.forEach((paso, index) => {
      const card = document.createElement("div");
      card.className = "paso-editor-card card bg-black border-secondary p-2 mb-2";

      const opciones = this.comandos_disponibles
        .map(
          (c) =>
            `<option value="${c.id_comando}" ${Number(c.id_comando) === Number(paso.id_comando) ? "selected" : ""}>${formatear_nombre_comando(c.nombre)} (Cód ${c.codigo})</option>`
        )
        .join("");

      card.innerHTML = `
        <div class="d-flex align-items-center justify-content-between gap-2 flex-wrap">
          <div class="d-flex align-items-center gap-2 flex-grow-1">
            <span class="badge bg-warning text-dark font-monospace">#${index + 1}</span>
            <select class="form-select form-select-sm bg-dark text-light border-secondary select-paso-cmd" data-index="${index}">
              ${opciones}
            </select>
          </div>
          <div class="d-flex align-items-center gap-2">
            <div class="input-group input-group-sm" style="width: 132px;">
              <input type="number" class="form-control bg-dark text-light border-secondary font-monospace input-paso-duracion"
                     min="200" max="10000" step="100" value="${paso.duracion_ms}" data-index="${index}" aria-label="Duración ms">
              <span class="input-group-text bg-secondary text-light border-secondary">ms</span>
            </div>
            <div class="btn-group btn-group-sm" role="group">
              <button type="button" class="btn btn-outline-light btn-paso-subir" data-index="${index}" ${index === 0 ? "disabled" : ""} title="Subir paso"><i class="bi bi-chevron-up"></i></button>
              <button type="button" class="btn btn-outline-light btn-paso-bajar" data-index="${index}" ${index === this.pasos.length - 1 ? "disabled" : ""} title="Bajar paso"><i class="bi bi-chevron-down"></i></button>
              <button type="button" class="btn btn-outline-danger btn-paso-eliminar" data-index="${index}" ${this.pasos.length <= 1 ? "disabled" : ""} title="Eliminar paso"><i class="bi bi-trash3"></i></button>
            </div>
          </div>
        </div>
      `;
      lista.appendChild(card);
    });

    this._vincular_eventos_pasos();
    this._actualizar_resumen_tiempo();
  }

  _vincular_eventos_pasos() {
    document.querySelectorAll(".select-paso-cmd").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.index);
        this.pasos[idx].id_comando = Number(e.target.value);
      });
    });

    document.querySelectorAll(".input-paso-duracion").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.index);
        let val = Number(e.target.value) || 800;
        val = Math.max(200, Math.min(10000, val));
        e.target.value = String(val);
        this.pasos[idx].duracion_ms = val;
        this._actualizar_resumen_tiempo();
      });
    });

    document.querySelectorAll(".btn-paso-subir").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = Number(e.currentTarget.dataset.index);
        if (idx > 0) {
          const tmp = this.pasos[idx];
          this.pasos[idx] = this.pasos[idx - 1];
          this.pasos[idx - 1] = tmp;
          this.renderizar_pasos();
        }
      });
    });

    document.querySelectorAll(".btn-paso-bajar").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = Number(e.currentTarget.dataset.index);
        if (idx < this.pasos.length - 1) {
          const tmp = this.pasos[idx];
          this.pasos[idx] = this.pasos[idx + 1];
          this.pasos[idx + 1] = tmp;
          this.renderizar_pasos();
        }
      });
    });

    document.querySelectorAll(".btn-paso-eliminar").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = Number(e.currentTarget.dataset.index);
        if (this.pasos.length > 1) {
          this.pasos.splice(idx, 1);
          this.renderizar_pasos();
        }
      });
    });
  }

  _agregar_paso() {
    if (this.pasos.length >= 30) {
      mostrar_notificacion("El máximo de pasos por rutina es 30.", "warning");
      return;
    }
    const primero = this.comandos_disponibles[0]?.id_comando || 1;
    this.pasos.push({ id_comando: primero, duracion_ms: 800 });
    this.renderizar_pasos();
  }

  _actualizar_resumen_tiempo() {
    const badge = document.getElementById("badge-duracion-total-demo");
    if (!badge) return;
    const total_ms = this.pasos.reduce((acc, p) => acc + (Number(p.duracion_ms) || 0), 0);
    badge.textContent = `${this.pasos.length} pasos · ${(total_ms / 1000).toFixed(1)} s`;
  }

  async _guardar_demo() {
    const id_demo_editar = document.getElementById("input-demo-editor-id")?.value.trim();
    const nombre = document.getElementById("input-demo-editor-nombre")?.value.trim();
    const descripcion = document.getElementById("input-demo-editor-desc")?.value.trim() || "";
    if (!nombre || this.pasos.length === 0) return;

    const id_vehiculo = Number(
      document.getElementById("select-mis-vehiculos")?.value || config.id_vehiculo || 1
    );
    const pasos_payload = this.pasos.map((p, idx) => ({
      orden: idx + 1,
      id_comando: Number(p.id_comando),
      duracion_ms: Math.max(200, Math.min(10000, Number(p.duracion_ms) || 800))
    }));

    if (this.auth?.es_modo_backend_jwt()) {
      try {
        if (id_demo_editar) {
          await this.api.put(config.endpoints.usuario_editar_demo(id_demo_editar), {
            nombre,
            descripcion,
            pasos: pasos_payload
          });
          mostrar_notificacion(`Rutina '${nombre}' actualizada en RDS.`, "success");
        } else {
          await this.api.post(config.endpoints.usuario_crear_demo, {
            id_vehiculo,
            nombre,
            descripcion,
            pasos: pasos_payload
          });
          mostrar_notificacion(`Rutina privada '${nombre}' guardada en RDS.`, "success");
        }

        const modal_el = document.getElementById("modal-editor-demo");
        if (modal_el && window.bootstrap?.Modal) {
          bootstrap.Modal.getInstance(modal_el)?.hide();
        }
        await this.on_demos_actualizadas?.(id_vehiculo);
        return;
      } catch (err) {
        mostrar_notificacion(err.message || "Error guardando la rutina en RDS", "danger");
        return;
      }
    }

    const modal_el = document.getElementById("modal-editor-demo");
    if (modal_el && window.bootstrap?.Modal) {
      bootstrap.Modal.getInstance(modal_el)?.hide();
    }
    await this.on_demos_actualizadas?.(id_vehiculo, {
      id_demo_editar,
      id_vehiculo,
      nombre,
      descripcion,
      pasos: pasos_payload
    });
    mostrar_notificacion(
      id_demo_editar
        ? `Rutina privada '${nombre}' actualizada.`
        : `Rutina privada '${nombre}' guardada en tu cuenta.`,
      "success"
    );
  }
}
