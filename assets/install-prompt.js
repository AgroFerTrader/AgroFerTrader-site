// Botão de instalação do PWA (Android/Chrome) + instrução manual pro
// iOS/Safari, que nunca dispara o evento beforeinstallprompt (spec do
// PWA, item 4). Só faz algo nas páginas que têm os elementos
// #botao-instalar-app / #aviso-instalar-ios no HTML (home e
// calculadora) e nunca se o site já estiver rodando instalado (modo
// standalone).
(function () {
  "use strict";

  var CHAVE_DISPENSOU_IOS = "agrofer_dispensou_aviso_ios";

  function jaInstalado() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true // iOS Safari, quando instalado
    );
  }

  function ehIOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }

  function ehSafari() {
    var ua = window.navigator.userAgent;
    return /safari/i.test(ua) && !/crios|fxios|edgios|chrome|android/i.test(ua);
  }

  function dispensouAvisoIOS() {
    try {
      return localStorage.getItem(CHAVE_DISPENSOU_IOS) === "1";
    } catch (e) {
      return false;
    }
  }

  if (jaInstalado()) return;

  var botao = document.getElementById("botao-instalar-app");
  var avisoIOS = document.getElementById("aviso-instalar-ios");
  var fecharIOS = document.getElementById("fechar-aviso-instalar-ios");
  var promptAdiado = null;

  window.addEventListener("beforeinstallprompt", function (evento) {
    evento.preventDefault();
    promptAdiado = evento;
    if (botao) botao.hidden = false;
  });

  if (botao) {
    botao.addEventListener("click", function () {
      if (!promptAdiado) return;
      botao.hidden = true;
      promptAdiado.prompt();
      promptAdiado.userChoice.finally(function () {
        promptAdiado = null;
      });
    });
  }

  if (fecharIOS) {
    fecharIOS.addEventListener("click", function () {
      if (avisoIOS) avisoIOS.hidden = true;
      try {
        localStorage.setItem(CHAVE_DISPENSOU_IOS, "1");
      } catch (e) {
        // localStorage indisponível - o aviso só volta a aparecer na
        // próxima visita, sem quebrar nada.
      }
    });
  }

  window.addEventListener("appinstalled", function () {
    if (botao) botao.hidden = true;
    if (avisoIOS) avisoIOS.hidden = true;
    promptAdiado = null;
  });

  if (ehIOS() && ehSafari() && avisoIOS && !dispensouAvisoIOS()) {
    avisoIOS.hidden = false;
  }
})();
