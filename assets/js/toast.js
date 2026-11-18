/**
 * Notificador visual ligero tipo toast compatible con Bootstrap 5 y móviles.
 */
export function mostrar_notificacion(mensaje, tipo = "info", duracion_ms = 3800) {
  const contenedor = document.getElementById("app-toast-container");
  if (!contenedor) {
    console.info(`[${tipo.toUpperCase()}] ${mensaje}`);
    return;
  }

  const iconos = {
    success: "bi-check-circle-fill text-success",
    danger: "bi-shield-exclamation text-danger",
    warning: "bi-exclamation-triangle-fill text-warning",
    info: "bi-info-circle-fill text-info"
  };

  const el = document.createElement("div");
  el.className = `app-toast app-toast-${tipo}`;
  el.setAttribute("role", "status");
  el.innerHTML = `
    <i class="bi ${iconos[tipo] || iconos.info}" aria-hidden="true"></i>
    <span class="app-toast-msg"></span>
    <button type="button" class="btn-close btn-close-white app-toast-close" aria-label="Cerrar"></button>
  `;
  const span = el.querySelector(".app-toast-msg");
  if (span) span.textContent = String(mensaje || "");

  const cerrar = () => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 220);
  };

  el.querySelector(".app-toast-close")?.addEventListener("click", cerrar);
  contenedor.appendChild(el);
  if (duracion_ms > 0) {
    setTimeout(cerrar, duracion_ms);
  }
}

