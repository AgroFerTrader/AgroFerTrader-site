/*
 * AgroFer Trader - Motor de calculo compartilhado da calculadora
 * =================================================================
 * Funcoes puras (formula de break-even/margem, resumo narrativo,
 * diagnostico) e utilitarios de DOM genericos (subcategorias,
 * composicao de custo, exportar PDF, salvar/carregar historico),
 * usados tanto pela calculadora principal (assets/calculadora.js,
 * pagina /calculadora/, Modo A - preco de venda obrigatorio) quanto
 * pelos modos adicionais (assets/calculadora-outros-modos.js, pagina
 * /calculadora/outros-modos/, Modos B e C).
 *
 * Existe para que a formula do break-even/margem (spec, secao 4) e o
 * calculo de Funrural fiquem escritos uma unica vez - uma correcao
 * futura (ex.: mudanca de aliquota) nao precisa ser replicada em mais
 * de um arquivo (spec, secao 11).
 *
 * Nao le nenhum campo de formulario diretamente (exceto os campos de
 * "salvar historico", que tem o MESMO id nas duas paginas) - cada
 * pagina le seus proprios inputs e passa os valores para as funcoes
 * daqui.
 */
(function () {
  "use strict";

  function obterDadosCalculadora() {
    var script = document.getElementById("dados-calculadora");
    if (!script) return null;
    try {
      var texto = script.textContent.replace(/<!--[\s\S]*?-->/g, "").trim();
      return JSON.parse(texto);
    } catch (e) {
      return null;
    }
  }

  function formatarBRL(numero) {
    if (numero === null || numero === undefined || isNaN(numero)) return "—";
    return "R$ " + numero.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var MESES_PT = {
    janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5,
    julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
  };

  function _semAcentos(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function parseVencimento(texto) {
    var partes = String(texto).split("/");
    if (partes.length !== 2) return null;
    var mes = MESES_PT[_semAcentos(partes[0].trim().toLowerCase())];
    if (mes === undefined) return null;
    var anoTxt = partes[1].trim();
    var ano = parseInt(anoTxt, 10);
    if (isNaN(ano)) return null;
    if (anoTxt.length === 2) ano += 2000;
    return new Date(ano, mes, 1);
  }

  // Acha o vencimento igual ou posterior a data-alvo mais PROXIMO dela
  // (spec, secao 3) - usado só pelo Modo A (preço travável via B3); os
  // Modos B/C não fazem essa busca (B não tem preço, C usa preço já
  // recebido no passado).
  function acharVencimentoMaisProximo(vencimentos, dataAlvo) {
    var candidatos = (vencimentos || [])
      .map(function (v) { return { v: v, data: parseVencimento(v.vencimento) }; })
      .filter(function (x) { return x.data && typeof x.v.valor_reais === "number"; });
    if (!candidatos.length) return null;

    var posteriores = candidatos.filter(function (x) { return x.data >= dataAlvo; });
    var usados = posteriores.length ? posteriores : candidatos;
    usados.sort(function (a, b) { return a.data - b.data; });
    var escolhido = usados[0];
    return { vencimento: escolhido.v.vencimento, valor_reais: escolhido.v.valor_reais, foraDoAlcance: !posteriores.length };
  }

  // -------------------------------------------------------------------
  // Calculo (formulas da spec, secao 4) - funcao pura, unica para os
  // tres modos (A, B e C): recebe produtividade e preco ja resolvidos
  // (informados ou calculados/omitidos por quem chama), nao le nada do
  // DOM. `temPreco: false` é o que o Modo B usa para pedir só o
  // break-even, sem envolver preço/margem/Funrural no resultado.
  // -------------------------------------------------------------------
  function calcular(inputs) {
    var hectares = inputs.hectares;
    var produtividade = inputs.produtividade;
    if (!hectares || hectares <= 0 || !produtividade || produtividade <= 0) return null;

    var somaFixos = inputs.somaFixos || 0;
    var somaVariaveis = inputs.somaVariaveis || 0;

    var custoFixoHa = somaFixos / hectares;
    var custoVariavelHa = somaVariaveis / hectares;
    var custoTotalHa = custoFixoHa + custoVariavelHa;
    var breakEven = custoTotalHa / produtividade;

    var temPreco = !!inputs.temPreco;
    var custoVariavelUnitario = custoVariavelHa / produtividade;
    var precoVal = temPreco ? (inputs.precoVenda || 0) : 0;
    var margemContribuicao = precoVal - custoVariavelUnitario;
    var margemBruta = precoVal - breakEven;

    var sacasTotais = hectares * produtividade;
    var aliquota = inputs.aliquotaFunrural || 0;
    var receitaBrutaTotal = precoVal * sacasTotais;
    var funruralTotal = receitaBrutaTotal * aliquota;
    var receitaLiquidaTotal = receitaBrutaTotal - funruralTotal;
    var lucroLiquidoTotal = receitaLiquidaTotal - (custoTotalHa * hectares);
    var lucroLiquidoSaca = sacasTotais > 0 ? lucroLiquidoTotal / sacasTotais : 0;

    return {
      temPreco: temPreco,
      breakEven: breakEven, margemContribuicao: margemContribuicao, margemBruta: margemBruta,
      lucroLiquidoSaca: lucroLiquidoSaca, lucroLiquidoTotal: lucroLiquidoTotal,
      precoVenda: precoVal, somaFixos: somaFixos, somaVariaveis: somaVariaveis,
      sacasTotais: sacasTotais, receitaBrutaTotal: receitaBrutaTotal, receitaLiquidaTotal: receitaLiquidaTotal,
      hectares: hectares, produtividade: produtividade,
    };
  }

  // Paragrafo-resumo (spec, secao 9.1) - feedback direto de um piloto
  // real (safra do irmao, milho, 4ha): os cartoes tecnicos sozinhos,
  // sem narrativa, deixaram o produtor confuso. Quando nao ha preco
  // (Modo B), para na frase do break-even - nao ha margem/receita pra
  // contar.
  function montarResumo(resultado, ctx) {
    var nomeCultura = ctx.nomeCultura;
    var sacasTotaisFmt = Math.round(resultado.sacasTotais).toLocaleString("pt-BR");
    var custoTotalTotal = resultado.somaFixos + resultado.somaVariaveis;

    if (!resultado.temPreco) {
      return {
        alerta: false,
        html:
          "Você plantou " + resultado.hectares.toLocaleString("pt-BR") + " hectares de " + nomeCultura +
          ", com produtividade esperada de " + resultado.produtividade.toLocaleString("pt-BR") + " sacas/ha — cerca de " +
          sacasTotaisFmt + " sacas nesta safra. Seus custos somam " + formatarBRL(custoTotalTotal) + " (" +
          formatarBRL(resultado.somaFixos) + " fixos + " + formatarBRL(resultado.somaVariaveis) + " variáveis). " +
          "Para não ter prejuízo, você precisa vender a pelo menos " + formatarBRL(resultado.breakEven) + " por saca.",
      };
    }

    if (resultado.precoVenda < resultado.breakEven) {
      var prejuizoTotal = Math.abs(resultado.lucroLiquidoTotal);
      var prejuizoSaca = Math.abs(resultado.lucroLiquidoSaca);
      return {
        alerta: true,
        html:
          "Atenção: ao preço de " + formatarBRL(resultado.precoVenda) + "/saca, você venderia abaixo do seu break-even de " +
          formatarBRL(resultado.breakEven) + " — isso resultaria em prejuízo de " + formatarBRL(prejuizoTotal) +
          " nesta safra (" + formatarBRL(prejuizoSaca) + " por saca). Considere renegociar o preço, reduzir custo ou " +
          "aguardar uma janela melhor antes de vender.",
      };
    }

    var qualificar = resultado.breakEven > 0 && (resultado.margemBruta / resultado.breakEven) < 0.10 ? "apertada" : "confortável";
    return {
      alerta: false,
      html:
        "Você plantou " + resultado.hectares.toLocaleString("pt-BR") + " hectares de " + nomeCultura +
        ", com produtividade esperada de " + resultado.produtividade.toLocaleString("pt-BR") + " sacas/ha — cerca de " +
        sacasTotaisFmt + " sacas nesta safra. Seus custos somam " + formatarBRL(custoTotalTotal) + " (" +
        formatarBRL(resultado.somaFixos) + " fixos + " + formatarBRL(resultado.somaVariaveis) + " variáveis). " +
        "Para não ter prejuízo, você precisa vender a pelo menos " + formatarBRL(resultado.breakEven) + " por saca. " +
        "Ao preço informado de " + formatarBRL(resultado.precoVenda) + "/saca, sua receita bruta seria " +
        formatarBRL(resultado.receitaBrutaTotal) + "; depois do Funrural, sobra " + formatarBRL(resultado.receitaLiquidaTotal) +
        " líquidos — dos quais " + formatarBRL(custoTotalTotal) + " cobrem seu custo, restando " +
        formatarBRL(resultado.lucroLiquidoTotal) + " de lucro líquido nesta safra (" + formatarBRL(resultado.lucroLiquidoSaca) +
        " por saca). Esse preço está " + formatarBRL(resultado.margemBruta) + " acima do seu break-even: uma margem " +
        qualificar + ".",
    };
  }

  // Diagnostico (spec, secao 9.2) - só chamado quando resultado.temPreco
  // (sem preço não há o que diagnosticar). `refMercado` é opcional -
  // só o Modo A (busca de vencimento B3) o preenche; o Modo C usa um
  // preço já recebido no passado, sem cotação de mercado pra comparar.
  function montarDiagnostico(resultado, refMercado) {
    var itens = [];
    if (!resultado.temPreco) return itens;

    var custoTotalHa = resultado.produtividade > 0 ? resultado.breakEven * resultado.produtividade : 0;
    if (resultado.precoVenda > 0) {
      var produtividadeMinima = custoTotalHa / resultado.precoVenda;
      var diferencaProdutividade = Math.abs(resultado.produtividade - produtividadeMinima);
      var produtividadeMinimaFmt = produtividadeMinima.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      var diferencaProdutividadeFmt = diferencaProdutividade.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      var produtividadeFmt = resultado.produtividade.toLocaleString("pt-BR");

      if (resultado.precoVenda < resultado.breakEven) {
        itens.push(
          "Para não ter prejuízo ao preço de " + formatarBRL(resultado.precoVenda) + "/saca, você precisaria produzir pelo menos " +
          produtividadeMinimaFmt + " sacas/ha — " + diferencaProdutividadeFmt + " sacas/ha a mais do que você informou (" +
          produtividadeFmt + ")."
        );
      } else {
        itens.push(
          "Sua produtividade de " + produtividadeFmt + " sacas/ha está " + diferencaProdutividadeFmt +
          " sacas/ha acima do mínimo necessário (" + produtividadeMinimaFmt + " sacas/ha) para não ter prejuízo a este preço."
        );
      }
    }

    if (refMercado && refMercado.precoEditadoManualmente && refMercado.precoMercadoReferencia) {
      var diferencaValor = resultado.precoVenda - refMercado.precoMercadoReferencia;
      var diferencaPct = Math.abs((diferencaValor / refMercado.precoMercadoReferencia) * 100);
      itens.push(
        "O mercado (B3) projeta " + formatarBRL(refMercado.precoMercadoReferencia) + "/saca para entrega em " +
        refMercado.vencimentoReferencia + ", enquanto você projetou vender a " + formatarBRL(resultado.precoVenda) +
        " — uma diferença de " + formatarBRL(Math.abs(diferencaValor)) + " (" + diferencaPct.toFixed(1).replace(".", ",") + "%) " +
        (diferencaValor >= 0 ? "acima" : "abaixo") + " do que o mercado sinaliza para essa data."
      );
    }

    // Diagnostico 3 (benchmark regional) fica para a Fase 2 - não implementado.

    return itens;
  }

  // Escreve resultado/resumo/diagnostico no DOM - cada elemento só é
  // tocado se existir na pagina atual (a pagina do Modo B, por exemplo,
  // nao tem os cartoes de margem/lucro, so o de break-even).
  function renderizarResultado(resultado, resumo, diagnosticoItens) {
    var elResumo = document.getElementById("calc-resumo");
    if (elResumo) {
      elResumo.textContent = resumo.html;
      elResumo.className = "calc-resumo" + (resumo.alerta ? " alerta" : "");
    }

    var elDiagnostico = document.getElementById("calc-diagnostico");
    if (elDiagnostico) {
      elDiagnostico.innerHTML = "";
      (diagnosticoItens || []).forEach(function (texto) {
        var item = document.createElement("p");
        item.className = "calc-diagnostico-item";
        item.textContent = texto;
        elDiagnostico.appendChild(item);
      });
      elDiagnostico.hidden = !diagnosticoItens || !diagnosticoItens.length;
    }

    function setCard(id, valor, comCor) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = formatarBRL(valor);
      if (comCor) el.className = "calc-resultado-valor " + (valor >= 0 ? "up" : "down");
    }
    setCard("calc-break-even", resultado.breakEven, false);
    setCard("calc-margem-contribuicao", resultado.margemContribuicao, true);
    setCard("calc-margem-bruta", resultado.margemBruta, true);
    setCard("calc-lucro-liquido-saca", resultado.lucroLiquidoSaca, true);
    setCard("calc-lucro-liquido-total", resultado.lucroLiquidoTotal, true);
  }

  // -------------------------------------------------------------------
  // Subcategorias de custo (spec, secao 2) - lista de {nome, valor},
  // com "+ Adicionar subcategoria" e subtotal ao vivo. Generico o
  // bastante (recebe os ids dos elementos) para ser usado nas duas
  // paginas sem duplicar este bloco.
  // -------------------------------------------------------------------

  function criarLinhaSubcategoria(lista, item, container, aoMudar) {
    var linha = document.createElement("div");
    linha.className = "calc-subcategoria-linha";

    var nomeInput = document.createElement("input");
    nomeInput.type = "text";
    nomeInput.value = item.nome;
    nomeInput.disabled = !!item.padrao;
    nomeInput.setAttribute("aria-label", "Nome da subcategoria");
    nomeInput.addEventListener("input", function () { item.nome = nomeInput.value; aoMudar(); });

    var prefixo = document.createElement("span");
    prefixo.className = "calc-valor-prefixo";
    prefixo.textContent = "R$";

    var valorInput = document.createElement("input");
    valorInput.type = "number";
    valorInput.min = "0";
    valorInput.step = "0.01";
    valorInput.inputMode = "decimal";
    valorInput.placeholder = "0,00";
    valorInput.setAttribute("aria-label", "Valor gasto em " + item.nome);
    valorInput.addEventListener("input", function () {
      item.valor = parseFloat(valorInput.value);
      aoMudar();
    });

    var remover = document.createElement("button");
    remover.type = "button";
    remover.className = "calc-remover";
    remover.innerHTML = "&times;";
    remover.setAttribute("aria-label", "Remover " + item.nome);
    remover.hidden = !!item.padrao;
    remover.addEventListener("click", function () {
      var indice = lista.indexOf(item);
      if (indice !== -1) lista.splice(indice, 1);
      linha.remove();
      aoMudar();
    });

    linha.appendChild(nomeInput);
    linha.appendChild(prefixo);
    linha.appendChild(valorInput);
    linha.appendChild(remover);
    container.appendChild(linha);
  }

  function iniciarSubcategorias(lista, nomesPadrao, containerId, botaoSeletor, aoMudar) {
    var container = document.getElementById(containerId);
    nomesPadrao.forEach(function (nome) {
      var item = { nome: nome, valor: null, padrao: true };
      lista.push(item);
      criarLinhaSubcategoria(lista, item, container, aoMudar);
    });

    var botao = document.querySelector(botaoSeletor);
    botao.addEventListener("click", function () {
      var item = { nome: "", valor: null, padrao: false };
      lista.push(item);
      criarLinhaSubcategoria(lista, item, container, aoMudar);
    });
  }

  function somarSubcategorias(lista) {
    return (lista || []).reduce(function (s, i) { return s + (parseFloat(i.valor) || 0); }, 0);
  }

  function recalcularSubtotais(fixos, variaveis, fixosSubtotalId, variaveisSubtotalId) {
    var somaFixos = somarSubcategorias(fixos);
    var somaVariaveis = somarSubcategorias(variaveis);
    var elF = document.getElementById(fixosSubtotalId);
    if (elF) elF.textContent = formatarBRL(somaFixos);
    var elV = document.getElementById(variaveisSubtotalId);
    if (elV) elV.textContent = formatarBRL(somaVariaveis);
    return { somaFixos: somaFixos, somaVariaveis: somaVariaveis };
  }

  // Cor fixa por subcategoria (spec, secao 12): a MESMA subcategoria
  // (ex.: "Fertilizantes/adubos") sempre cai na mesma cor, em qualquer
  // exportacao/safra, sem precisar guardar essa associacao em lugar
  // nenhum. As 14 subcategorias pre-cadastradas (SUBCATEGORIAS_*_PADRAO)
  // ganham cor explicita, garantindo que nunca colidem entre si no
  // mesmo grafico (o caso comum); subcategorias com nome livre, criadas
  // via "+ Adicionar subcategoria", caem num hash do nome sobre uma
  // paleta separada - determinístico, mas sem garantia de nunca colidir
  // com outra custom no mesmo grafico.
  var CORES_SUBCATEGORIAS_PADRAO = {
    "Arrendamento/aluguel da terra": "#4C7A1F",
    "Depreciação de máquinas e equipamentos": "#B08830",
    "Mão de obra fixa (salários + encargos)": "#9C3B2E",
    "Seguro rural": "#2F5D8A",
    "Manutenção de benfeitorias/infraestrutura": "#7A4C9C",
    "ITR e outros impostos fixos": "#1F7A6B",
    "Sementes": "#C77B2E",
    "Fertilizantes/adubos": "#5A5A5A",
    "Defensivos (herbicida, inseticida, fungicida)": "#8A2F5D",
    "Combustível/diesel": "#2F8A5D",
    "Mão de obra temporária/diarista": "#8A6B2F",
    "Colheita (frete de colheitadeira terceirizada, se aplicável)": "#3B5D9C",
    "Frete/transporte da produção": "#9C2F6B",
    "Secagem e armazenagem": "#5D8A2F",
  };

  var PALETA_CORES_FALLBACK = [
    "#2F6B8A", "#8A4C2F", "#5D2F8A", "#2F8A8A", "#8A2F2F", "#6B8A2F",
    "#2F4C8A", "#8A6B5D", "#4C2F8A", "#2F8A6B", "#8A5D2F", "#3B2F8A",
  ];

  function corParaSubcategoria(nome) {
    var texto = String(nome || "");
    if (CORES_SUBCATEGORIAS_PADRAO[texto]) return CORES_SUBCATEGORIAS_PADRAO[texto];
    var hash = 0;
    for (var i = 0; i < texto.length; i++) {
      hash = (hash * 31 + texto.charCodeAt(i)) >>> 0;
    }
    return PALETA_CORES_FALLBACK[hash % PALETA_CORES_FALLBACK.length];
  }

  // Uma fatia por subcategoria preenchida - fixas E variaveis misturadas
  // num unico grafico (spec, secao 12), nao duas fatias agregadas nem
  // dois graficos separados. So omite subcategorias com valor R$0,00 -
  // se todas as fixas (ou todas as variaveis) forem zero, o grafico
  // simplesmente mostra só as outras, sem tratar isso como erro.
  function montarFatiasComposicao(fixos, variaveis) {
    var todas = (fixos || []).concat(variaveis || [])
      .map(function (i) { return { nome: i.nome || "(sem nome)", valor: parseFloat(i.valor) || 0 }; })
      .filter(function (i) { return i.valor > 0; });
    var total = todas.reduce(function (s, i) { return s + i.valor; }, 0);
    if (!todas.length || total <= 0) return [];

    todas.sort(function (a, b) { return b.valor - a.valor; });
    return todas.map(function (i) {
      return { nome: i.nome, valor: i.valor, pct: (i.valor / total) * 100, cor: corParaSubcategoria(i.nome) };
    });
  }

  function atualizarComposicaoCusto(resultado, fixos, variaveis, containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = "";
    montarFatiasComposicao(fixos, variaveis).forEach(function (fatia) {
      var linha = document.createElement("div");
      linha.className = "calc-composicao-linha";
      linha.innerHTML =
        '<span class="calc-composicao-nome" title="' + fatia.nome.replace(/"/g, "&quot;") + '">' + fatia.nome + "</span>" +
        '<span class="calc-composicao-barra-fundo"><span class="calc-composicao-barra" style="width:' + fatia.pct.toFixed(1) + '%"></span></span>' +
        '<span class="calc-composicao-pct">' + fatia.pct.toFixed(1).replace(".", ",") + "%</span>";
      container.appendChild(linha);
    });
  }

  // Desenha o grafico de pizza num <canvas> fora da tela e devolve como
  // imagem (data URL) - jsPDF nao tem primitiva nativa de fatia de
  // pizza, mas aceita imagem embutida via addImage.
  function desenharGraficoPizza(fatias, tamanhoPx) {
    var canvas = document.createElement("canvas");
    canvas.width = tamanhoPx;
    canvas.height = tamanhoPx;
    var ctx = canvas.getContext("2d");
    var cx = tamanhoPx / 2, cy = tamanhoPx / 2, raio = tamanhoPx / 2 - 4;
    var total = fatias.reduce(function (s, f) { return s + f.valor; }, 0);
    var anguloAtual = -Math.PI / 2;
    fatias.forEach(function (fatia) {
      var angulo = (fatia.valor / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, raio, anguloAtual, anguloAtual + angulo);
      ctx.closePath();
      ctx.fillStyle = fatia.cor;
      ctx.fill();
      anguloAtual += angulo;
    });
    return canvas.toDataURL("image/png");
  }

  function hexParaRgb(hex) {
    var limpo = String(hex).replace("#", "");
    return [parseInt(limpo.substr(0, 2), 16), parseInt(limpo.substr(2, 2), 16), parseInt(limpo.substr(4, 2), 16)];
  }

  // -------------------------------------------------------------------
  // Salvar/carregar historico (spec, secao 4.1) - identificacao leve por
  // e-mail, sem senha, num Google Sheet via Apps Script. Usado pelos
  // modos que produzem resultado completo (A e C) - o Modo B (só
  // break-even) esconde essa secao inteira na propria pagina, entao
  // estas funcoes nem sao chamadas nele.
  //
  // Regra editorial da spec: a leitura automatizada só descreve O QUE e
  // O QUANTO mudou (fato, aritmética) - nunca o PORQUÊ.
  // -------------------------------------------------------------------

  var CHAVE_EMAIL_LOCAL = "agrofer_calc_email";

  function emailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function montarPayloadHistorico(resultado, contexto) {
    return {
      email: document.getElementById("calc-email").value.trim(),
      cultura: contexto.cultura,
      hectares: resultado.hectares,
      produtividade_ha: resultado.produtividade,
      custo_fixo_total: resultado.somaFixos,
      custo_variavel_total: resultado.somaVariaveis,
      subcategorias_fixas: (contexto.fixos || []).map(function (i) { return { nome: i.nome, valor: parseFloat(i.valor) || 0 }; }),
      subcategorias_variaveis: (contexto.variaveis || []).map(function (i) { return { nome: i.nome, valor: parseFloat(i.valor) || 0 }; }),
      preco_venda: resultado.precoVenda,
      meses_ate_venda: contexto.mesesAteVenda || 0,
      pessoa_juridica: !!contexto.pessoaJuridica,
      break_even: resultado.breakEven,
      margem_contribuicao: resultado.margemContribuicao,
      margem_bruta: resultado.margemBruta,
      lucro_liquido_saca: resultado.lucroLiquidoSaca,
      lucro_liquido_total: resultado.lucroLiquidoTotal,
    };
  }

  function buscarHistorico(urlPersistencia, email, callback) {
    if (!urlPersistencia || !email) { callback([]); return; }
    var xhr = new XMLHttpRequest();
    xhr.open("GET", urlPersistencia + "?email=" + encodeURIComponent(email), true);
    xhr.onload = function () {
      try {
        var resposta = JSON.parse(xhr.responseText);
        callback(Array.isArray(resposta) ? resposta : []);
      } catch (e) {
        callback([]);
      }
    };
    xhr.onerror = function () { callback([]); };
    xhr.send();
  }

  function salvarHistorico(urlPersistencia, resultado, contexto, aposSalvar) {
    var status = document.getElementById("calc-historico-status");
    var email = document.getElementById("calc-email").value.trim();

    if (!emailValido(email)) {
      status.textContent = "Informe um e-mail válido.";
      status.className = "calc-historico-status erro";
      return;
    }
    if (!document.getElementById("calc-consentimento").checked) {
      status.textContent = "Marque a caixa de consentimento para salvar.";
      status.className = "calc-historico-status erro";
      return;
    }
    if (!urlPersistencia) {
      status.textContent = "Recurso de salvar histórico indisponível no momento.";
      status.className = "calc-historico-status erro";
      return;
    }

    status.textContent = "Salvando...";
    status.className = "calc-historico-status";

    var xhr = new XMLHttpRequest();
    xhr.open("POST", urlPersistencia, true);
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8"); // evita preflight CORS no Apps Script
    xhr.onload = function () {
      status.textContent = "Cálculo salvo. Na próxima vez, informe o mesmo e-mail para ver a evolução.";
      status.className = "calc-historico-status ok";
      localStorage.setItem(CHAVE_EMAIL_LOCAL, email);
      buscarHistorico(urlPersistencia, email, function (historico) {
        if (aposSalvar) aposSalvar(historico);
      });
    };
    xhr.onerror = function () {
      status.textContent = "Não foi possível salvar agora - tente de novo em instantes.";
      status.className = "calc-historico-status erro";
    };
    xhr.send(JSON.stringify(montarPayloadHistorico(resultado, contexto)));
  }

  function renderizarEvolucao(historicoCarregado, cultura) {
    var elEvolucao = document.getElementById("calc-evolucao");
    var elLista = document.getElementById("calc-evolucao-lista");
    if (!elEvolucao || !elLista) return;
    if (!historicoCarregado || !historicoCarregado.length) { elEvolucao.hidden = true; return; }

    var daCultura = historicoCarregado
      .filter(function (r) { return r.cultura === cultura; })
      .sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });

    if (daCultura.length < 2) { elEvolucao.hidden = true; return; }

    var atual = daCultura[0], anterior = daCultura[1];
    elLista.innerHTML = "";

    function linhaDelta(rotulo, valorAtual, valorAnterior) {
      if (!valorAnterior) return;
      var delta = ((valorAtual - valorAnterior) / valorAnterior) * 100;
      var classe = delta > 0.05 ? "up" : delta < -0.05 ? "down" : "";
      var seta = delta > 0.05 ? "▲" : delta < -0.05 ? "▼" : "→";
      var linha = document.createElement("div");
      linha.className = "calc-evolucao-linha";
      linha.innerHTML =
        "<span>" + rotulo + "</span>" +
        '<span class="' + classe + '">' + formatarBRL(valorAtual) + " " + seta + " " + Math.abs(delta).toFixed(1).replace(".", ",") + "%</span>";
      elLista.appendChild(linha);
    }

    linhaDelta("Break-even", parseFloat(atual.break_even), parseFloat(anterior.break_even));

    function subcategoriasPorNome(registro) {
      var mapa = {};
      ["subcategorias_fixas_json", "subcategorias_variaveis_json"].forEach(function (campo) {
        try {
          (JSON.parse(registro[campo] || "[]")).forEach(function (i) { if (i.nome) mapa[i.nome] = parseFloat(i.valor) || 0; });
        } catch (e) { /* ignora registro antigo/malformado */ }
      });
      return mapa;
    }

    var subAtual = subcategoriasPorNome(atual), subAnterior = subcategoriasPorNome(anterior);
    Object.keys(subAtual).forEach(function (nome) {
      if (subAnterior[nome] !== undefined && subAnterior[nome] > 0 && subAtual[nome] > 0) {
        linhaDelta(nome, subAtual[nome], subAnterior[nome]);
      }
    });

    elEvolucao.hidden = false;
  }

  function iniciarHistorico(urlPersistencia, opts) {
    // opts: {cultura, obterResultado, aoCarregarHistorico}
    if (!document.getElementById("calc-historico-secao")) return;
    document.getElementById("calc-historico-secao").hidden = !urlPersistencia;
    if (!urlPersistencia) return;

    var emailSalvo = localStorage.getItem(CHAVE_EMAIL_LOCAL);
    if (emailSalvo) {
      document.getElementById("calc-email").value = emailSalvo;
      document.getElementById("calc-consentimento").checked = true;
      buscarHistorico(urlPersistencia, emailSalvo, function (historico) {
        if (opts.aoCarregarHistorico) opts.aoCarregarHistorico(historico);
      });
    }

    document.getElementById("calc-salvar-historico").addEventListener("click", function () {
      var resultado = opts.obterResultado();
      if (!resultado) {
        document.getElementById("calc-historico-status").textContent = "Preencha hectares, produtividade e preço antes de salvar.";
        document.getElementById("calc-historico-status").className = "calc-historico-status erro";
        return;
      }
      salvarHistorico(urlPersistencia, resultado, opts.obterContexto(), function (historico) {
        if (opts.aoCarregarHistorico) opts.aoCarregarHistorico(historico);
      });
    });
  }

  // -------------------------------------------------------------------
  // Exportar PDF (jsPDF) - reaproveitado pelos modos com preço (A e C);
  // ctx.semPreco omite as linhas de margem/lucro (Modo B, se algum dia
  // ganhar exportação própria).
  // -------------------------------------------------------------------

  function exportarPdf(resultado, ctx) {
    if (!window.jspdf || !window.jspdf.jsPDF) { window.print(); return; }

    var JsPdf = window.jspdf.jsPDF;
    var doc = new JsPdf({ orientation: "p", unit: "pt", format: "a4" });
    var margem = 48, y = margem;

    doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(11, 60, 31);
    doc.text("Calculadora de Break-even — " + ctx.nomeCultura, margem, y); y += 22;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(90, 90, 90);
    doc.text("AgroFer Trader · " + new Date().toLocaleDateString("pt-BR"), margem, y); y += 30;

    function linha(rotulo, valor) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(11, 60, 31);
      doc.text(rotulo, margem, y);
      doc.setFont("helvetica", "bold");
      doc.text(valor, margem + 260, y);
      y += 20;
    }

    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("Entradas", margem, y); y += 20;
    linha("Hectares", resultado.hectares.toLocaleString("pt-BR"));
    linha("Produtividade (sacas/ha)", resultado.produtividade.toLocaleString("pt-BR"));
    linha("Custos fixos (total)", formatarBRL(resultado.somaFixos));
    linha("Custos variáveis (total)", formatarBRL(resultado.somaVariaveis));
    if (resultado.temPreco) {
      linha("Preço de venda (R$/saca)", formatarBRL(resultado.precoVenda));
      linha("Pessoa", ctx.pessoaJuridica ? "Jurídica" : "Física");
    }
    y += 12;

    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("Resultado", margem, y); y += 20;
    linha("Break-even (preço mínimo/saca)", formatarBRL(resultado.breakEven));
    if (resultado.temPreco) {
      linha("Ganho marginal/saca", formatarBRL(resultado.margemContribuicao));
      linha("Ganho real bruto/saca", formatarBRL(resultado.margemBruta));
      linha("Ganho real líquido/saca", formatarBRL(resultado.lucroLiquidoSaca));
      linha("Resultado total da safra (líquido)", formatarBRL(resultado.lucroLiquidoTotal));
    }

    // Gráfico de pizza da composição do custo (spec, seção 12) - uma
    // fatia por subcategoria preenchida, fixas e variáveis misturadas,
    // com cor fixa por nome (mesma cor em qualquer exportação).
    var fatias = montarFatiasComposicao(ctx.fixos, ctx.variaveis);
    if (fatias.length) {
      y += 16;
      if (y > 560) { doc.addPage(); y = margem; }
      doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(11, 60, 31);
      doc.text("Composição do custo", margem, y); y += 16;

      var tamanhoPx = 300, tamanhoPt = 130;
      var imagemPizza = desenharGraficoPizza(fatias, tamanhoPx);
      doc.addImage(imagemPizza, "PNG", margem, y, tamanhoPt, tamanhoPt);

      var legendaX = margem + tamanhoPt + 24;
      var legendaY = y + 6;
      fatias.forEach(function (fatia) {
        var rgb = hexParaRgb(fatia.cor);
        doc.setFillColor(rgb[0], rgb[1], rgb[2]);
        doc.rect(legendaX, legendaY - 7, 8, 8, "F");
        doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(11, 60, 31);
        doc.text(fatia.nome + " — " + fatia.pct.toFixed(1).replace(".", ",") + "%", legendaX + 13, legendaY);
        legendaY += 14;
      });

      y += tamanhoPt + 16;
    }

    y += 20;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(140, 140, 140);
    doc.text(
      doc.splitTextToSize(
        "Cálculo estimado a partir dos valores informados - não constitui recomendação de investimento ou negócio. " +
        "Confirme a alíquota de Funrural vigente com seu contador antes de decidir.",
        520
      ),
      margem, y
    );

    doc.save("break-even-" + ctx.culturaSlug + ".pdf");
  }

  window.AgroFerCalc = {
    obterDadosCalculadora: obterDadosCalculadora,
    formatarBRL: formatarBRL,
    parseVencimento: parseVencimento,
    acharVencimentoMaisProximo: acharVencimentoMaisProximo,
    calcular: calcular,
    montarResumo: montarResumo,
    montarDiagnostico: montarDiagnostico,
    renderizarResultado: renderizarResultado,
    iniciarSubcategorias: iniciarSubcategorias,
    somarSubcategorias: somarSubcategorias,
    recalcularSubtotais: recalcularSubtotais,
    atualizarComposicaoCusto: atualizarComposicaoCusto,
    corParaSubcategoria: corParaSubcategoria,
    montarFatiasComposicao: montarFatiasComposicao,
    desenharGraficoPizza: desenharGraficoPizza,
    emailValido: emailValido,
    buscarHistorico: buscarHistorico,
    salvarHistorico: salvarHistorico,
    renderizarEvolucao: renderizarEvolucao,
    iniciarHistorico: iniciarHistorico,
    exportarPdf: exportarPdf,
  };
})();
