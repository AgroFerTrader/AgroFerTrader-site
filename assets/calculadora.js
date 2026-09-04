/*
 * AgroFer Trader - Calculadora de Break-even/Margem (pagina principal)
 * =======================================================================
 * Modo A da spec (agrofer-breakeven-e-pivo-regional-spec.md, secao 11):
 * fluxo completo com preco de venda obrigatorio (pre-preenchido pelo
 * vencimento B3 mais proximo da data de venda pretendida). Este arquivo
 * so faz a amarracao com o DOM desta pagina - a formula de calculo, o
 * resumo narrativo, o diagnostico e as demais funcoes compartilhadas
 * estao em assets/calculadora-core.js (usado tambem pela pagina de
 * outros modos, /calculadora/outros-modos/), para nao duplicar a logica
 * em mais de um lugar.
 *
 * Carregado so na pagina /calculadora/ (calculadora-core.js precisa vir
 * antes deste script no HTML).
 */
(function () {
  "use strict";

  var Core = window.AgroFerCalc;
  var DADOS = Core.obterDadosCalculadora();

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
  var historicoCarregado = null;

  // -------------------------------------------------------------------
  // Preço de venda: pré-preenchido pelo vencimento mais próximo da data
  // de venda pretendida (spec, seção 3) - nunca chamado de "previsão".
  // -------------------------------------------------------------------

  function atualizarPrecoSugerido() {
    var dadosCultura = DADOS.culturas[estado.cultura];
    var meses = parseFloat(document.getElementById("calc-meses").value) || 0;
    var dataAlvo = new Date();
    dataAlvo.setMonth(dataAlvo.getMonth() + Math.round(meses));

    var escolhido = Core.acharVencimentoMaisProximo(dadosCultura.vencimentos, dataAlvo);
    var elFonte = document.getElementById("calc-preco-fonte-texto");
    var elPreco = document.getElementById("calc-preco");

    if (escolhido) {
      var textoAlcance = escolhido.foraDoAlcance
        ? " (não há vencimento até essa data ainda listado - usando o mais distante disponível)"
        : "";
      elFonte.textContent =
        "Preço de referência para o vencimento de " + escolhido.vencimento + textoAlcance +
        " — o que você poderia travar hoje via contrato futuro ou a termo. Não é uma previsão do preço nessa data, " +
        "é o valor negociável agora para entrega futura. Você pode substituir pelo seu próprio número abaixo.";
      if (!estado.precoEditadoManualmente) {
        elPreco.value = escolhido.valor_reais.toFixed(2);
      }
      estado.precoMercadoReferencia = escolhido.valor_reais;
      estado.vencimentoReferencia = escolhido.vencimento;
    } else if (dadosCultura.preco_fisico_hoje) {
      elFonte.textContent =
        "Sem cotação de futuro disponível no momento para essa cultura - usando o preço físico de hoje como referência " +
        "(" + Core.formatarBRL(dadosCultura.preco_fisico_hoje) + "/saca). Ajuste abaixo se preferir simular outro cenário.";
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
  // Cálculo + escrita do resultado na tela
  // -------------------------------------------------------------------

  function calcular() {
    var hectares = parseFloat(document.getElementById("calc-hectares").value);
    var produtividade = parseFloat(document.getElementById("calc-produtividade").value);
    var precoVenda = parseFloat(document.getElementById("calc-preco").value);

    var subtotais = Core.recalcularSubtotais(estado.fixos, estado.variaveis, "calc-fixos-subtotal", "calc-variaveis-subtotal");
    var aliquota = DADOS.aliquota_funrural[estado.pessoaJuridica ? "pessoa_juridica" : "pessoa_fisica"];

    return Core.calcular({
      hectares: hectares,
      produtividade: produtividade,
      temPreco: true,
      precoVenda: precoVenda,
      somaFixos: subtotais.somaFixos,
      somaVariaveis: subtotais.somaVariaveis,
      aliquotaFunrural: aliquota,
    });
  }

  function recalcular() {
    var resultado = calcular();
    if (!resultado) {
      elResultado.hidden = true;
      return;
    }
    elResultado.hidden = false;

    var nomeCultura = (DADOS.culturas[estado.cultura].nome || estado.cultura).toLowerCase();
    var resumo = Core.montarResumo(resultado, { nomeCultura: nomeCultura });
    var diagnostico = Core.montarDiagnostico(resultado, {
      precoEditadoManualmente: estado.precoEditadoManualmente,
      precoMercadoReferencia: estado.precoMercadoReferencia,
      vencimentoReferencia: estado.vencimentoReferencia,
    });
    Core.renderizarResultado(resultado, resumo, diagnostico);
    Core.atualizarComposicaoCusto(resultado, estado.fixos, estado.variaveis, "calc-composicao-lista");
  }

  // -------------------------------------------------------------------
  // Exportar PDF
  // -------------------------------------------------------------------

  function exportarPdf() {
    var resultado = calcular();
    if (!resultado) return;
    Core.exportarPdf(resultado, {
      nomeCultura: DADOS.culturas[estado.cultura].nome,
      culturaSlug: estado.cultura,
      pessoaJuridica: estado.pessoaJuridica,
    });
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
    Core.renderizarEvolucao(historicoCarregado, estado.cultura);
  }

  function iniciar() {
    if (!DADOS || !DADOS.culturas) return;

    document.querySelectorAll(".calc-cultura-btn").forEach(function (botao) {
      botao.addEventListener("click", function () { escolherCultura(botao.dataset.cultura); });
    });

    Core.iniciarSubcategorias(estado.fixos, SUBCATEGORIAS_FIXAS_PADRAO, "calc-fixos-lista", '[data-tipo="fixos"]', recalcular);
    Core.iniciarSubcategorias(estado.variaveis, SUBCATEGORIAS_VARIAVEIS_PADRAO, "calc-variaveis-lista", '[data-tipo="variaveis"]', recalcular);
    Core.recalcularSubtotais(estado.fixos, estado.variaveis, "calc-fixos-subtotal", "calc-variaveis-subtotal");

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

    Core.iniciarHistorico(DADOS.url_persistencia, {
      cultura: estado.cultura,
      obterResultado: calcular,
      obterContexto: function () {
        return {
          cultura: estado.cultura,
          fixos: estado.fixos,
          variaveis: estado.variaveis,
          mesesAteVenda: parseFloat(document.getElementById("calc-meses").value) || 0,
          pessoaJuridica: estado.pessoaJuridica,
        };
      },
      aoCarregarHistorico: function (historico) {
        historicoCarregado = historico;
        Core.renderizarEvolucao(historicoCarregado, estado.cultura);
      },
    });

    // Cultura inicial: a que veio por ?cultura= (link do widget compacto
    // nas paginas de commodity - ver montar_calc_widget_html), ou soja
    // por padrao, pra pagina nao comecar em branco.
    var params = new URLSearchParams(window.location.search);
    var culturaUrl = params.get("cultura");
    escolherCultura(culturaUrl && DADOS.culturas[culturaUrl] ? culturaUrl : "soja");
  }

  document.addEventListener("DOMContentLoaded", iniciar);
})();
