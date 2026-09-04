/*
 * AgroFer Trader - Calculadora de Break-even/Margem
 * =====================================================
 * Lógica da calculadora descrita em
 * agrofer-breakeven-e-pivo-regional-spec.md (Parte 2). O servidor
 * (gerar_calculadora.py) só busca e embute os dados de entrada (preço
 * físico de hoje, vencimentos de futuro já em R$, produtividade média
 * regional) - toda a conta roda aqui, ao vivo, conforme o produtor
 * preenche os campos.
 *
 * Carregado só na página /calculadora/ (script próprio, não faz parte
 * de interatividade.js porque não é usado em nenhuma outra página).
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------
  // Dados embutidos pelo servidor
  // -------------------------------------------------------------------

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

  var DADOS = obterDadosCalculadora();

  // -------------------------------------------------------------------
  // Subcategorias pré-cadastradas (spec, seção 2) - nome livre também
  // pode ser adicionado via "+ Adicionar subcategoria".
  // -------------------------------------------------------------------

  var SUBCATEGORIAS_FIXAS_PADRAO = [
    "Arrendamento/aluguel da terra",
    "Depreciação de máquinas e equipamentos",
    "Mão de obra fixa (salários + encargos)",
    "Seguro rural",
    "Manutenção de benfeitorias/infraestrutura",
    "ITR e outros impostos fixos",
  ];

  var SUBCATEGORIAS_VARIAVEIS_PADRAO = [
    "Sementes",
    "Fertilizantes/adubos",
    "Defensivos (herbicida, inseticida, fungicida)",
    "Combustível/diesel",
    "Mão de obra temporária/diarista",
    "Colheita (frete de colheitadeira terceirizada, se aplicável)",
    "Frete/transporte da produção",
    "Secagem e armazenagem",
  ];

  // -------------------------------------------------------------------
  // Utilitários de número/data (mesmo padrão de interatividade.js)
  // -------------------------------------------------------------------

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
    // "Janeiro/2027" ou "Outubro/26"
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

  function formatarVencimento(texto) {
    return texto;
  }

  // Acha o vencimento igual ou posterior à data-alvo mais PRÓXIMO dela
  // (spec, seção 3). Se nenhum vencimento disponível chegar até a
  // data-alvo, usa o mais distante disponível como melhor alternativa,
  // sinalizando isso no texto exibido (nunca finge que é uma previsão).
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
  // Estado
  // -------------------------------------------------------------------

  var estado = {
    cultura: null,
    fixos: [],
    variaveis: [],
    pessoaJuridica: false,
    precoEditadoManualmente: false,
    precoMercadoReferencia: null, // valor do vencimento B3 usado para pré-preencher o preço (diagnóstico 2)
    vencimentoReferencia: null,
  };

  var elCorpo = document.querySelector(".calc-corpo");
  var elResultado = document.getElementById("calc-resultado");

  // -------------------------------------------------------------------
  // Subcategorias: renderização + adicionar/remover + subtotal
  // -------------------------------------------------------------------

  function criarLinhaSubcategoria(lista, item, container) {
    var linha = document.createElement("div");
    linha.className = "calc-subcategoria-linha";

    var nomeInput = document.createElement("input");
    nomeInput.type = "text";
    nomeInput.value = item.nome;
    nomeInput.disabled = !!item.padrao;
    nomeInput.setAttribute("aria-label", "Nome da subcategoria");
    nomeInput.addEventListener("input", function () { item.nome = nomeInput.value; recalcular(); });

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
      recalcularSubtotais();
      recalcular();
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
      recalcularSubtotais();
      recalcular();
    });

    linha.appendChild(nomeInput);
    linha.appendChild(prefixo);
    linha.appendChild(valorInput);
    linha.appendChild(remover);
    container.appendChild(linha);
  }

  function iniciarSubcategorias(lista, nomesPadrao, containerId, botaoSeletor, subtotalId) {
    var container = document.getElementById(containerId);
    nomesPadrao.forEach(function (nome) {
      var item = { nome: nome, valor: null, padrao: true };
      lista.push(item);
      criarLinhaSubcategoria(lista, item, container);
    });

    var botao = document.querySelector(botaoSeletor);
    botao.addEventListener("click", function () {
      var item = { nome: "", valor: null, padrao: false };
      lista.push(item);
      criarLinhaSubcategoria(lista, item, container);
    });
  }

  function recalcularSubtotais() {
    var somaFixos = estado.fixos.reduce(function (s, i) { return s + (parseFloat(i.valor) || 0); }, 0);
    var somaVariaveis = estado.variaveis.reduce(function (s, i) { return s + (parseFloat(i.valor) || 0); }, 0);
    document.getElementById("calc-fixos-subtotal").textContent = formatarBRL(somaFixos);
    document.getElementById("calc-variaveis-subtotal").textContent = formatarBRL(somaVariaveis);
  }

  // -------------------------------------------------------------------
  // Preço de venda: pré-preenchido pelo vencimento mais próximo da data
  // de venda pretendida (spec, seção 3) - nunca chamado de "previsão".
  // -------------------------------------------------------------------

  function atualizarPrecoSugerido() {
    var dadosCultura = DADOS.culturas[estado.cultura];
    var meses = parseFloat(document.getElementById("calc-meses").value) || 0;
    var dataAlvo = new Date();
    dataAlvo.setMonth(dataAlvo.getMonth() + Math.round(meses));

    var escolhido = acharVencimentoMaisProximo(dadosCultura.vencimentos, dataAlvo);
    var elFonte = document.getElementById("calc-preco-fonte-texto");
    var elPreco = document.getElementById("calc-preco");

    if (escolhido) {
      var textoAlcance = escolhido.foraDoAlcance
        ? " (não há vencimento até essa data ainda listado - usando o mais distante disponível)"
        : "";
      elFonte.textContent =
        "Preço de referência para o vencimento de " + formatarVencimento(escolhido.vencimento) + textoAlcance +
        " — o que você poderia travar hoje via contrato futuro ou a termo. Não é uma previsão do preço nessa data, " +
        "é o valor negociável agora para entrega futura. Você pode substituir pelo seu próprio número abaixo.";
      if (!estado.precoEditadoManualmente) {
        elPreco.value = escolhido.valor_reais.toFixed(2);
      }
      estado.precoMercadoReferencia = escolhido.valor_reais;
      estado.vencimentoReferencia = formatarVencimento(escolhido.vencimento);
    } else if (dadosCultura.preco_fisico_hoje) {
      elFonte.textContent =
        "Sem cotação de futuro disponível no momento para essa cultura - usando o preço físico de hoje como referência " +
        "(" + formatarBRL(dadosCultura.preco_fisico_hoje) + "/saca). Ajuste abaixo se preferir simular outro cenário.";
      if (!estado.precoEditadoManualmente) {
        elPreco.value = dadosCultura.preco_fisico_hoje.toFixed(2);
      }
      // Preço físico de hoje não tem "vencimento" - diagnóstico 2 (spec 9.2)
      // só faz sentido comparando com um vencimento de contrato futuro.
      estado.precoMercadoReferencia = null;
      estado.vencimentoReferencia = null;
    } else {
      elFonte.textContent = "Sem preço de referência disponível no momento - informe o valor que deseja simular.";
      estado.precoMercadoReferencia = null;
      estado.vencimentoReferencia = null;
    }
    recalcular();
  }

  // -------------------------------------------------------------------
  // Cálculo (fórmulas da spec, seção 4)
  // -------------------------------------------------------------------

  function calcular() {
    var hectares = parseFloat(document.getElementById("calc-hectares").value);
    var produtividade = parseFloat(document.getElementById("calc-produtividade").value);
    var precoVenda = parseFloat(document.getElementById("calc-preco").value);

    if (!hectares || hectares <= 0 || !produtividade || produtividade <= 0) return null;

    var somaFixos = estado.fixos.reduce(function (s, i) { return s + (parseFloat(i.valor) || 0); }, 0);
    var somaVariaveis = estado.variaveis.reduce(function (s, i) { return s + (parseFloat(i.valor) || 0); }, 0);

    var custoFixoHa = somaFixos / hectares;
    var custoVariavelHa = somaVariaveis / hectares;
    var custoTotalHa = custoFixoHa + custoVariavelHa;
    var breakEven = custoTotalHa / produtividade;

    var custoVariavelUnitario = custoVariavelHa / produtividade;
    var precoVal = precoVenda || 0;
    var margemContribuicao = precoVal - custoVariavelUnitario;
    var margemBruta = precoVal - breakEven;

    var sacasTotais = hectares * produtividade;
    var aliquota = DADOS.aliquota_funrural[estado.pessoaJuridica ? "pessoa_juridica" : "pessoa_fisica"];
    var receitaBrutaTotal = precoVal * sacasTotais;
    var funruralTotal = receitaBrutaTotal * aliquota;
    var receitaLiquidaTotal = receitaBrutaTotal - funruralTotal;
    var lucroLiquidoTotal = receitaLiquidaTotal - (custoTotalHa * hectares);
    var lucroLiquidoSaca = sacasTotais > 0 ? lucroLiquidoTotal / sacasTotais : 0;

    return {
      breakEven: breakEven, margemContribuicao: margemContribuicao, margemBruta: margemBruta,
      lucroLiquidoSaca: lucroLiquidoSaca, lucroLiquidoTotal: lucroLiquidoTotal,
      precoVenda: precoVal, somaFixos: somaFixos, somaVariaveis: somaVariaveis,
      sacasTotais: sacasTotais, receitaBrutaTotal: receitaBrutaTotal, receitaLiquidaTotal: receitaLiquidaTotal,
      hectares: hectares, produtividade: produtividade,
    };
  }

  // Paragrafo-resumo em linguagem corrida, feedback direto de um piloto
  // real (safra do irmao, milho, 4ha): os 4 cartoes tecnicos sozinhos,
  // sem narrativa, deixaram o produtor confuso - em especial porque
  // "ganho marginal" (margem de contribuicao) e numericamente MAIOR que
  // "ganho real bruto" (margem apos ratear o custo fixo), o que parece
  // contraditorio sem explicacao. Esse resumo vem ANTES dos cartoes
  // tecnicos (que passam a ser so o "detalhamento"), com destaque visual
  // maior - e o elemento mais importante da tela de resultado.
  function montarResumo(resultado) {
    var nomeCultura = (DADOS.culturas[estado.cultura].nome || estado.cultura).toLowerCase();
    var sacasTotaisFmt = Math.round(resultado.sacasTotais).toLocaleString("pt-BR");
    var custoTotalTotal = resultado.somaFixos + resultado.somaVariaveis;

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

  // Diagnóstico (spec, seção 9.2) - tópicos curtos, cada um comparando dois
  // números (o que o produtor informou vs. um referencial). Sempre fato e
  // aritmética, nunca causa especulada - mesma regra editorial da seção 4.1.
  // Fica sempre visível, no mesmo nível de destaque do resumo (não é um
  // tooltip escondido, ao contrário das explicações de conceito da 9.3).
  function montarDiagnostico(resultado) {
    var itens = [];

    // Diagnóstico 1 - produtividade mínima ao preço informado (sempre exibido).
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

    // Diagnóstico 2 - só exibido se o produtor sobrescreveu o preço sugerido
    // pelo feed B3 (se manteve o valor de mercado, comparar seria redundante).
    if (estado.precoEditadoManualmente && estado.precoMercadoReferencia) {
      var diferencaValor = resultado.precoVenda - estado.precoMercadoReferencia;
      var diferencaPct = Math.abs((diferencaValor / estado.precoMercadoReferencia) * 100);
      itens.push(
        "O mercado (B3) projeta " + formatarBRL(estado.precoMercadoReferencia) + "/saca para entrega em " +
        estado.vencimentoReferencia + ", enquanto você projetou vender a " + formatarBRL(resultado.precoVenda) +
        " — uma diferença de " + formatarBRL(Math.abs(diferencaValor)) + " (" + diferencaPct.toFixed(1).replace(".", ",") + "%) " +
        (diferencaValor >= 0 ? "acima" : "abaixo") + " do que o mercado sinaliza para essa data."
      );
    }

    // Diagnóstico 3 (benchmark regional) fica para a Fase 2, quando houver
    // volume mínimo de produtores cadastrados (spec, seção 4.1) - não
    // implementado ainda.

    return itens;
  }

  function recalcular() {
    var resultado = calcular();
    if (!resultado) {
      elResultado.hidden = true;
      return;
    }
    elResultado.hidden = false;

    var resumo = montarResumo(resultado);
    var elResumo = document.getElementById("calc-resumo");
    elResumo.textContent = resumo.html;
    elResumo.className = "calc-resumo" + (resumo.alerta ? " alerta" : "");

    var elDiagnostico = document.getElementById("calc-diagnostico");
    elDiagnostico.innerHTML = "";
    montarDiagnostico(resultado).forEach(function (texto) {
      var item = document.createElement("p");
      item.className = "calc-diagnostico-item";
      item.textContent = texto;
      elDiagnostico.appendChild(item);
    });

    document.getElementById("calc-break-even").textContent = formatarBRL(resultado.breakEven);
    var elMargemContrib = document.getElementById("calc-margem-contribuicao");
    elMargemContrib.textContent = formatarBRL(resultado.margemContribuicao);
    elMargemContrib.className = "calc-resultado-valor " + (resultado.margemContribuicao >= 0 ? "up" : "down");

    var elMargemBruta = document.getElementById("calc-margem-bruta");
    elMargemBruta.textContent = formatarBRL(resultado.margemBruta);
    elMargemBruta.className = "calc-resultado-valor " + (resultado.margemBruta >= 0 ? "up" : "down");

    var elLucroSaca = document.getElementById("calc-lucro-liquido-saca");
    elLucroSaca.textContent = formatarBRL(resultado.lucroLiquidoSaca);
    elLucroSaca.className = "calc-resultado-valor " + (resultado.lucroLiquidoSaca >= 0 ? "up" : "down");

    var elLucroTotal = document.getElementById("calc-lucro-liquido-total");
    elLucroTotal.textContent = formatarBRL(resultado.lucroLiquidoTotal);
    elLucroTotal.className = "calc-resultado-valor " + (resultado.lucroLiquidoTotal >= 0 ? "up" : "down");

    atualizarComposicaoCusto(resultado);
  }

  function atualizarComposicaoCusto(resultado) {
    var container = document.getElementById("calc-composicao-lista");
    container.innerHTML = "";
    var todas = estado.fixos.concat(estado.variaveis)
      .map(function (i) { return { nome: i.nome || "(sem nome)", valor: parseFloat(i.valor) || 0 }; })
      .filter(function (i) { return i.valor > 0; });
    var total = resultado.somaFixos + resultado.somaVariaveis;
    if (!todas.length || total <= 0) return;

    todas.sort(function (a, b) { return b.valor - a.valor; });
    todas.forEach(function (item) {
      var pct = (item.valor / total) * 100;
      var linha = document.createElement("div");
      linha.className = "calc-composicao-linha";
      linha.innerHTML =
        '<span class="calc-composicao-nome" title="' + item.nome.replace(/"/g, "&quot;") + '">' + item.nome + "</span>" +
        '<span class="calc-composicao-barra-fundo"><span class="calc-composicao-barra" style="width:' + pct.toFixed(1) + '%"></span></span>' +
        '<span class="calc-composicao-pct">' + pct.toFixed(1).replace(".", ",") + "%</span>";
      container.appendChild(linha);
    });
  }

  // -------------------------------------------------------------------
  // Salvar/carregar histórico (spec, seção 4.1) - identificação leve por
  // e-mail, sem senha, num Google Sheet via Apps Script (endpoint
  // configurado do lado do servidor, ver gerar_calculadora.py). Se a URL
  // não estiver configurada, essa seção inteira fica escondida - o
  // cálculo e o PDF continuam funcionando normalmente sem depender disso.
  //
  // Regra editorial da spec: a leitura automatizada só descreve O QUE e
  // O QUANTO mudou (fato, aritmética) - nunca o PORQUÊ. Por isso a
  // "Evolução" abaixo é só uma lista de deltas, sem nenhuma tentativa de
  // explicar a causa da variação.
  // -------------------------------------------------------------------

  var CHAVE_EMAIL_LOCAL = "agrofer_calc_email";
  var historicoCarregado = null; // cache do historico (todas as culturas) do e-mail atual

  function emailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function montarPayloadHistorico(resultado) {
    return {
      email: document.getElementById("calc-email").value.trim(),
      cultura: estado.cultura,
      hectares: parseFloat(document.getElementById("calc-hectares").value) || 0,
      produtividade_ha: parseFloat(document.getElementById("calc-produtividade").value) || 0,
      custo_fixo_total: resultado.somaFixos,
      custo_variavel_total: resultado.somaVariaveis,
      subcategorias_fixas: estado.fixos.map(function (i) { return { nome: i.nome, valor: parseFloat(i.valor) || 0 }; }),
      subcategorias_variaveis: estado.variaveis.map(function (i) { return { nome: i.nome, valor: parseFloat(i.valor) || 0 }; }),
      preco_venda: resultado.precoVenda,
      meses_ate_venda: parseFloat(document.getElementById("calc-meses").value) || 0,
      pessoa_juridica: estado.pessoaJuridica,
      break_even: resultado.breakEven,
      margem_contribuicao: resultado.margemContribuicao,
      margem_bruta: resultado.margemBruta,
      lucro_liquido_saca: resultado.lucroLiquidoSaca,
      lucro_liquido_total: resultado.lucroLiquidoTotal,
    };
  }

  function buscarHistorico(email, callback) {
    if (!DADOS.url_persistencia || !email) { callback([]); return; }
    var xhr = new XMLHttpRequest();
    xhr.open("GET", DADOS.url_persistencia + "?email=" + encodeURIComponent(email), true);
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

  function salvarHistorico(resultado) {
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
    if (!DADOS.url_persistencia) {
      status.textContent = "Recurso de salvar histórico indisponível no momento.";
      status.className = "calc-historico-status erro";
      return;
    }

    status.textContent = "Salvando...";
    status.className = "calc-historico-status";

    var xhr = new XMLHttpRequest();
    xhr.open("POST", DADOS.url_persistencia, true);
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8"); // evita preflight CORS no Apps Script
    xhr.onload = function () {
      status.textContent = "Cálculo salvo. Na próxima vez, informe o mesmo e-mail para ver a evolução.";
      status.className = "calc-historico-status ok";
      localStorage.setItem(CHAVE_EMAIL_LOCAL, email);
      buscarHistorico(email, function (historico) {
        historicoCarregado = historico;
        renderizarEvolucao();
      });
    };
    xhr.onerror = function () {
      status.textContent = "Não foi possível salvar agora - tente de novo em instantes.";
      status.className = "calc-historico-status erro";
    };
    xhr.send(JSON.stringify(montarPayloadHistorico(resultado)));
  }

  function renderizarEvolucao() {
    var elEvolucao = document.getElementById("calc-evolucao");
    var elLista = document.getElementById("calc-evolucao-lista");
    if (!historicoCarregado || !historicoCarregado.length) { elEvolucao.hidden = true; return; }

    var daCultura = historicoCarregado
      .filter(function (r) { return r.cultura === estado.cultura; })
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

  function iniciarHistorico() {
    if (!document.getElementById("calc-historico-secao")) return;
    document.getElementById("calc-historico-secao").hidden = !DADOS.url_persistencia;
    if (!DADOS.url_persistencia) return;

    var emailSalvo = localStorage.getItem(CHAVE_EMAIL_LOCAL);
    if (emailSalvo) {
      document.getElementById("calc-email").value = emailSalvo;
      document.getElementById("calc-consentimento").checked = true;
      buscarHistorico(emailSalvo, function (historico) {
        historicoCarregado = historico;
        renderizarEvolucao();
      });
    }

    document.getElementById("calc-salvar-historico").addEventListener("click", function () {
      var resultado = calcular();
      if (!resultado) {
        document.getElementById("calc-historico-status").textContent = "Preencha hectares, produtividade e preço antes de salvar.";
        document.getElementById("calc-historico-status").className = "calc-historico-status erro";
        return;
      }
      salvarHistorico(resultado);
    });
  }

  // -------------------------------------------------------------------
  // Exportar PDF (jsPDF - mesma biblioteca já usada nos gráficos de
  // histórico de preço)
  // -------------------------------------------------------------------

  function exportarPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) { window.print(); return; }
    var resultado = calcular();
    if (!resultado) return;

    var JsPdf = window.jspdf.jsPDF;
    var doc = new JsPdf({ orientation: "p", unit: "pt", format: "a4" });
    var margem = 48, y = margem;
    var nomeCultura = DADOS.culturas[estado.cultura].nome;

    doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(11, 60, 31);
    doc.text("Calculadora de Break-even — " + nomeCultura, margem, y); y += 22;
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
    linha("Hectares", document.getElementById("calc-hectares").value || "—");
    linha("Produtividade (sacas/ha)", document.getElementById("calc-produtividade").value || "—");
    linha("Custos fixos (total)", formatarBRL(resultado.somaFixos));
    linha("Custos variáveis (total)", formatarBRL(resultado.somaVariaveis));
    linha("Preço de venda (R$/saca)", formatarBRL(resultado.precoVenda));
    linha("Pessoa", estado.pessoaJuridica ? "Jurídica" : "Física");
    y += 12;

    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("Resultado", margem, y); y += 20;
    linha("Break-even (preço mínimo/saca)", formatarBRL(resultado.breakEven));
    linha("Ganho marginal/saca", formatarBRL(resultado.margemContribuicao));
    linha("Ganho real bruto/saca", formatarBRL(resultado.margemBruta));
    linha("Ganho real líquido/saca", formatarBRL(resultado.lucroLiquidoSaca));
    linha("Resultado total da safra (líquido)", formatarBRL(resultado.lucroLiquidoTotal));

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

    doc.save("break-even-" + estado.cultura + ".pdf");
  }

  // -------------------------------------------------------------------
  // Inicialização
  // -------------------------------------------------------------------

  function escolherCultura(slug) {
    estado.cultura = slug;
    document.querySelectorAll(".calc-cultura-btn").forEach(function (b) {
      var ativo = b.dataset.cultura === slug;
      b.classList.toggle("active", ativo);
    });
    elCorpo.hidden = false;

    var dadosCultura = DADOS.culturas[slug];
    var elApoio = document.getElementById("calc-produtividade-apoio");
    elApoio.textContent =
      "Média regional de " + String(dadosCultura.produtividade_media_sacas_ha).replace(".", ",") +
      " sacas/ha (" + dadosCultura.produtividade_fonte + ") - se você já sabe sua média das últimas safras, use ela, é mais precisa.";
    document.getElementById("calc-produtividade").value = dadosCultura.produtividade_media_sacas_ha;

    estado.precoEditadoManualmente = false;
    atualizarPrecoSugerido();
    renderizarEvolucao();
  }

  function iniciar() {
    if (!DADOS || !DADOS.culturas) return;

    document.querySelectorAll(".calc-cultura-btn").forEach(function (botao) {
      botao.addEventListener("click", function () { escolherCultura(botao.dataset.cultura); });
    });

    iniciarSubcategorias(estado.fixos, SUBCATEGORIAS_FIXAS_PADRAO, "calc-fixos-lista", '[data-tipo="fixos"]', "calc-fixos-subtotal");
    iniciarSubcategorias(estado.variaveis, SUBCATEGORIAS_VARIAVEIS_PADRAO, "calc-variaveis-lista", '[data-tipo="variaveis"]', "calc-variaveis-subtotal");
    recalcularSubtotais();

    document.getElementById("calc-hectares").addEventListener("input", recalcular);
    document.getElementById("calc-produtividade").addEventListener("input", recalcular);
    document.getElementById("calc-meses").addEventListener("input", atualizarPrecoSugerido);
    document.getElementById("calc-preco").addEventListener("input", function () {
      estado.precoEditadoManualmente = true;
      recalcular();
    });

    document.querySelectorAll(".calc-toggle-btn").forEach(function (botao) {
      botao.addEventListener("click", function () {
        document.querySelectorAll(".calc-toggle-btn").forEach(function (b) { b.classList.remove("active"); });
        botao.classList.add("active");
        estado.pessoaJuridica = botao.dataset.pessoa === "juridica";
        recalcular();
      });
    });

    document.getElementById("calc-exportar-pdf").addEventListener("click", exportarPdf);
    iniciarHistorico();

    // Cultura inicial: a que veio por ?cultura= (link do widget compacto
    // nas paginas de commodity - ver montar_calc_widget_html), ou soja
    // por padrao, pra pagina nao comecar em branco.
    var params = new URLSearchParams(window.location.search);
    var culturaUrl = params.get("cultura");
    escolherCultura(culturaUrl && DADOS.culturas[culturaUrl] ? culturaUrl : "soja");
  }

  document.addEventListener("DOMContentLoaded", iniciar);
})();
