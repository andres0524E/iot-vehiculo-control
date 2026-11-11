export class NavigationController {
  constructor(on_view_change = null) {
    this.on_view_change = on_view_change;
    this.vista_actual = "control";
    this.tabs = Array.from(document.querySelectorAll("[data-view-target]"));
    this.paneles_control = Array.from(document.querySelectorAll(".view-control"));
    this.paneles_monitoreo = Array.from(document.querySelectorAll(".view-monitoreo"));

    this._vincular_eventos();
  }

  iniciar() {
    const inicial = this._leer_vista_desde_hash();
    this.cambiar_vista(inicial, { actualizar_hash: false, notificar: true });
  }

  obtener_vista_actual() {
    return this.vista_actual;
  }

  _leer_vista_desde_hash() {
    const hash = String(window.location.hash || "").toLowerCase();
    if (hash === "#monitoreo") return "monitoreo";
    return "control";
  }

  _vincular_eventos() {
    this.tabs.forEach((tab, idx) => {
      tab.addEventListener("click", () => {
        const destino = tab.dataset.viewTarget;
        this.cambiar_vista(destino);
      });

      tab.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const siguiente = this.tabs[(idx + dir + this.tabs.length) % this.tabs.length];
          siguiente.focus();
          this.cambiar_vista(siguiente.dataset.viewTarget);
        }
      });
    });

    window.addEventListener("hashchange", () => {
      const vista_hash = this._leer_vista_desde_hash();
      if (vista_hash !== this.vista_actual) {
        this.cambiar_vista(vista_hash, { actualizar_hash: false, notificar: true });
      }
    });
  }

  cambiar_vista(vista, opciones = {}) {
    const { actualizar_hash = true, notificar = true } = opciones;
    const destino = vista === "monitoreo" ? "monitoreo" : "control";
    const cambio = destino !== this.vista_actual;

    this.vista_actual = destino;
    document.body.dataset.view = destino;

    this.tabs.forEach((tab) => {
      const activo = tab.dataset.viewTarget === destino;
      tab.classList.toggle("active", activo);
      if (activo) {
        tab.setAttribute("aria-current", "page");
      } else {
        tab.removeAttribute("aria-current");
      }
    });

    this.paneles_control.forEach((el) => {
      el.hidden = destino !== "control";
    });
    this.paneles_monitoreo.forEach((el) => {
      el.hidden = destino !== "monitoreo";
    });

    if (actualizar_hash) {
      const nuevo_hash = `#${destino}`;
      if (window.location.hash !== nuevo_hash) {
        history.replaceState(null, "", nuevo_hash);
      }
    }

    if (notificar && typeof this.on_view_change === "function") {
      this.on_view_change(destino, cambio);
    }
  }
}
