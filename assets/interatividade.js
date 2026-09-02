/*
 * AgroFer Trader - interatividade do site
 * =========================================
 * Script unico, compartilhado por todas as paginas (home + commodities),
 * carregado uma vez no fim do <body>. Cada funcao verifica se os
 * elementos que precisa existem antes de agir - paginas que nao tem
 * determinado recurso simplesmente nao disparam aquele bloco (nada
 * quebra por falta de elemento).
 *
 * Sem dependencia externa nenhuma (sem biblioteca de grafico, sem CDN) -
 * so DOM/SVG nativos do navegador.
 */
(function () {
  "use strict";

  var SEM_MOVIMENTO = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // -------------------------------------------------------------------
  // Utilitarios de numero/data compartilhados
  // -------------------------------------------------------------------

  function paraNumero(texto) {
    if (texto === null || texto === undefined) return null;
    var limpo = String(texto).replace(/[^\d.,-]/g, "");
    if (limpo.indexOf(",") !== -1) {
      limpo = limpo.replace(/\./g, "").replace(",", ".");
    }
    var n = parseFloat(limpo);
    return isNaN(n) ? null : n;
  }

  function formatarBRL(numero) {
    return numero.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // -------------------------------------------------------------------
  // 1) Numeros animados: cartoes de preco "contam" do zero ate o valor
  //    real ao entrar na tela (nao ao carregar a pagina inteira - so
  //    quando o cartao realmente aparece na viewport).
  // -------------------------------------------------------------------

  function animarValor(elemento) {
    var textoOriginal = elemento.textContent;
    var valorFinal = paraNumero(textoOriginal);
    if (valorFinal === null) return;

    var prefixo = /^\s*R\$/.test(textoOriginal) ? "R$ " : "";
    var duracao = 700;
    var inicio = null;

    function passo(agora) {
      if (inicio === null) inicio = agora;
      var progresso = Math.min((agora - inicio) / duracao, 1);
      var facilitado = 1 - Math.pow(1 - progresso, 3);
      elemento.textContent = prefixo + formatarBRL(valorFinal * facilitado);
      if (progresso < 1) {
        window.requestAnimationFrame(passo);
      } else {
        elemento.textContent = textoOriginal; // garante o texto exato original no final
      }
    }
    window.requestAnimationFrame(passo);
  }

  function iniciarNumerosAnimados() {
    var alvos = document.querySelectorAll(".price-value");
    if (!alvos.length) return;

    if (SEM_MOVIMENTO || !("IntersectionObserver" in window)) {
      return; // deixa os valores como o servidor ja mandou, sem animar
    }

    var observador = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (entrada.isIntersecting) {
            animarValor(entrada.target);
            observador.unobserve(entrada.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    alvos.forEach(function (el) {
      observador.observe(el);
    });
  }

  // -------------------------------------------------------------------
  // 2) Revelacao suave ao rolar: secoes aparecem com leve fade/subida
  //    na primeira vez que entram na tela.
  // -------------------------------------------------------------------

  function iniciarRevelacaoAoRolar() {
    if (SEM_MOVIMENTO || !("IntersectionObserver" in window)) return;

    var alvos = document.querySelectorAll("main > section, .analise-secao");
    if (!alvos.length) return;

    var observador = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (entrada.isIntersecting) {
            entrada.target.classList.add("revelado");
            observador.unobserve(entrada.target);
          }
        });
      },
      { threshold: 0.1 }
    );
    alvos.forEach(function (el) {
      el.classList.add("a-revelar");
      observador.observe(el);
    });
  }

  // -------------------------------------------------------------------
  // 3) Seletor de periodo do grafico (7 / 30 / 90 dias): so troca qual
  //    bloco pre-renderizado fica visivel - cada periodo ja vem
  //    completo do servidor, sem calculo nenhum no navegador.
  // -------------------------------------------------------------------

  function iniciarSeletorPeriodo() {
    document.querySelectorAll(".chart-periodos").forEach(function (nav) {
      var painel = nav.nextElementSibling;
      if (!painel) return;

      nav.addEventListener("click", function (evento) {
        var botao = evento.target.closest(".periodo-btn");
        if (!botao) return;
        var periodo = botao.getAttribute("data-periodo");

        nav.querySelectorAll(".periodo-btn").forEach(function (b) {
          var ativo = b === botao;
          b.classList.toggle("active", ativo);
          b.setAttribute("aria-selected", ativo ? "true" : "false");
        });
        painel.querySelectorAll("[data-periodo]").forEach(function (bloco) {
          bloco.hidden = bloco.getAttribute("data-periodo") !== periodo;
        });

        // Se houver uma comparacao ativa, redesenha pro novo periodo.
        var compararSelect = document.getElementById("comparar-select");
        if (compararSelect && compararSelect.value) {
          desenharComparacao(compararSelect.value);
        }
      });
    });
  }

  // -------------------------------------------------------------------
  // 4) Comparativo entre commodities: sobrepoe, no periodo em exibicao,
  //    a variacao percentual (nao o preco absoluto - escalas muito
  //    diferentes entre soja ~R$150 e cafe ~R$1800) da commodity atual
  //    e de outra escolhida, usando os mesmos dados historicos ja
  //    embutidos na pagina (nenhuma requisicao nova).
  // -------------------------------------------------------------------

  function _caminhoSuaveJS(pontosXY) {
    var n = pontosXY.length;
    if (n < 2) return "";
    if (n === 2) {
      return (
        "M " + pontosXY[0][0].toFixed(1) + "," + pontosXY[0][1].toFixed(1) +
        " L " + pontosXY[1][0].toFixed(1) + "," + pontosXY[1][1].toFixed(1)
      );
    }
    function p(i) {
      return pontosXY[Math.max(0, Math.min(n - 1, i))];
    }
    var partes = ["M " + pontosXY[0][0].toFixed(1) + "," + pontosXY[0][1].toFixed(1)];
    for (var i = 0; i < n - 1; i++) {
      var p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
      var c1x = p1[0] + (p2[0] - p0[0]) / 6;
      var c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6;
      var c2y = p2[1] - (p3[1] - p1[1]) / 6;
      partes.push(
        "C " + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " +
        c2x.toFixed(1) + "," + c2y.toFixed(1) + " " +
        p2[0].toFixed(1) + "," + p2[1].toFixed(1)
      );
    }
    return partes.join(" ");
  }

  function _variacaoPercentual(serie) {
    if (!serie.length) return [];
    var base = serie[0][1];
    if (!base) return serie.map(function () { return 0; });
    return serie.map(function (ponto) {
      return ((ponto[1] - base) / base) * 100;
    });
  }

  function obterDadosHistorico() {
    var script = document.getElementById("dados-historico-commodities");
    if (!script) return null;
    try {
      // O conteudo vem entre marcadores HTML tipo
      // "<!-- DADOS_HISTORICO_JSON:START -->...<!-- ...:END -->" (mesmo
      // padrao usado em todo o site pra trocar conteudo dinamico) -
      // dentro de uma <script> essas marcas NAO sao removidas pelo
      // navegador (script e "raw text", nao passa pelo parser de HTML
      // de verdade), entao precisam ser retiradas aqui antes do parse.
      var texto = script.textContent.replace(/<!--[\s\S]*?-->/g, "").trim();
      var dados = JSON.parse(texto);
      return dados.fisicos ? dados : { fisicos: dados, futuros: {} };
    } catch (e) {
      return null;
    }
  }

  function painelAtivo() {
    var serieAtiva = document.querySelector(".chart-series-panel:not([hidden])") || document;
    var painelVisivel = serieAtiva.querySelector(".chart-painel [data-periodo]:not([hidden])");
    return painelVisivel;
  }

  function desenharComparacao(slugComparar) {
    var dados = obterDadosHistorico();
    var bloco = painelAtivo();
    if (!dados || !bloco) return;

    // Limpa qualquer sobreposicao anterior (de um periodo ja escondido,
    // por exemplo) antes de desenhar a nova - so o painel ativo deve
    // ter a comparacao visivel.
    document.querySelectorAll(".chart-wrap.chart-comparando").forEach(function (wrap) {
      var svgAntigo = wrap.querySelector("svg");
      if (svgAntigo) limparComparacao(svgAntigo);
      wrap.classList.remove("chart-comparando");
    });

    var chartWrap = bloco.querySelector(".chart-wrap");
    if (!chartWrap) return;

    var slugBase = chartWrap.getAttribute("data-slug");
    var margemEsq = parseFloat(chartWrap.getAttribute("data-margem-esq"));
    var margemTopo = parseFloat(chartWrap.getAttribute("data-margem-topo"));
    var alturaUtil = parseFloat(chartWrap.getAttribute("data-altura-util"));
    var larguraUtil = parseFloat(chartWrap.getAttribute("data-largura-util"));
    var numPontos = parseInt(chartWrap.getAttribute("data-num-pontos"), 10);

    var svg = chartWrap.querySelector("svg");
    if (!svg || isNaN(margemEsq) || !numPontos) return;

    var tipoSerie = document.querySelector(".chart-serie-select")?.value || "fisicos";
    var serieBaseCompleta = dados[tipoSerie][slugBase];
    var serieCompCompleta = dados[tipoSerie][slugComparar];
    if (!serieBaseCompleta || !serieCompCompleta) return;

    // Mesma janela de dias usada no periodo em exibicao, alinhada pelas
    // ULTIMAS N datas de cada serie (os snapshots diarios sao gerados
    // juntos, entao as datas ja vem alinhadas por indice).
    var serieBase = serieBaseCompleta.slice(-numPontos);
    var serieComp = serieCompCompleta.slice(-numPontos);
    var n = Math.min(serieBase.length, serieComp.length);
    if (n < 2) return;
    serieBase = serieBase.slice(-n);
    serieComp = serieComp.slice(-n);

    var varBase = _variacaoPercentual(serieBase);
    var varComp = _variacaoPercentual(serieComp);
    var todasVariacoes = varBase.concat(varComp);
    var minimo = Math.min.apply(null, todasVariacoes);
    var maximo = Math.max.apply(null, todasVariacoes);
    if (minimo === maximo) { minimo -= 1; maximo += 1; }
    var faixa = maximo - minimo;
    var passoX = larguraUtil / (n - 1);

    function pontosDe(variacoes) {
      return variacoes.map(function (v, i) {
        var x = margemEsq + i * passoX;
        var y = margemTopo + alturaUtil - ((v - minimo) / faixa) * alturaUtil;
        return [x, y];
      });
    }

    var nsSvg = "http://www.w3.org/2000/svg";
    limparComparacao(svg);

    var grupo = document.createElementNS(nsSvg, "g");
    grupo.setAttribute("class", "chart-comparacao");

    var pathBase = document.createElementNS(nsSvg, "path");
    pathBase.setAttribute("d", _caminhoSuaveJS(pontosDe(varBase)));
    pathBase.setAttribute("fill", "none");
    pathBase.setAttribute("stroke", "#B08830");
    pathBase.setAttribute("stroke-width", "2");
    pathBase.setAttribute("stroke-dasharray", "1,0");
    grupo.appendChild(pathBase);

    var pathComp = document.createElementNS(nsSvg, "path");
    pathComp.setAttribute("d", _caminhoSuaveJS(pontosDe(varComp)));
    pathComp.setAttribute("fill", "none");
    pathComp.setAttribute("stroke", "#0B3C1F");
    pathComp.setAttribute("stroke-width", "2");
    pathComp.setAttribute("stroke-dasharray", "6,4");
    grupo.appendChild(pathComp);

    svg.appendChild(grupo);
    chartWrap.classList.add("chart-comparando");

    var legenda = document.querySelector(".chart-comparacao-legenda");
    if (legenda) legenda.classList.add("visivel");
  }

  function renderizarModoGrafico(modo) {
    var serieAtiva = document.querySelector(".chart-series-panel:not([hidden])") || document;
    serieAtiva.querySelectorAll(".chart-painel [data-periodo]:not([hidden]) .chart-wrap").forEach(function (wrap) {
      var svg = wrap.querySelector("svg");
      if (!svg) return;
      svg.classList.toggle("modo-barras", modo === "barras");
      var pontos = wrap.querySelectorAll(".chart-hit");
      wrap.querySelectorAll(".chart-bar").forEach(function (bar) { bar.remove(); });
      if (modo !== "barras") return;
      var largura = 900, altura = 260, margemEsq = parseFloat(wrap.dataset.margemEsq);
      var margemTopo = parseFloat(wrap.dataset.margemTopo), alturaUtil = parseFloat(wrap.dataset.alturaUtil);
      var larguraUtil = parseFloat(wrap.dataset.larguraUtil), n = pontos.length;
      if (!n) return;
      var valores = Array.prototype.map.call(pontos, function (p) { return parseFloat(p.dataset.preco.replace('.', '').replace(',', '.')); });
      var minimo = Math.min.apply(null, valores), maximo = Math.max.apply(null, valores);
      if (minimo === maximo) { minimo -= 1; maximo += 1; }
      var passo = larguraUtil / Math.max(1, n - 1), base = margemTopo + alturaUtil;
      valores.forEach(function (valor, i) {
        var bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        var alturaBarra = ((valor - minimo) / (maximo - minimo)) * alturaUtil;
        bar.setAttribute("class", "chart-bar"); bar.setAttribute("x", margemEsq + i * passo - Math.max(2, passo * .32));
        bar.setAttribute("y", base - alturaBarra); bar.setAttribute("width", Math.max(4, passo * .64));
        bar.setAttribute("height", alturaBarra); bar.setAttribute("fill", "#4C7A1F"); bar.setAttribute("opacity", ".7");
        svg.insertBefore(bar, svg.querySelector(".chart-hit"));
      });
    });
  }

  function iniciarFerramentasGrafico() {
    var estiloImpressao = document.createElement("style");
    estiloImpressao.textContent = "@media print{body.imprimir-grafico>*{display:none!important}body.imprimir-grafico main{display:block!important}body.imprimir-grafico main>section{display:none!important}body.imprimir-grafico main>section.grafico-para-impressao{display:block!important;padding:20px 0}body.imprimir-grafico .chart-ferramentas{display:none!important}}";
    document.head.appendChild(estiloImpressao);
    document.querySelectorAll(".chart-ferramentas").forEach(function (ferramentas) {
      if (ferramentas.querySelector("#comparar-select")) return;
      var dados = obterDadosHistorico();
      var atual = (document.querySelector(".chart-wrap") || {}).dataset?.slug;
      var select = document.createElement("select");
      select.id = "comparar-select"; select.className = "chart-comparar-select";
      select.setAttribute("aria-label", "Comparar com outra commodity");
      select.innerHTML = '<option value="">Comparar com...</option>';
      var nomes = { soja: "Soja", milho: "Milho", cafe: "Café Arábica", "boi-gordo": "Boi Gordo" };
      if (dados && dados.fisicos) Object.keys(dados.fisicos).forEach(function (slug) {
        if (slug !== atual) select.innerHTML += '<option value="' + slug + '">' + (nomes[slug] || slug) + '</option>';
      });
      ferramentas.insertBefore(select, ferramentas.querySelector(".chart-exportar"));
    });
    document.querySelectorAll(".chart-modo-btn").forEach(function (botao) {
      botao.addEventListener("click", function () {
        document.querySelectorAll(".chart-modo-btn").forEach(function (item) {
          var ativo = item === botao; item.classList.toggle("active", ativo); item.setAttribute("aria-selected", ativo ? "true" : "false");
        });
        renderizarModoGrafico(botao.dataset.modoGrafico);
      });
    });
    document.querySelectorAll(".chart-serie-select").forEach(function (select) {
      select.addEventListener("change", function () {
        document.querySelectorAll(".chart-series-panel").forEach(function (painel) {
          painel.hidden = painel.dataset.serie !== select.value;
        });
        var modoAtivo = document.querySelector(".chart-modo-btn.active");
        renderizarModoGrafico(modoAtivo ? modoAtivo.dataset.modoGrafico : "linha");
        var comparar = document.getElementById("comparar-select");
        if (comparar && comparar.value) desenharComparacao(comparar.value);
      });
    });
    document.querySelectorAll(".chart-exportar").forEach(function (botao) {
      botao.addEventListener("click", function () {
        var secao = document.querySelector('[aria-labelledby="titulo-grafico"]');
        if (secao) secao.classList.add("grafico-para-impressao");
        document.body.classList.add("imprimir-grafico"); window.print();
        window.setTimeout(function () { document.body.classList.remove("imprimir-grafico"); }, 1000);
        window.setTimeout(function () { if (secao) secao.classList.remove("grafico-para-impressao"); }, 1000);
      });
    });
  }

  function limparComparacao(svg) {
    var existente = svg.querySelector(".chart-comparacao");
    if (existente) existente.remove();
  }

  function pararComparacao() {
    document.querySelectorAll(".chart-wrap.chart-comparando").forEach(function (wrap) {
      var svg = wrap.querySelector("svg");
      if (svg) limparComparacao(svg);
      wrap.classList.remove("chart-comparando");
    });
    var legenda = document.querySelector(".chart-comparacao-legenda");
    if (legenda) legenda.classList.remove("visivel");
  }

  function iniciarComparador() {
    var select = document.getElementById("comparar-select");
    if (!select) return;
    select.addEventListener("change", function () {
      if (select.value) {
        desenharComparacao(select.value);
      } else {
        pararComparacao();
      }
    });
  }

  // -------------------------------------------------------------------
  // 5) Compartilhar: copiar link + intents de WhatsApp/LinkedIn (sem
  //    nenhuma API/conta de terceiro - so URLs publicas de share).
  // -------------------------------------------------------------------

  function iniciarCompartilhar() {
    document.querySelectorAll(".compartilhar-copiar").forEach(function (botao) {
      botao.addEventListener("click", function () {
        var url = window.location.href;
        var textoOriginal = botao.textContent;
        function marcarCopiado() {
          botao.textContent = "Link copiado!";
          window.setTimeout(function () { botao.textContent = textoOriginal; }, 2000);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(marcarCopiado, function () {});
        } else {
          var campo = document.createElement("textarea");
          campo.value = url;
          campo.style.position = "fixed";
          campo.style.opacity = "0";
          document.body.appendChild(campo);
          campo.select();
          try { document.execCommand("copy"); marcarCopiado(); } catch (e) {}
          document.body.removeChild(campo);
        }
      });
    });
  }

  // -------------------------------------------------------------------
  // 6) Exportar/imprimir a analise da semana em PDF (via impressao do
  //    navegador - sem geracao de PDF no servidor).
  // -------------------------------------------------------------------

  function iniciarExportarPdf() {
    document.querySelectorAll(".analise-exportar").forEach(function (botao) {
      botao.addEventListener("click", function () {
        window.print();
      });
    });
  }

  // -------------------------------------------------------------------
  // Inicializacao
  // -------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", function () {
    iniciarNumerosAnimados();
    iniciarRevelacaoAoRolar();
    iniciarSeletorPeriodo();
    iniciarFerramentasGrafico();
    iniciarComparador();
    iniciarCompartilhar();
    iniciarExportarPdf();
  });
})();
