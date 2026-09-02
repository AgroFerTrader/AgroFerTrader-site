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

  function formatarDataBR(dataIso) {
    var partes = String(dataIso).split("-");
    return partes.length === 3 ? partes.reverse().join("/") : dataIso;
  }

  var UNIDADES_PRECO = { soja: "R$/saca", milho: "R$/saca", cafe: "R$/saca", "boi-gordo": "R$/@" };

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

        var chartBox = nav.closest(".chart-box");
        if (chartBox && chartBox._sairModoPersonalizado) chartBox._sairModoPersonalizado();

        nav.querySelectorAll(".periodo-btn").forEach(function (b) {
          var ativo = b === botao;
          b.classList.toggle("active", ativo);
          b.setAttribute("aria-selected", ativo ? "true" : "false");
        });
        painel.querySelectorAll("[data-periodo]").forEach(function (bloco) {
          bloco.hidden = bloco.getAttribute("data-periodo") !== periodo;
        });

        // Se houver uma comparacao ativa, redesenha pro novo periodo.
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

  function renderizarComparativo(painel) {
    var dados = obterDadosHistorico();
    var svg = painel.querySelector(".comparativo-svg");
    if (!dados || !svg) return;
    var base = document.querySelector(".chart-wrap");
    if (!base) return;
    var serieTipo = painel.querySelector(".comparativo-serie").value;
    var selecionados = Array.from(painel.querySelectorAll("input[name='commodity-comparada']:checked")).map(function (input) { return input.value; });
    if (!selecionados.length) {
      svg.innerHTML = "";
      painel.querySelector(".comparativo-legenda").innerHTML = "";
      return;
    }
    var slugBase = base.dataset.slug;
    var nomes = { soja: "Soja", milho: "Milho", cafe: "Café Arábica", "boi-gordo": "Boi Gordo" };
    var series = [{ slug: slugBase, nome: nomes[slugBase] || slugBase, valores: (dados[serieTipo][slugBase] || []) }];
    selecionados.forEach(function (slug) { if (dados[serieTipo][slug]) series.push({ slug: slug, nome: nomes[slug] || slug, valores: dados[serieTipo][slug] }); });
    series = series.filter(function (item) { return item.valores.length > 1; });
    if (series.length < 2) { svg.innerHTML = '<text x="450" y="160" text-anchor="middle" fill="#61705f" font-family="Arial">Selecione ao menos uma commodity com histórico disponível.</text>'; return; }
    var n = Math.min.apply(null, series.map(function (item) { return item.valores.length; }));
    series.forEach(function (item) { item.valores = item.valores.slice(-n); item.variacoes = _variacaoPercentual(item.valores); });
    var todas = [].concat.apply([], series.map(function (item) { return item.variacoes; }));
    var minimo = Math.min.apply(null, todas), maximo = Math.max.apply(null, todas);
    if (minimo === maximo) { minimo -= 1; maximo += 1; }
    var esquerda = 72, topo = 28, largura = 820, altura = 220, passo = largura / (n - 1), faixa = maximo - minimo;
    function ponto(valor, indice) { return [esquerda + indice * passo, topo + altura - ((valor - minimo) / faixa) * altura]; }
    var ns = "http://www.w3.org/2000/svg";
    svg.setAttribute("viewBox", "0 0 920 320"); svg.innerHTML = "";
    [minimo, 0, maximo].forEach(function (valor) { var p = ponto(valor, 0), linha = document.createElementNS(ns, "line"); linha.setAttribute("x1", esquerda); linha.setAttribute("x2", esquerda + largura); linha.setAttribute("y1", p[1]); linha.setAttribute("y2", p[1]); linha.setAttribute("stroke", valor === 0 ? "#B08830" : "#d7ddcf"); linha.setAttribute("stroke-dasharray", valor === 0 ? "none" : "3,4"); svg.appendChild(linha); var texto = document.createElementNS(ns, "text"); texto.setAttribute("x", esquerda - 10); texto.setAttribute("y", p[1] + 4); texto.setAttribute("text-anchor", "end"); texto.setAttribute("font-size", "11"); texto.setAttribute("fill", "#61705f"); texto.textContent = valor.toFixed(1).replace(".", ",") + "%"; svg.appendChild(texto); });
    var cores = ["#B08830", "#0B3C1F", "#9C3B2E", "#4C7A1F"];
    var modo = painel.querySelector(".comparativo-modo").value;
    series.forEach(function (item, indice) {
      var pontos = item.variacoes.map(ponto), grupo = document.createElementNS(ns, "g");
      grupo.setAttribute("class", "comparativo-linha");
      if (modo === "barras") pontos.forEach(function (p, i) { var barra = document.createElementNS(ns, "rect"), zero = ponto(0, i)[1]; barra.setAttribute("x", p[0] - Math.max(2, passo / (series.length + 1)) * (series.length - indice)); barra.setAttribute("y", Math.min(p[1], zero)); barra.setAttribute("width", Math.max(3, passo / (series.length + 1))); barra.setAttribute("height", Math.abs(zero - p[1])); barra.setAttribute("fill", cores[indice % cores.length]); barra.setAttribute("opacity", ".78"); grupo.appendChild(barra); });
      else { var linha = document.createElementNS(ns, "path"); linha.setAttribute("d", _caminhoSuaveJS(pontos)); linha.setAttribute("fill", "none"); linha.setAttribute("stroke", cores[indice % cores.length]); linha.setAttribute("stroke-width", indice === 0 ? "3" : "2"); grupo.appendChild(linha); }
      svg.appendChild(grupo);
    });
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i) { var texto = document.createElementNS(ns, "text"), p = ponto(0, i); texto.setAttribute("x", p[0]); texto.setAttribute("y", "285"); texto.setAttribute("text-anchor", "middle"); texto.setAttribute("font-size", "11"); texto.setAttribute("fill", "#61705f"); texto.textContent = (series[0].valores[i][0] || "").split("-").reverse().join("/"); svg.appendChild(texto); });
    var legenda = painel.querySelector(".comparativo-legenda"); legenda.innerHTML = series.map(function (item, indice) { return '<span><i style="background:' + cores[indice % cores.length] + '"></i>' + item.nome + " · " + (serieTipo === "futuros" ? "futuro" : "físico") + "</span>"; }).join("");
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
      var largura = 900, altura = 360, margemEsq = parseFloat(wrap.dataset.margemEsq);
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

  // -------------------------------------------------------------------
  // 4.5) Intervalo personalizado: alem dos periodos pre-renderizados
  //    (7/30/90 dias), o usuario pode escolher data inicial e final -
  //    calculado inteiramente no navegador a partir dos mesmos dados
  //    historicos ja embutidos na pagina (DADOS_HISTORICO_JSON), sem
  //    nenhuma requisicao nova. O grafico gerado segue o mesmo layout
  //    visual (eixos, cores, leitura ao passar o mouse) do grafico
  //    renderizado no servidor.
  // -------------------------------------------------------------------

  function ativarLeituraChartWrap(wrap) {
    if (!wrap) return;
    var rodape = wrap.nextElementSibling;
    if (!rodape) return;
    var elTexto = rodape.querySelector(".chart-readout-texto");
    if (!elTexto) return;
    var textoPadrao = elTexto.textContent;
    var ativo = null;
    wrap.querySelectorAll(".chart-hit").forEach(function (ponto) {
      function ativar() {
        if (ativo) ativo.classList.remove("chart-dot-ativo");
        var alvo = wrap.querySelector("#" + ponto.getAttribute("data-alvo"));
        if (alvo) { alvo.classList.add("chart-dot-ativo"); ativo = alvo; }
        elTexto.textContent = ponto.getAttribute("data-data") + " · R$ " + ponto.getAttribute("data-preco");
      }
      ponto.addEventListener("mouseenter", ativar);
      ponto.addEventListener("touchstart", ativar, { passive: true });
    });
    wrap.addEventListener("mouseleave", function () {
      if (ativo) { ativo.classList.remove("chart-dot-ativo"); ativo = null; }
      elTexto.textContent = textoPadrao;
    });
  }

  function renderizarGraficoPersonalizado(slug, serieFiltrada, nomeExibicao) {
    var largura = 900, altura = 360;
    var valores = serieFiltrada.map(function (p) { return p[1]; });
    var maiorTexto = "R$ " + formatarBRL(Math.max.apply(null, valores));
    var margemEsq = Math.max(50, 14 + maiorTexto.length * 6);
    var margemDir = 20, margemTopo = 30, margemBaixo = 34;
    var minimo = Math.min.apply(null, valores), maximo = Math.max.apply(null, valores);
    if (minimo === maximo) { minimo -= 1; maximo += 1; }
    var faixa = maximo - minimo;
    var larguraUtil = largura - margemEsq - margemDir;
    var alturaUtil = altura - margemTopo - margemBaixo;
    var passoX = larguraUtil / Math.max(1, serieFiltrada.length - 1);

    var pontos = serieFiltrada.map(function (p, i) {
      return {
        x: margemEsq + i * passoX,
        y: margemTopo + alturaUtil - ((p[1] - minimo) / faixa) * alturaUtil,
        data: p[0],
        valor: p[1]
      };
    });

    var corLinha = valores[valores.length - 1] >= valores[0] ? "#4C7A1F" : "#9C3B2E";
    var caminhoLinha = _caminhoSuaveJS(pontos.map(function (p) { return [p.x, p.y]; }));
    var linhaBaseY = margemTopo + alturaUtil;
    var ultimo = pontos[pontos.length - 1], primeiro = pontos[0];
    var caminhoArea = caminhoLinha +
      " L " + ultimo.x.toFixed(1) + "," + linhaBaseY.toFixed(1) +
      " L " + primeiro.x.toFixed(1) + "," + linhaBaseY.toFixed(1) + " Z";

    var sufixoId = slug + "-personalizado-" + Date.now();
    var idGrad = "grad-" + sufixoId;

    var numTicksPreco = 4, linhasGrade = "", rotulosPreco = "";
    for (var i = 0; i < numTicksPreco; i++) {
      var valorTick = minimo + faixa * i / (numTicksPreco - 1);
      var yTick = margemTopo + alturaUtil - ((valorTick - minimo) / faixa) * alturaUtil;
      if (i > 0) {
        linhasGrade += '<line x1="' + margemEsq + '" y1="' + yTick.toFixed(1) + '" x2="' + (largura - margemDir) +
          '" y2="' + yTick.toFixed(1) + '" stroke="rgba(11,60,31,0.08)" stroke-width="1" stroke-dasharray="3,4"/>';
      }
      rotulosPreco += '<text x="' + (margemEsq - 8) + '" y="' + (yTick + 4).toFixed(1) +
        '" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="11" fill="#0B3C1F" opacity="0.6">R$ ' +
        formatarBRL(valorTick) + '</text>';
    }

    var numRotulosData = Math.min(5, pontos.length);
    var indicesRotulo = [];
    if (numRotulosData <= 1) {
      indicesRotulo = [0];
    } else {
      var passoIndice = (pontos.length - 1) / (numRotulosData - 1);
      var vistos = {};
      for (var j = 0; j < numRotulosData; j++) {
        var idx = Math.round(j * passoIndice);
        if (!vistos[idx]) { vistos[idx] = true; indicesRotulo.push(idx); }
      }
    }
    var rotulosDatas = indicesRotulo.map(function (idx) {
      var p = pontos[idx];
      return '<text x="' + p.x.toFixed(1) + '" y="' + (altura - 10) +
        '" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="#0B3C1F" opacity="0.6">' +
        formatarDataBR(p.data) + '</text>';
    }).join("");

    var pontosSvg = pontos.map(function (p, i) {
      var idPonto = "ponto-" + sufixoId + "-" + i;
      return '<circle id="' + idPonto + '" class="chart-dot" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
        '" r="3" fill="' + corLinha + '"/><circle class="chart-hit" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
        '" r="10" fill="transparent" data-alvo="' + idPonto + '" data-data="' + formatarDataBR(p.data) +
        '" data-preco="' + formatarBRL(p.valor) + '"/>';
    }).join("");

    var unidade = UNIDADES_PRECO[slug] || "R$/saca";
    var dataFinalFmt = formatarDataBR(ultimo.data);
    var precoFinalFmt = formatarBRL(ultimo.valor);

    var html =
      '<div class="chart-wrap" id="grafico-' + sufixoId + '">' +
      '<svg viewBox="0 0 ' + largura + ' ' + altura + '" xmlns="http://www.w3.org/2000/svg" role="img" ' +
      'aria-label="Variação de preço de ' + nomeExibicao + ' entre ' + formatarDataBR(primeiro.data) + ' e ' + dataFinalFmt + '">' +
      '<defs><linearGradient id="' + idGrad + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + corLinha + '" stop-opacity="0.25"/>' +
      '<stop offset="100%" stop-color="' + corLinha + '" stop-opacity="0"/></linearGradient></defs>' +
      '<text x="' + margemEsq + '" y="16" text-anchor="start" font-family="IBM Plex Mono, monospace" font-size="11" ' +
      'font-weight="600" fill="#0B3C1F" opacity="0.55">' + unidade + '</text>' +
      linhasGrade +
      '<line x1="' + margemEsq + '" y1="' + margemTopo + '" x2="' + margemEsq + '" y2="' + (margemTopo + alturaUtil) +
      '" stroke="rgba(11,60,31,0.14)" stroke-width="1"/>' +
      '<line x1="' + margemEsq + '" y1="' + (margemTopo + alturaUtil) + '" x2="' + (largura - margemDir) + '" y2="' +
      (margemTopo + alturaUtil) + '" stroke="rgba(11,60,31,0.14)" stroke-width="1"/>' +
      rotulosPreco +
      '<path d="' + caminhoArea + '" fill="url(#' + idGrad + ')" stroke="none"/>' +
      '<path d="' + caminhoLinha + '" fill="none" stroke="' + corLinha + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      pontosSvg + rotulosDatas +
      '<circle cx="' + ultimo.x.toFixed(1) + '" cy="' + ultimo.y.toFixed(1) + '" r="4" fill="' + corLinha + '"/>' +
      '</svg></div>' +
      '<div class="chart-footer">' +
      '<span class="chart-footer-extremo">' + formatarDataBR(primeiro.data) + '</span>' +
      '<span class="chart-readout-texto">' + dataFinalFmt + ' · R$ ' + precoFinalFmt + '</span>' +
      '<span class="chart-footer-extremo">' + dataFinalFmt + ' · R$ ' + precoFinalFmt + '</span>' +
      '</div>';

    return html;
  }

  function iniciarIntervaloPersonalizado() {
    var nomes = { soja: "Soja", milho: "Milho", cafe: "Café Arábica", "boi-gordo": "Boi Gordo" };

    document.querySelectorAll(".chart-box").forEach(function (chartBox) {
      var baseWrap = chartBox.querySelector(".chart-wrap");
      var ferramentas = chartBox.querySelector(".chart-ferramentas");
      if (!baseWrap || !ferramentas || ferramentas.querySelector(".chart-personalizado")) return;

      var dados = obterDadosHistorico();
      if (!dados) return;

      var slug = baseWrap.dataset.slug;

      var bloco = document.createElement("div");
      bloco.className = "chart-personalizado";
      bloco.innerHTML =
        '<label class="chart-personalizado-campo">De <input type="date" class="chart-data-inicio"></label>' +
        '<label class="chart-personalizado-campo">Até <input type="date" class="chart-data-fim"></label>' +
        '<button type="button" class="chart-exportar chart-personalizado-aplicar">Aplicar período</button>' +
        '<span class="chart-personalizado-aviso" hidden></span>';
      ferramentas.appendChild(bloco);

      var todasDatas = (dados.fisicos[slug] || []).concat(dados.futuros[slug] || []).map(function (p) { return p[0]; });
      if (todasDatas.length) {
        var minData = todasDatas.reduce(function (a, b) { return a < b ? a : b; });
        var maxData = todasDatas.reduce(function (a, b) { return a > b ? a : b; });
        ["chart-data-inicio", "chart-data-fim"].forEach(function (classe) {
          var campo = bloco.querySelector("." + classe);
          campo.min = minData;
          campo.max = maxData;
        });
      }

      var resultado = document.createElement("div");
      resultado.className = "chart-painel-personalizado";
      resultado.hidden = true;
      chartBox.insertBefore(resultado, ferramentas.nextSibling);

      chartBox._sairModoPersonalizado = function () {
        resultado.hidden = true;
        resultado.innerHTML = "";
        var select = chartBox.querySelector(".chart-serie-select");
        chartBox.querySelectorAll(".chart-series-panel").forEach(function (painel) {
          painel.hidden = select ? painel.dataset.serie !== select.value : painel.dataset.serie !== "fisicos";
        });
      };

      bloco.querySelector(".chart-personalizado-aplicar").addEventListener("click", function () {
        var inicio = bloco.querySelector(".chart-data-inicio").value;
        var fim = bloco.querySelector(".chart-data-fim").value;
        var aviso = bloco.querySelector(".chart-personalizado-aviso");
        aviso.hidden = true;

        if (!inicio || !fim || inicio > fim) {
          aviso.textContent = "Escolha uma data inicial e uma final, com a inicial antes da final.";
          aviso.hidden = false;
          return;
        }

        var select = chartBox.querySelector(".chart-serie-select");
        var serieTipo = select ? select.value : "fisicos";
        var serie = (dados[serieTipo] && dados[serieTipo][slug]) || [];
        var filtrada = serie.filter(function (p) { return p[0] >= inicio && p[0] <= fim; });

        if (filtrada.length < 2) {
          aviso.textContent = "Sem dados suficientes nesse período — tente um intervalo maior.";
          aviso.hidden = false;
          return;
        }

        chartBox.querySelectorAll(".periodo-btn").forEach(function (b) {
          b.classList.remove("active");
          b.setAttribute("aria-selected", "false");
        });
        chartBox.querySelectorAll(".chart-series-panel").forEach(function (painel) { painel.hidden = true; });

        resultado.innerHTML = renderizarGraficoPersonalizado(slug, filtrada, nomes[slug] || slug);
        resultado.hidden = false;
        ativarLeituraChartWrap(resultado.querySelector(".chart-wrap"));
      });
    });
  }

  function iniciarFerramentasGrafico() {
    var estiloImpressao = document.createElement("style");
    estiloImpressao.textContent = ".comparativo-painel{margin:28px 0 0;padding:28px 32px;border:1px solid #d7ddcf;border-top:3px solid #B08830;background:#FDFDF9}.comparativo-cabecalho{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.comparativo-cabecalho h3{margin:5px 0 4px;color:#0B3C1F;font:600 25px Georgia,serif}.comparativo-cabecalho p{max-width:62ch;margin:0;color:#61705f;font-size:14px;line-height:1.6}.comparativo-limpar{border:1px solid #d7ddcf;background:#fff;color:#0B3C1F;padding:8px 12px;font:500 11px 'IBM Plex Mono',monospace;cursor:pointer;white-space:nowrap}.comparativo-controles{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;margin:24px 0 14px}.comparativo-controles fieldset{border:0;margin:0;padding:0}.comparativo-controles legend,.comparativo-controles label{display:block;font:500 11px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.06em;color:#4C7A1F;margin-bottom:8px}.comparativo-opcoes{display:flex;gap:8px;flex-wrap:wrap}.comparativo-opcoes label{display:flex;align-items:center;gap:6px;border:1px solid #d7ddcf;background:#fff;color:#0B3C1F;padding:9px 11px;text-transform:none;letter-spacing:0;font:500 13px Inter,sans-serif;margin:0}.comparativo-controles select{display:block;margin-top:8px;padding:9px 11px;border:1px solid #d7ddcf;background:#fff;color:#0B3C1F;font:13px Inter,sans-serif}.comparativo-legenda{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 6px;font:12px 'IBM Plex Mono',monospace;color:#61705f}.comparativo-legenda span{display:inline-flex;align-items:center;gap:6px}.comparativo-legenda i{width:18px;height:3px;display:inline-block}.comparativo-svg{width:100%;height:auto;min-height:260px;display:block}.comparativo-vazio{margin:0;color:#61705f;font-size:13px}.comparativo-vazio[hidden]{display:none}@media print{body.imprimir-grafico>*{display:none!important}body.imprimir-grafico main{display:block!important}body.imprimir-grafico main>section{display:none!important}body.imprimir-grafico main>section.grafico-para-impressao{display:block!important;padding:20px 0}body.imprimir-grafico .chart-ferramentas,body.imprimir-grafico .comparativo-painel{display:none!important}}@media(max-width:640px){.comparativo-painel{padding:24px 18px}.comparativo-cabecalho{display:block}.comparativo-limpar{margin-top:16px}.comparativo-controles{gap:16px}.comparativo-svg{min-height:220px}}.chart-personalizado{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}.chart-personalizado-campo{display:flex;align-items:center;gap:6px;font:12px 'IBM Plex Mono',monospace;color:#0B3C1F;opacity:.75}.chart-personalizado-campo input[type=date]{font:12px Inter,sans-serif;padding:5px 6px;border:1px solid #d7ddcf;border-radius:2px;background:#fff;color:#0B3C1F}.chart-personalizado-aviso{font:12px Inter,sans-serif;color:#9C3B2E;flex-basis:100%}.chart-personalizado-aviso[hidden]{display:none}.chart-painel-personalizado[hidden]{display:none}@media(max-width:640px){.chart-personalizado{margin-left:0;width:100%}}";
    document.head.appendChild(estiloImpressao);
      document.querySelectorAll(".chart-ferramentas").forEach(function (ferramentas) {
        var comparadorLegado = ferramentas.querySelector("#comparar-select");
        if (comparadorLegado) comparadorLegado.style.display = "none";
        var dados = obterDadosHistorico();
        var base = document.querySelector(".chart-wrap");
        var grafico = document.querySelector(".chart-box");
        if (dados && base && grafico && !document.querySelector(".comparativo-painel")) {
          var nomes = { soja: "Soja", milho: "Milho", cafe: "Café Arábica", "boi-gordo": "Boi Gordo" };
          var painel = document.createElement("section"); painel.className = "comparativo-painel";
          painel.innerHTML = '<div class="comparativo-cabecalho"><div><span class="section-label">Comparação</span><h3>Evolução comparada</h3><p>Todos os preços são normalizados para começar em 0%. Assim, commodities com valores diferentes podem ser comparadas sem distorção.</p></div><button type="button" class="comparativo-limpar">Limpar seleção</button></div><div class="comparativo-controles"><fieldset><legend>Commodities</legend><div class="comparativo-opcoes"></div></fieldset><label>Série<select class="comparativo-serie"><option value="fisicos">Preço físico</option><option value="futuros">Preço futuro</option></select></label><label>Visualização<select class="comparativo-modo"><option value="linha">Linhas</option><option value="barras">Barras agrupadas</option></select></label></div><div class="comparativo-legenda"></div><svg class="comparativo-svg" role="img" aria-label="Comparação de evolução percentual entre commodities"></svg><p class="comparativo-vazio">Selecione uma ou mais commodities para iniciar a comparação.</p>';
          grafico.parentNode.insertBefore(painel, grafico.nextSibling);
          var opcoes = painel.querySelector(".comparativo-opcoes");
          Object.keys(dados.fisicos).forEach(function (slug) { if (slug !== base.dataset.slug) opcoes.innerHTML += '<label><input type="checkbox" name="commodity-comparada" value="' + slug + '">' + (nomes[slug] || slug) + '</label>'; });
          painel.querySelectorAll("input[name='commodity-comparada']").forEach(function (input) { input.addEventListener("change", function () { painel.querySelector(".comparativo-vazio").hidden = painel.querySelectorAll("input:checked").length > 0; renderizarComparativo(painel); }); });
          painel.querySelector(".comparativo-serie").addEventListener("change", function () { renderizarComparativo(painel); });
          painel.querySelector(".comparativo-modo").addEventListener("change", function () { renderizarComparativo(painel); });
          painel.querySelector(".comparativo-limpar").addEventListener("click", function () { painel.querySelectorAll("input:checked").forEach(function (input) { input.checked = false; }); painel.querySelector(".comparativo-vazio").hidden = false; renderizarComparativo(painel); });
        }
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
        var chartBox = select.closest(".chart-box");
        if (chartBox && chartBox._sairModoPersonalizado) chartBox._sairModoPersonalizado();
        document.querySelectorAll(".chart-series-panel").forEach(function (painel) {
          painel.hidden = painel.dataset.serie !== select.value;
        });
        var modoAtivo = document.querySelector(".chart-modo-btn.active");
        renderizarModoGrafico(modoAtivo ? modoAtivo.dataset.modoGrafico : "linha");
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
    return;
  }
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
    iniciarIntervaloPersonalizado();
    iniciarComparador();
    iniciarCompartilhar();
    iniciarExportarPdf();
  });
})();
