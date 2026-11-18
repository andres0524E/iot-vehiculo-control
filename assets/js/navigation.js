import { mostrar_notificacion } from "./toast.js";

export class NavigationController {
  constructor(on_view_change = null, auth_session = null) {
    this.on_view_change = on_view_change;
    this.auth = auth_session;
    this.vista_actual = "control";
    this.tabs = Array.from(document.querySelectorAll("[data-view-target]"));
    this.paneles_control = Array.from(document.querySelectorAll(".view-control"));
    this.paneles_monitoreo = Array.from(document.querySelectorAll(".view-monitoreo"));
    this.paneles_administracion = Array.from(document.querySelectorAll(".view-administracion"));

    this._vincular_eventos();
  }

  iniciar() {
    this._actualizar_visibilidad_tabs();
    const inicial = this._leer_vista_desde_hash();
    this.cambiar_vista(inicial, { actualizar_hash: false, notificar: true });
  }

  obtener_vista_actual() {
    return this.vista_actual;
  }

  _leer_vista_desde_hash() {
    const hash = String(window.location.hash || "").toLowerCase();
    if (hash === "#monitoreo") return "monitoreo";
    if (hash === "#administracion" || hash === "#admin") return "administracion";
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

    window.addEventListener("iot:auth-change", () => {
      this._actualizar_visibilidad_tabs();
      // Si el usuario pasó a Invitado y estaba en Administración, forzar salida por 403
      if (this.auth && this.auth.obtener_rol() === "invitado" && this.vista_actual === "administracion") {
        this.cambiar_vista("control");
      }
    });
  }

  _actualizar_visibilidad_tabs() {
    const rol = this.auth ? this.auth.obtener_rol() : "invitado";
    const tab_admin = document.querySelector('[data-view-target="administracion"]');
    const tab_short = document.getElementById("tab-admin-label-short");
    const tab_full = document.getElementById("tab-admin-label-full");
    const tab_icon = tab_admin?.querySelector("i");

    if (tab_admin) {
      if (rol === "invitado") {
        tab_admin.classList.add("disabled");
        tab_admin.style.opacity = "0.4";
        tab_admin.title = "403 Forbidden: Se requiere rol Administrador";
        if (tab_short) tab_short.textContent = "Admin";
        if (tab_full) tab_full.textContent = "Administración";
        if (tab_icon) tab_icon.className = "bi bi-shield-lock";
      } else if (rol === "usuario") {
        tab_admin.classList.remove("disabled");
        tab_admin.style.opacity = "1";
        tab_admin.title = "Mis vehículos adquiridos y demos privadas";
        if (tab_short) tab_short.textContent = "Vehículos";
        if (tab_full) tab_full.textContent = "Mis Vehículos";
        if (tab_icon) tab_icon.className = "bi bi-truck";
      } else {
        tab_admin.classList.remove("disabled");
        tab_admin.style.opacity = "1";
        tab_admin.title = "Administración total de modelos, flota y clientes";
        if (tab_short) tab_short.textContent = "Admin";
        if (tab_full) tab_full.textContent = "Administración";
        if (tab_icon) tab_icon.className = "bi bi-shield-lock";
      }
    }
  }

  cambiar_vista(vista, opciones = {}) {
    const { actualizar_hash = true, notificar = true } = opciones;

    // Validación RBAC: Invitado no puede acceder a administración
    const rol = this.auth ? this.auth.obtener_rol() : "invitado";
    if (vista === "administracion" && rol === "invitado") {
      mostrar_notificacion(
        "HTTP 403 Prohibido: Invitado no puede acceder a Administración. Inicia sesión como Administrador o Comprador.",
        "danger"
      );
      vista = "control";
    }

    let destino = "control";
    if (vista === "monitoreo") destino = "monitoreo";
    else if (vista === "administracion") destino = "administracion";

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
      if (el.id === "seccion-mis-vehiculos" || el.id === "seccion-catalogo-invitado") return;
      el.hidden = destino !== "control";
    });
    this.paneles_monitoreo.forEach((el) => {
      el.hidden = destino !== "monitoreo";
    });
    this.paneles_administracion.forEach((el) => {
      el.hidden = destino !== "administracion";
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
