// Mostra o aviso "Dados offline" nas páginas de cotação (home e páginas
// de commodity) quando o service worker precisou servir a página do
// cache por falta de rede - ver sw.js (networkFirst/marcarComoOffline).
// Só faz alguma coisa se a página tiver o marcador
// window.__AGROFER_OFFLINE_EM__ (injetado pelo próprio service worker)
// e o elemento #aviso-offline no HTML.
(function () {
  if (!window.__AGROFER_OFFLINE_EM__) return;

  var aviso = document.getElementById("aviso-offline");
  var texto = document.getElementById("aviso-offline-texto");
  if (!aviso || !texto) return;

  var quando = "";
  try {
    quando = new Date(window.__AGROFER_OFFLINE_EM__).toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch (erro) {
    quando = "";
  }

  texto.textContent = "Dados offline — última atualização em " + (quando || "data desconhecida") + ".";
  aviso.hidden = false;
})();
