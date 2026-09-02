/*
 * AgroFer Trader - interatividade do site
 * =========================================
 * Script unico, compartilhado por todas as paginas (home + commodities),
 * carregado uma vez no fim do <body>. Cada funcao verifica se os
 * elementos que precisa existem antes de agir - paginas que nao tem
 * determinado recurso simplesmente nao disparam aquele bloco (nada
 * quebra por falta de elemento).
 *
 * Sem dependencia externa pra desenhar os graficos (sem biblioteca de
 * grafico - so DOM/SVG nativos do navegador). A UNICA dependencia
 * externa do site e o jsPDF (carregado via CDN nas paginas de
 * commodity, antes deste arquivo), usado so pela exportacao de
 * grafico em PDF - ver exportarSvgComoPdf() mais abaixo.
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
  var NOMES_COMMODITY = { soja: "Soja", milho: "Milho", cafe: "Café Arábica", "boi-gordo": "Boi Gordo" };

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
    var periodoEl = painel.querySelector(".comparativo-periodo");
    var periodo = periodoEl ? periodoEl.value : "tudo";
    var leitura = painel.querySelector(".comparativo-leitura");
    var textoLeituraPadrao = "Passe o mouse sobre o gráfico para ver o preço de cada dia.";
    var selecionados = Array.from(painel.querySelectorAll("input[name='commodity-comparada']:checked")).map(function (input) { return input.value; });
    if (!selecionados.length) {
      svg.innerHTML = "";
      painel.querySelector(".comparativo-legenda").innerHTML = "";
      if (leitura) leitura.textContent = textoLeituraPadrao;
      return;
    }
    var slugBase = base.dataset.slug;
    var series = [{ slug: slugBase, nome: NOMES_COMMODITY[slugBase] || slugBase, valores: (dados[serieTipo][slugBase] || []) }];
    selecionados.forEach(function (slug) { if (dados[serieTipo][slug]) series.push({ slug: slug, nome: NOMES_COMMODITY[slug] || slug, valores: dados[serieTipo][slug] }); });
    series = series.filter(function (item) { return item.valores.length > 1; });
    if (series.length < 2) { svg.innerHTML = '<text x="500" y="200" text-anchor="middle" fill="#61705f" font-family="Arial">Selecione ao menos uma commodity com histórico disponível.</text>'; if (leitura) leitura.textContent = textoLeituraPadrao; return; }

    if (periodo !== "tudo") {
      var dias = parseInt(periodo, 10);
      series.forEach(function (item) { item.valores = item.valores.slice(-dias); });
      series = series.filter(function (item) { return item.valores.length > 1; });
      if (series.length < 2) { svg.innerHTML = '<text x="500" y="200" text-anchor="middle" fill="#61705f" font-family="Arial">Sem dados suficientes nesse período.</text>'; if (leitura) leitura.textContent = textoLeituraPadrao; return; }
    }

    var n = Math.min.apply(null, series.map(function (item) { return item.valores.length; }));
    // Todas as commodities selecionadas compartilham o MESMO eixo de
    // preco (R$ real, nao %) - uma commodity que vale mais (ex. cafe
    // ~R$1.800) aparece mais alta que uma que vale menos (ex. soja
    // ~R$150), mesmo que a variacao percentual da mais barata tenha
    // sido maior no periodo.
    //
    // Quando os precos selecionados sao muito diferentes em grandeza
    // (proporcao maior que ~3x entre o maior e o menor), uma escala
    // linear faz a commodity mais barata parecer uma reta constante -
    // sua variacao real (de uns poucos R$) fica invisivel perto da
    // variacao da mais cara (de centenas de R$). A escala logaritmica
    // resolve isso sem distorcer os valores: ela espalha os precos pela
    // VARIACAO PERCENTUAL (nao a diferenca absoluta), entao a mesma
    // oscilacao relativa - digamos, 10% - ocupa a mesma altura no
    // grafico pra qualquer commodity, cara ou barata. Os valores
    // continuam reais (nos rotulos, na legenda, ao passar o mouse) -
    // so a posicao no eixo e calculada de outro jeito.
    series.forEach(function (item) {
      item.valores = item.valores.slice(-n);
      item.unidade = UNIDADES_PRECO[item.slug] || "R$/saca";
    });
    var cores = ["#B08830", "#0B3C1F", "#9C3B2E", "#4C7A1F"];
    var ns = "http://www.w3.org/2000/svg";
    var numTicks = 4;

    // Com exatamente 2 commodities (a base + 1 marcada), cada uma ganha
    // seu PROPRIO eixo (esquerda para a primeira, direita para a
    // segunda) - assim a variacao real de cada uma fica totalmente
    // visivel, sem uma "esmagar" a outra por causa da diferenca de
    // preco entre elas. Com 3+ commodities um eixo por serie no ficaria
    // poluido demais, entao elas continuam compartilhando um unico eixo
    // (ver funcaoEscalaCompartilhada abaixo).
    var usarDoisEixos = series.length === 2;
    var topo = 30, altura = 300;
    var esquerda = usarDoisEixos ? 100 : 110;
    var direita = usarDoisEixos ? 100 : 30;
    var largura = 1000 - esquerda - direita;
    var passo = largura / (n - 1);

    svg.setAttribute("viewBox", "0 0 1000 420"); svg.innerHTML = "";

    // Grade neutra (sem numero associado - com 2 eixos, cada um tem sua
    // propria numeracao ao lado; com eixo compartilhado, o numero fica
    // junto de cada linha, ver mais abaixo).
    for (var g = 0; g < numTicks; g++) {
      var yGrade = topo + altura - (g / (numTicks - 1)) * altura;
      if (g === 0) continue;
      var linhaGrade = document.createElementNS(ns, "line");
      linhaGrade.setAttribute("x1", esquerda); linhaGrade.setAttribute("x2", esquerda + largura);
      linhaGrade.setAttribute("y1", yGrade); linhaGrade.setAttribute("y2", yGrade);
      linhaGrade.setAttribute("stroke", "#d7ddcf"); linhaGrade.setAttribute("stroke-dasharray", "3,4");
      svg.appendChild(linhaGrade);
    }

    var posicaoY;
    if (usarDoisEixos) {
      series.forEach(function (item) {
        var precos = item.valores.map(function (p) { return p[1]; });
        item.minimo = Math.min.apply(null, precos);
        item.maximo = Math.max.apply(null, precos);
        if (item.minimo === item.maximo) { item.minimo -= 1; item.maximo += 1; }
      });
      posicaoY = function (item, valor) {
        return topo + altura - ((valor - item.minimo) / (item.maximo - item.minimo)) * altura;
      };
      [series[0], series[1]].forEach(function (item, ladoIndice) {
        var corEixo = cores[ladoIndice];
        var x = ladoIndice === 0 ? esquerda : esquerda + largura;
        var alinhamento = ladoIndice === 0 ? "end" : "start";
        var deslocamento = ladoIndice === 0 ? -10 : 10;
        for (var t = 0; t < numTicks; t++) {
          var valorTickEixo = item.minimo + (item.maximo - item.minimo) * (t / (numTicks - 1));
          var yTickEixo = posicaoY(item, valorTickEixo);
          var rotuloEixo = document.createElementNS(ns, "text");
          rotuloEixo.setAttribute("x", x + deslocamento); rotuloEixo.setAttribute("y", yTickEixo + 4);
          rotuloEixo.setAttribute("text-anchor", alinhamento); rotuloEixo.setAttribute("font-size", "11");
          rotuloEixo.setAttribute("font-family", "IBM Plex Mono, monospace"); rotuloEixo.setAttribute("fill", corEixo);
          rotuloEixo.textContent = "R$ " + formatarBRL(valorTickEixo);
          svg.appendChild(rotuloEixo);
        }
        var rotuloNome = document.createElementNS(ns, "text");
        rotuloNome.setAttribute("x", x); rotuloNome.setAttribute("y", 14);
        rotuloNome.setAttribute("text-anchor", ladoIndice === 0 ? "start" : "end");
        rotuloNome.setAttribute("font-size", "10"); rotuloNome.setAttribute("font-family", "IBM Plex Mono, monospace");
        rotuloNome.setAttribute("font-weight", "600"); rotuloNome.setAttribute("fill", corEixo);
        rotuloNome.textContent = item.nome + " · " + item.unidade;
        svg.appendChild(rotuloNome);
      });
    } else {
      // 3+ commodities: um unico eixo compartilhado. Quando os precos
      // selecionados sao muito diferentes em grandeza (proporcao maior
      // que ~3x entre o maior e o menor), uma escala linear faz a(s)
      // commodity(ies) mais barata(s) parecerem uma reta constante -
      // escala logaritmica reparte pela VARIACAO PERCENTUAL (nao a
      // diferenca absoluta), entao a mesma oscilacao relativa ocupa a
      // mesma altura no grafico pra qualquer commodity, cara ou barata.
      var todosPrecos = [].concat.apply([], series.map(function (item) { return item.valores.map(function (p) { return p[1]; }); }));
      var minimo = Math.min.apply(null, todosPrecos), maximo = Math.max.apply(null, todosPrecos);
      if (minimo === maximo) { minimo -= 1; maximo += 1; }
      var usarEscalaLog = minimo > 0 && (maximo / minimo) >= 3;
      var faixaLinear = maximo - minimo;
      var faixaLog = usarEscalaLog ? Math.log(maximo / minimo) : 0;
      posicaoY = function (_item, valor) {
        var fracao = usarEscalaLog ? Math.log(valor / minimo) / faixaLog : (valor - minimo) / faixaLinear;
        return topo + altura - fracao * altura;
      };
      if (usarEscalaLog) {
        var avisoLog = document.createElementNS(ns, "text");
        avisoLog.setAttribute("x", esquerda); avisoLog.setAttribute("y", 14);
        avisoLog.setAttribute("font-size", "10"); avisoLog.setAttribute("font-family", "IBM Plex Mono, monospace");
        avisoLog.setAttribute("fill", "#61705f");
        avisoLog.textContent = "Escala logarítmica (preços com grandezas muito diferentes) — valores reais em cada ponto";
        svg.appendChild(avisoLog);
      }
      for (var t2 = 0; t2 < numTicks; t2++) {
        var fracaoTick = t2 / (numTicks - 1);
        var valorTick = usarEscalaLog ? minimo * Math.pow(maximo / minimo, fracaoTick) : minimo + faixaLinear * fracaoTick;
        var yTick = posicaoY(null, valorTick);
        var rotulo = document.createElementNS(ns, "text");
        rotulo.setAttribute("x", esquerda - 10); rotulo.setAttribute("y", yTick + 4);
        rotulo.setAttribute("text-anchor", "end"); rotulo.setAttribute("font-size", "11");
        rotulo.setAttribute("font-family", "IBM Plex Mono, monospace"); rotulo.setAttribute("fill", "#61705f");
        rotulo.textContent = "R$ " + formatarBRL(valorTick);
        svg.appendChild(rotulo);
      }
    }

    function ponto(item, indice) {
      return [esquerda + indice * passo, posicaoY(item, item.valores[indice][1])];
    }
    // Sempre em linha: gráfico de barras não representa bem commodities
    // de magnitude muito diferente lado a lado (a mais barata sempre
    // fica esmagada perto da linha de base, nao importa a escala) - o
    // grafico principal (uma so commodity por vez) continua tendo
    // Linha/Barras normalmente.
    var elementosLeitura = [];
    series.forEach(function (item, indice) {
      var pontos = item.valores.map(function (p, i) { return ponto(item, i); });
      var grupo = document.createElementNS(ns, "g");
      grupo.setAttribute("class", "comparativo-linha");
      var linha2 = document.createElementNS(ns, "path");
      linha2.setAttribute("d", _caminhoSuaveJS(pontos));
      linha2.setAttribute("fill", "none"); linha2.setAttribute("stroke", cores[indice % cores.length]);
      linha2.setAttribute("stroke-width", indice === 0 ? "3" : "2");
      grupo.appendChild(linha2);
      pontos.forEach(function (p, i) {
        var hit = document.createElementNS(ns, "circle");
        hit.setAttribute("cx", p[0]); hit.setAttribute("cy", p[1]); hit.setAttribute("r", "7");
        hit.setAttribute("fill", "transparent");
        hit.setAttribute("data-nome", item.nome);
        hit.setAttribute("data-data", (item.valores[i][0] || "").split("-").reverse().join("/"));
        hit.setAttribute("data-preco", formatarBRL(item.valores[i][1]));
        grupo.appendChild(hit);
        elementosLeitura.push(hit);
      });
      svg.appendChild(grupo);
    });
    if (leitura) {
      elementosLeitura.forEach(function (el) {
        el.style.cursor = "pointer";
        el.addEventListener("mouseenter", function () {
          leitura.textContent = el.getAttribute("data-data") + " · " + el.getAttribute("data-nome") + ": R$ " + el.getAttribute("data-preco");
        });
      });
      svg.addEventListener("mouseleave", function () { leitura.textContent = textoLeituraPadrao; });
    }
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i) { var texto = document.createElementNS(ns, "text"); texto.setAttribute("x", esquerda + i * passo); texto.setAttribute("y", topo + altura + 26); texto.setAttribute("text-anchor", "middle"); texto.setAttribute("font-size", "11"); texto.setAttribute("font-family", "IBM Plex Mono, monospace"); texto.setAttribute("fill", "#61705f"); texto.textContent = (series[0].valores[i][0] || "").split("-").reverse().join("/"); svg.appendChild(texto); });
    var legenda = painel.querySelector(".comparativo-legenda");
    legenda.innerHTML = series.map(function (item, indice) {
      var precos = item.valores.map(function (p) { return p[1]; });
      var sufixo = item.unidade.replace("R$", "");
      return '<span><i style="background:' + cores[indice % cores.length] + '"></i>' + item.nome + " " + sufixo + ": R$ " + formatarBRL(Math.min.apply(null, precos)) + "–" + formatarBRL(Math.max.apply(null, precos)) + "</span>";
    }).join("");
  }

  function renderizarModoGrafico(modo) {
    var serieAtiva = document.querySelector(".chart-series-panel:not([hidden])") || document;
    var wraps = Array.from(serieAtiva.querySelectorAll(".chart-painel [data-periodo]:not([hidden]) .chart-wrap"));
    document.querySelectorAll(".chart-painel-personalizado:not([hidden]) .chart-wrap").forEach(function (wrap) {
      wraps.push(wrap);
    });
    wraps.forEach(function (wrap) {
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
      // A primeira e a ultima barra sao centralizadas exatamente sobre o
      // primeiro/ultimo ponto - que fica em cima da propria borda do
      // grafico. Sem limitar a largura, essas duas barras "vazam" pra
      // fora da area util e cobrem os rotulos de preco (a esquerda) e a
      // linha do eixo. Limita cada barra a nunca passar de
      // [margemEsq, margemEsq + larguraUtil].
      var limiteEsq = margemEsq, limiteDir = margemEsq + larguraUtil;
      valores.forEach(function (valor, i) {
        var bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        var alturaBarra = ((valor - minimo) / (maximo - minimo)) * alturaUtil;
        var centroX = margemEsq + i * passo;
        var largBarra = Math.max(4, passo * .64);
        var xEsq = Math.max(limiteEsq, centroX - largBarra / 2);
        var xDir = Math.min(limiteDir, centroX + largBarra / 2);
        bar.setAttribute("class", "chart-bar"); bar.setAttribute("x", xEsq);
        bar.setAttribute("y", base - alturaBarra); bar.setAttribute("width", Math.max(1, xDir - xEsq));
        bar.setAttribute("height", alturaBarra); bar.setAttribute("fill", "#4C7A1F"); bar.setAttribute("opacity", ".7");
        svg.insertBefore(bar, svg.querySelector(".chart-hit"));
      });
    });
  }

  // -------------------------------------------------------------------
  // 4.4) Exportar grafico em PDF de verdade (jsPDF, carregado via CDN -
  //    unica dependencia externa do site). window.print() (usado antes)
  //    funciona bem no desktop, mas no celular cada navegador trata a
  //    tela de impressao de um jeito diferente e nem sempre vira um
  //    download - gerar o PDF diretamente no navegador e baixar como
  //    arquivo funciona de forma consistente em qualquer plataforma. Se
  //    a biblioteca nao carregar (offline, CDN bloqueado), cai de volta
  //    pro window.print().
  // -------------------------------------------------------------------

  function svgGraficoPrincipalAtivo(chartBox) {
    var serieAtiva = chartBox.querySelector(".chart-series-panel:not([hidden])") || chartBox;
    var wrap = serieAtiva.querySelector(".chart-painel [data-periodo]:not([hidden]) .chart-wrap")
      || chartBox.querySelector(".chart-painel-personalizado:not([hidden]) .chart-wrap");
    return wrap ? wrap.querySelector("svg") : null;
  }

  function exportarSvgComoPdf(svgOriginal, opcoes) {
    opcoes = opcoes || {};
    if (!svgOriginal || !window.jspdf || !window.jspdf.jsPDF) {
      window.print();
      return;
    }
    var viewBoxTexto = svgOriginal.getAttribute("viewBox") || "0 0 900 360";
    var viewBox = viewBoxTexto.split(/\s+/).map(Number);
    var larguraSvg = viewBox[2] || 900, alturaSvg = viewBox[3] || 360;

    var clone = svgOriginal.cloneNode(true);
    clone.setAttribute("width", larguraSvg);
    clone.setAttribute("height", alturaSvg);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.querySelectorAll(".chart-hit").forEach(function (el) { el.remove(); });

    var svgTexto = new XMLSerializer().serializeToString(clone);
    var escala = 2; // resolucao maior pra ficar nitido no PDF
    var canvas = document.createElement("canvas");
    canvas.width = larguraSvg * escala;
    canvas.height = alturaSvg * escala;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FDFDF9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var blob = new Blob([svgTexto], { type: "image/svg+xml;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      var dadosPng;
      try {
        dadosPng = canvas.toDataURL("image/png");
      } catch (e) {
        window.print();
        return;
      }
      var JsPdf = window.jspdf.jsPDF;
      var orientacao = larguraSvg >= alturaSvg ? "l" : "p";
      var doc = new JsPdf({ orientation: orientacao, unit: "pt", format: "a4" });
      var pageWidth = doc.internal.pageSize.getWidth();
      var pageHeight = doc.internal.pageSize.getHeight();
      var margem = 36;
      var topoImagem = margem;
      if (opcoes.titulo) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(15);
        doc.setTextColor(11, 60, 31);
        doc.text(opcoes.titulo, margem, margem + 6);
        topoImagem = margem + 24;
      }
      if (opcoes.subtitulo) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(90, 90, 90);
        doc.text(doc.splitTextToSize(opcoes.subtitulo, pageWidth - margem * 2), margem, topoImagem + 4);
        topoImagem += 18;
      }
      var larguraDisponivel = pageWidth - margem * 2;
      var alturaImagem = larguraDisponivel * (alturaSvg / larguraSvg);
      var alturaMaxima = pageHeight - topoImagem - margem - 20;
      if (alturaImagem > alturaMaxima) alturaImagem = alturaMaxima;
      doc.addImage(dadosPng, "PNG", margem, topoImagem, larguraDisponivel, alturaImagem);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(140, 140, 140);
      doc.text("AgroFer Trader · agrofertrader.github.io/AgroFerTrader-site · " + new Date().toLocaleDateString("pt-BR"), margem, pageHeight - 18);
      doc.save(opcoes.nomeArquivo || "grafico.pdf");
    };
    img.onerror = function () { URL.revokeObjectURL(url); window.print(); };
    img.src = url;
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
      '<div class="chart-wrap" id="grafico-' + sufixoId + '" data-slug="' + slug +
      '" data-margem-esq="' + margemEsq + '" data-margem-topo="' + margemTopo +
      '" data-altura-util="' + alturaUtil + '" data-largura-util="' + larguraUtil +
      '" data-num-pontos="' + serieFiltrada.length + '">' +
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
      '<path class="chart-area" d="' + caminhoArea + '" fill="url(#' + idGrad + ')" stroke="none"/>' +
      '<path class="chart-linha" d="' + caminhoLinha + '" fill="none" stroke="' + corLinha + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      pontosSvg + rotulosDatas +
      '<circle class="chart-dot-final" cx="' + ultimo.x.toFixed(1) + '" cy="' + ultimo.y.toFixed(1) + '" r="4" fill="' + corLinha + '"/>' +
      '</svg></div>' +
      '<div class="chart-footer">' +
      '<span class="chart-footer-extremo">' + formatarDataBR(primeiro.data) + '</span>' +
      '<span class="chart-readout-texto">' + dataFinalFmt + ' · R$ ' + precoFinalFmt + '</span>' +
      '<span class="chart-footer-extremo">' + dataFinalFmt + ' · R$ ' + precoFinalFmt + '</span>' +
      '</div>';

    return html;
  }

  function iniciarIntervaloPersonalizado() {
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
        '<button type="button" class="chart-btn-secundario chart-personalizado-aplicar">Aplicar período</button>' +
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

        resultado.innerHTML = renderizarGraficoPersonalizado(slug, filtrada, NOMES_COMMODITY[slug] || slug);
        resultado.hidden = false;
        ativarLeituraChartWrap(resultado.querySelector(".chart-wrap"));

        var modoAtivo = chartBox.querySelector(".chart-modo-btn.active");
        renderizarModoGrafico(modoAtivo ? modoAtivo.dataset.modoGrafico : "linha");
      });
    });
  }

  function iniciarFerramentasGrafico() {
    var estiloImpressao = document.createElement("style");
    estiloImpressao.textContent = ".comparativo-painel{margin:28px 0 0;padding:28px 32px;border:1px solid #d7ddcf;border-top:3px solid #B08830;background:#FDFDF9}.comparativo-cabecalho{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.comparativo-cabecalho h3{margin:5px 0 4px;color:#0B3C1F;font:600 25px Georgia,serif}.comparativo-cabecalho p{max-width:62ch;margin:0;color:#61705f;font-size:14px;line-height:1.6}.comparativo-acoes{display:flex;gap:10px;flex-wrap:wrap}.comparativo-limpar{border:1px solid #d7ddcf;background:#fff;color:#0B3C1F;padding:8px 12px;font:500 11px 'IBM Plex Mono',monospace;cursor:pointer;white-space:nowrap}.comparativo-controles{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;margin:24px 0 14px}.comparativo-controles fieldset{border:0;margin:0;padding:0}.comparativo-controles legend,.comparativo-controles label{display:block;font:500 11px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.06em;color:#4C7A1F;margin-bottom:8px}.comparativo-opcoes{display:flex;gap:8px;flex-wrap:wrap}.comparativo-opcoes label{display:flex;align-items:center;gap:6px;border:1px solid #d7ddcf;background:#fff;color:#0B3C1F;padding:9px 11px;text-transform:none;letter-spacing:0;font:500 13px Inter,sans-serif;margin:0}.comparativo-controles select{display:block;margin-top:8px;padding:9px 11px;border:1px solid #d7ddcf;background:#fff;color:#0B3C1F;font:13px Inter,sans-serif}.comparativo-legenda{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 6px;font:12px 'IBM Plex Mono',monospace;color:#61705f}.comparativo-legenda span{display:inline-flex;align-items:center;gap:6px}.comparativo-legenda i{width:18px;height:3px;display:inline-block}.comparativo-leitura{margin:0 0 10px;font:600 13px 'IBM Plex Mono',monospace;color:#0B3C1F;min-height:1.4em}.comparativo-svg{width:100%;height:auto;min-height:380px;display:block}.comparativo-vazio{margin:0;color:#61705f;font-size:13px}.comparativo-vazio[hidden]{display:none}@media print{body.imprimir-grafico>*{display:none!important}body.imprimir-grafico main{display:block!important}body.imprimir-grafico main>section{display:none!important}body.imprimir-grafico main>section.grafico-para-impressao{display:block!important;padding:20px 0}body.imprimir-grafico .chart-ferramentas,body.imprimir-grafico .comparativo-painel{display:none!important}}@media(max-width:640px){.comparativo-painel{padding:24px 18px}.comparativo-cabecalho{display:block}.comparativo-acoes{margin-top:16px}.comparativo-controles{gap:16px}.comparativo-svg{min-height:300px}}.chart-personalizado{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}.chart-personalizado-campo{display:flex;align-items:center;gap:6px;font:12px 'IBM Plex Mono',monospace;color:#0B3C1F;opacity:.75}.chart-personalizado-campo input[type=date]{font:12px Inter,sans-serif;padding:5px 6px;border:1px solid #d7ddcf;border-radius:2px;background:#fff;color:#0B3C1F}.chart-personalizado-aviso{font:12px Inter,sans-serif;color:#9C3B2E;flex-basis:100%}.chart-personalizado-aviso[hidden]{display:none}.chart-painel-personalizado[hidden]{display:none}@media(max-width:640px){.chart-personalizado{margin-left:0;width:100%}}";
    document.head.appendChild(estiloImpressao);
      document.querySelectorAll(".chart-ferramentas").forEach(function (ferramentas) {
        var comparadorLegado = ferramentas.querySelector("#comparar-select");
        if (comparadorLegado) comparadorLegado.style.display = "none";
        var dados = obterDadosHistorico();
        var base = document.querySelector(".chart-wrap");
        var grafico = document.querySelector(".chart-box");
        if (dados && base && grafico && !document.querySelector(".comparativo-painel")) {
          var painel = document.createElement("section"); painel.className = "comparativo-painel";
          painel.innerHTML = '<div class="comparativo-cabecalho"><div><span class="section-label">Comparação</span><h3>Evolução comparada</h3><p>Preço real (não variação percentual) de cada commodity selecionada - com 2 commodities, cada uma ganha seu próprio eixo (à esquerda e à direita); com mais de 2, todas dividem uma única escala. Passe o mouse sobre o gráfico para ver o valor de cada dia.</p></div><div class="comparativo-acoes"><button type="button" class="chart-btn-secundario comparativo-exportar">Exportar em PDF</button><button type="button" class="comparativo-limpar">Limpar seleção</button></div></div><div class="comparativo-controles"><fieldset><legend>Commodities</legend><div class="comparativo-opcoes"></div></fieldset><label>Série<select class="comparativo-serie"><option value="fisicos">Preço físico</option><option value="futuros">Preço futuro</option></select></label><label>Período<select class="comparativo-periodo"><option value="7">7 dias</option><option value="30">30 dias</option><option value="90" selected>90 dias</option><option value="tudo">Tudo</option></select></label></div><div class="comparativo-legenda"></div><p class="comparativo-leitura">Passe o mouse sobre o gráfico para ver o preço de cada dia.</p><svg class="comparativo-svg" role="img" aria-label="Comparação de preço real entre commodities, na mesma escala"></svg><p class="comparativo-vazio">Selecione uma ou mais commodities para iniciar a comparação.</p>';
          grafico.parentNode.insertBefore(painel, grafico.nextSibling);
          var opcoes = painel.querySelector(".comparativo-opcoes");
          Object.keys(dados.fisicos).forEach(function (slug) { if (slug !== base.dataset.slug) opcoes.innerHTML += '<label><input type="checkbox" name="commodity-comparada" value="' + slug + '">' + (NOMES_COMMODITY[slug] || slug) + '</label>'; });
          painel.querySelectorAll("input[name='commodity-comparada']").forEach(function (input) { input.addEventListener("change", function () { painel.querySelector(".comparativo-vazio").hidden = painel.querySelectorAll("input:checked").length > 0; renderizarComparativo(painel); }); });
          painel.querySelector(".comparativo-serie").addEventListener("change", function () { renderizarComparativo(painel); });
          painel.querySelector(".comparativo-periodo").addEventListener("change", function () { renderizarComparativo(painel); });
          painel.querySelector(".comparativo-limpar").addEventListener("click", function () { painel.querySelectorAll("input:checked").forEach(function (input) { input.checked = false; }); painel.querySelector(".comparativo-vazio").hidden = false; renderizarComparativo(painel); });
          painel.querySelector(".comparativo-exportar").addEventListener("click", function () {
            var svgAlvo = painel.querySelector(".comparativo-svg");
            if (!svgAlvo || !svgAlvo.querySelector("path, rect")) return;
            var periodoTexto = painel.querySelector(".comparativo-periodo").selectedOptions[0].textContent;
            var serieTexto = painel.querySelector(".comparativo-serie").selectedOptions[0].textContent;
            var itensLegenda = Array.from(painel.querySelectorAll(".comparativo-legenda span")).map(function (s) { return s.textContent; });
            exportarSvgComoPdf(svgAlvo, {
              titulo: "Evolução comparada — " + serieTexto,
              subtitulo: "Período: " + periodoTexto + " · " + itensLegenda.join(" · "),
              nomeArquivo: "comparativo-commodities.pdf"
            });
          });
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
        var chartBox = botao.closest(".chart-box");
        var svgAlvo = chartBox ? svgGraficoPrincipalAtivo(chartBox) : null;
        if (!svgAlvo) { window.print(); return; }
        var wrap = svgAlvo.closest(".chart-wrap");
        var slug = wrap ? wrap.dataset.slug : "";
        exportarSvgComoPdf(svgAlvo, {
          titulo: (NOMES_COMMODITY[slug] || slug || "Commodity") + " — Histórico de preço",
          subtitulo: svgAlvo.getAttribute("aria-label") || "",
          nomeArquivo: "grafico-" + (slug || "commodity") + ".pdf"
        });
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
