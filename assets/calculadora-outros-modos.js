/*
 * AgroFer Trader - Calculadora, outros modos de entrada
 * =========================================================
 * Modos B e C da spec (agrofer-breakeven-e-pivo-regional-spec.md,
 * secao 11), na pagina /calculadora/outros-modos/ - acessada só por um
 * link discreto dentro da calculadora principal (Modo A, inalterada).
 *
 * Modo B ("só o preço mínimo que preciso vender"): hectares +
 * produtividade informada + custos -> só break-even, sem pedir preço.
 *
 * Modo C ("não sei minha produtividade"): hectares + preço já recebido
 * + receita total recebida -> produtividade calculada (sacas_totais =
 * receita/preço; produtividade = sacas_totais/hectares) -> mesma tela
 * de resultado completa do Modo A (break-even, margem, diagnóstico 1 -
 * sem diagnóstico 2, que depende de uma cotação B3 que não existe
 * neste fluxo, já que o preço aqui é histórico, não uma trava futura).
 *
 * A fórmula de cálculo em si (assets/calculadora-core.js) é a MESMA
 * dos três modos - este arquivo só decide, por modo, quais campos
 * pedir e quais elementos do resultado mostrar.
 */
(function () {
  "use strict";

  var Core = window.AgroFerCalc;
  var DADOS = Core.obterDadosCalculadora();

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

  var CARTOES_SOMENTE_MODO_C = [
    "calc-card-margem-contribuicao", "calc-card-margem-bruta", "calc-card-lucro-saca", "calc-card-lucro-total",
  ];

  var estado = {
    modo: null, // "B" ou "C"
    cultura: null,
    fixos: [],
    variaveis: [],
    pessoaJuridica: false,
  };

  var elResultado = document.getElementById("calc-resultado");
  var historicoCarregado = null;

  // -------------------------------------------------------------------
  // Modo C: descobrir produtividade a partir do que já foi vendido
  // -------------------------------------------------------------------

  function calcularProdutividadeDescoberta() {
    var hectares = parseFloat(document.getElementById("calc-hectares").value);
    var precoRecebido = parseFloat(document.getElementById("calc-preco-recebido").value);
    var receitaTotal = parseFloat(document.getElementById("calc-receita-total").value);
    var elTexto = document.getElementById("calc-produtividade-descoberta");

    if (!hectares || hectares <= 0 || !precoRecebido || precoRecebido <= 0 || !receitaTotal || receitaTotal <= 0) {
      elTexto.textContent = "";
      return null;
    }

    var sacasTotais = receitaTotal / precoRecebido;
    var produtividade = sacasTotais / hectares;
    elTexto.textContent =
      "Isso equivale a " + Math.round(sacasTotais).toLocaleString("pt-BR") + " sacas nesta safra — " +
      produtividade.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " sacas/ha.";
    return produtividade;
  }

  // -------------------------------------------------------------------
  // Cálculo + escrita do resultado na tela
  // -------------------------------------------------------------------

  function calcular() {
    var hectares = parseFloat(document.getElementById("calc-hectares").value);
    var produtividade, temPreco, precoVenda;

    if (estado.modo === "C") {
      produtividade = calcularProdutividadeDescoberta();
      precoVenda = parseFloat(document.getElementById("calc-preco-recebido").value);
      temPreco = true;
    } else {
      produtividade = parseFloat(document.getElementById("calc-produtividade").value);
      temPreco = false;
      precoVenda = 0;
    }

    var subtotais = Core.recalcularSubtotais(estado.fixos, estado.variaveis, "calc-fixos-subtotal", "calc-variaveis-subtotal");
    var aliquota = estado.modo === "C"
      ? DADOS.aliquota_funrural[estado.pessoaJuridica ? "pessoa_juridica" : "pessoa_fisica"]
      : 0;

    return Core.calcular({
      hectares: hectares, produtividade: produtividade, temPreco: temPreco, precoVenda: precoVenda,
      somaFixos: subtotais.somaFixos, somaVariaveis: subtotais.somaVariaveis, aliquotaFunrural: aliquota,
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
    // Sem referência de mercado B3 aqui: Modo B não tem preço nenhum, e
    // o preço do Modo C já é histórico (venda já feita), não uma trava
    // futura - o diagnóstico 2 (comparação com o vencimento B3) não se
    // aplica a nenhum dos dois.
    var diagnostico = Core.montarDiagnostico(resultado, null);
    Core.renderizarResultado(resultado, resumo, diagnostico);
    Core.atualizarComposicaoCusto(resultado, estado.fixos, estado.variaveis, "calc-composicao-lista");
  }

  function exportarPdf() {
    var resultado = calcular();
    if (!resultado) return;
    Core.exportarPdf(resultado, {
      nomeCultura: DADOS.culturas[estado.cultura].nome,
      culturaSlug: estado.cultura,
      pessoaJuridica: estado.pessoaJuridica,
      fixos: estado.fixos,
      variaveis: estado.variaveis,
    });
  }

  // -------------------------------------------------------------------
  // Alterna os elementos da tela conforme o modo (B ou C)
  // -------------------------------------------------------------------

  function aplicarModo() {
    var ehC = estado.modo === "C";
    document.getElementById("calc-secao-produtividade-b").hidden = ehC;
    document.getElementById("calc-secao-descobrir-c").hidden = !ehC;
    document.getElementById("calc-secao-pessoa-c").hidden = !ehC;
    CARTOES_SOMENTE_MODO_C.forEach(function (id) {
      document.getElementById(id).hidden = !ehC;
    });
    // "Salvar histórico" só faz sentido com resultado completo (margem
    // e lucro) - no Modo B (só break-even) fica sempre escondido, mesmo
    // com o endpoint de persistência configurado.
    document.getElementById("calc-historico-secao").hidden = ehC ? !DADOS.url_persistencia : true;
  }

  // -------------------------------------------------------------------
  // Inicialização
  // -------------------------------------------------------------------

  function escolherModo(modo) {
    estado.modo = modo;
    document.querySelectorAll(".calc-modo-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.modo === modo); });
    document.getElementById("calc-cultura-escolha").hidden = false;
    document.getElementById("calc-corpo").hidden = true;
    elResultado.hidden = true;
    estado.cultura = null;
    document.querySelectorAll(".calc-cultura-btn").forEach(function (b) { b.classList.remove("active"); });
  }

  function escolherCultura(slug) {
    estado.cultura = slug;
    document.querySelectorAll(".calc-cultura-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.cultura === slug); });
    document.getElementById("calc-corpo").hidden = false;
    aplicarModo();

    if (estado.modo === "B") {
      var dadosCultura = DADOS.culturas[slug];
      document.getElementById("calc-produtividade-apoio").textContent =
        "Média regional de " + String(dadosCultura.produtividade_media_sacas_ha).replace(".", ",") +
        " sacas/ha (" + dadosCultura.produtividade_fonte + ") - se você já sabe sua média das últimas safras, use ela, é mais precisa.";
      document.getElementById("calc-produtividade").value = dadosCultura.produtividade_media_sacas_ha;
    }

    recalcular();
    Core.renderizarEvolucao(historicoCarregado, estado.cultura);
  }

  function iniciar() {
    if (!DADOS || !DADOS.culturas) return;

    document.querySelectorAll(".calc-modo-btn").forEach(function (botao) {
      botao.addEventListener("click", function () { escolherModo(botao.dataset.modo); });
    });
    document.querySelectorAll(".calc-cultura-btn").forEach(function (botao) {
      botao.addEventListener("click", function () { escolherCultura(botao.dataset.cultura); });
    });

    Core.iniciarSubcategorias(estado.fixos, SUBCATEGORIAS_FIXAS_PADRAO, "calc-fixos-lista", '[data-tipo="fixos"]', recalcular);
    Core.iniciarSubcategorias(estado.variaveis, SUBCATEGORIAS_VARIAVEIS_PADRAO, "calc-variaveis-lista", '[data-tipo="variaveis"]', recalcular);
    Core.recalcularSubtotais(estado.fixos, estado.variaveis, "calc-fixos-subtotal", "calc-variaveis-subtotal");

    document.getElementById("calc-hectares").addEventListener("input", recalcular);
    document.getElementById("calc-produtividade").addEventListener("input", recalcular);
    document.getElementById("calc-preco-recebido").addEventListener("input", recalcular);
    document.getElementById("calc-receita-total").addEventListener("input", recalcular);

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
      obterResultado: calcular,
      obterContexto: function () {
        return { cultura: estado.cultura, fixos: estado.fixos, variaveis: estado.variaveis, mesesAteVenda: 0, pessoaJuridica: estado.pessoaJuridica };
      },
      aoCarregarHistorico: function (historico) {
        historicoCarregado = historico;
        Core.renderizarEvolucao(historicoCarregado, estado.cultura);
      },
    });
  }

  document.addEventListener("DOMContentLoaded", iniciar);
})();
