// Aviso de nova versão do PWA disponível (spec, item 5) - observa o
// registro do service worker (passado por quem chamou
// navigator.serviceWorker.register, no <script> inline de cada
// página) e mostra o aviso #aviso-nova-versao sempre que uma versão
// nova terminar de instalar e ficar esperando pra assumir. Nunca troca
// de versão sozinho - só ativa quando o usuário toca no aviso, pra não
// atualizar o app debaixo dele no meio do uso (ver também o handler de
// "message" em sw.js, que escuta esse toque).
window.AgroFerUpdateBanner = (function () {
  "use strict";

  function mostrarAviso(registration) {
    var aviso = document.getElementById("aviso-nova-versao");
    if (!aviso || aviso.dataset.ligado) return;
    aviso.dataset.ligado = "1";
    aviso.hidden = false;

    function ativarNovaVersao() {
      aviso.hidden = true;
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    }

    aviso.addEventListener("click", ativarNovaVersao);
    aviso.addEventListener("keydown", function (evento) {
      if (evento.key === "Enter" || evento.key === " ") {
        evento.preventDefault();
        ativarNovaVersao();
      }
    });
  }

  function observar(registration) {
    if (!registration) return;

    // Service worker novo que já ficou pronto e esperando antes desta
    // página nem ter carregado (ex.: atualização saiu enquanto o
    // usuário tinha outra aba do site aberta).
    if (registration.waiting && navigator.serviceWorker.controller) {
      mostrarAviso(registration);
    }

    registration.addEventListener("updatefound", function () {
      var novoWorker = registration.installing;
      if (!novoWorker) return;
      novoWorker.addEventListener("statechange", function () {
        if (novoWorker.state === "installed" && navigator.serviceWorker.controller) {
          mostrarAviso(registration);
        }
      });
    });
  }

  var recarregando = false;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (recarregando) return;
      recarregando = true;
      window.location.reload();
    });
  }

  return { observar: observar };
})();
