# -*- coding: utf-8 -*-
"""
Gerar Paginas de Commodities - AgroFer Trader
===============================================
Gera/atualiza uma pagina individual por commodity (soja, milho, cafe,
boi-gordo), dentro de commodities/<slug>/index.html. Reaproveita os
mesmos dados que o monitor_agro_v9.py ja busca (via gerar_site.py) e o
historico salvo em dados/*.json (snapshots diarios que o gerar_site.py
ja grava) para montar o grafico de variacao.

NAO mexe no index.html principal (a home continua sendo gerada
separadamente pelo gerar_site.py, sem nenhuma mudanca).

Requisitos: os mesmos do monitor_agro_v9.py, mais este arquivo e
gerar_site.py no mesmo diretorio.

Uso diario (depois do gerar_site.py, para reaproveitar os mesmos dados
sem buscar tudo de novo):
    python gerar_site.py
    python gerar_paginas_commodities.py

IMPORTANTE - coisas que dependem do layout atual do Noticias Agricolas
e que eu (Claude) NAO consegui testar ao vivo (o ambiente onde rodo nao
tem acesso a esse dominio): a funcao buscar_noticias_por_categoria()
abaixo segue o mesmo padrao de scraping do buscar_noticias_agro() do
monitor_agro_v9.py (que voce ja confirmou que funciona), so mudando a
URL para a pagina de categoria de cada commodity. Rode uma vez manual
e confira a saida antes de automatizar - se algo vier vazio ou errado,
me mande o que apareceu que eu ajusto os seletores.
"""

import json
import os
import re
from datetime import datetime
from html import escape

import monitor_agro_v9 as monitor
import gerar_site as site

PASTA_SITE = os.path.dirname(os.path.abspath(__file__))
PASTA_COMMODITIES = os.path.join(PASTA_SITE, "commodities")
PASTA_TEMPLATE = os.path.join(PASTA_COMMODITIES, "_template.html")
PASTA_DADOS = os.path.join(PASTA_SITE, "dados")

# ---------------------------------------------------------------------------
# CONFIGURACAO: uma entrada por pagina individual de commodity.
#
# nome_fisica / nome_futuro precisam bater EXATAMENTE com o campo "nome"
# que monitor_agro_v9.py devolve em resultados_commodities / resultados_futuros
# (antes de qualquer split/limpeza visual) - e o que garante o filtro certo.
# categoria_noticias e o slug da pagina de categoria no Noticias Agricolas
# (ex: noticiasagricolas.com.br/noticias/cafe/).
# ---------------------------------------------------------------------------
COMMODITIES_PAGINAS = [
    {
        "slug": "soja",
        "nome_exibicao": "Soja",
        "nome_fisica": "Soja",
        "nome_futuro": "Soja Futuro (B3)",
        "categoria_noticias": "soja",
        # Praças regionais, em ordem de prioridade - ver
        # buscar_cotacoes_regionais_da_pagina() logo abaixo.
        "estados_regionais": ["MT", "PR", "MS", "RS"],
        "titulo_pagina": "Preço da Soja Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura da soja atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas do mercado de soja.",
        "headline": "Análise de Mercado — Soja",
    },
    {
        "slug": "milho",
        "nome_exibicao": "Milho",
        "nome_fisica": "Milho",
        "nome_futuro": "Milho Futuro (B3)",
        "categoria_noticias": "milho",
        "estados_regionais": ["MT", "PR", "GO", "MG"],
        "titulo_pagina": "Preço do Milho Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura do milho atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas do mercado de milho.",
        "headline": "Análise de Mercado — Milho",
    },
    {
        "slug": "cafe",
        "nome_exibicao": "Café Arábica",
        "nome_fisica": "Café Arábica",
        "nome_futuro": "Café Arábica Futuro (B3)",
        "categoria_noticias": "cafe",
        # Café usa fonte municipal dedicada, agrupada por praça cafeeira
        # (não por estado) - ver buscar_cotacoes_regionais_da_pagina().
        "titulo_pagina": "Preço do Café Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura do café arábica atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas do mercado de café.",
        "headline": "Análise de Mercado — Café",
    },
    {
        "slug": "boi-gordo",
        "nome_exibicao": "Boi Gordo",
        "nome_fisica": "Boi Gordo",
        "nome_futuro": "Boi Gordo Futuro (B3)",
        "categoria_noticias": "boi",
        "estados_regionais": ["SP", "MT", "BA", "GO"],
        "titulo_pagina": "Preço do Boi Gordo Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura do boi gordo atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas da pecuária de corte.",
        "headline": "Análise de Mercado — Boi Gordo",
    },
]


# ---------------------------------------------------------------------------
# Os seis campos fixos do bloco "Analise da Semana" - mesmo marcador em
# todas as 4 commodities, pra virar um padrao editorial reconhecivel.
# Preenchidos manualmente por enquanto (por isso NAO entram no dict
# `substituicoes` de atualizar_pagina_commodity: assim como
# RELATORIO_SEMANAL antes deles, o script diario nunca sobrescreve o
# que ja foi editado a mao - so usa o texto abaixo na primeira vez que
# a pagina e criada).
# ---------------------------------------------------------------------------
# Campos "fixos": sempre aparecem na pagina (mesmo quando as fontes nao
# cobrirem o suficiente, o proprio texto deve dizer isso - nunca ficam
# de fora). O marcador envolve so o paragrafo; o <article>/<h3> fica
# fixo no template.
CAMPOS_ANALISE_SEMANAL_FIXOS = [
    (
        "ANALISE_O_QUE_ACONTECEU",
        "Em preparação — em breve, um resumo dos principais fatos da semana "
        "para esta commodity, com atribuição às fontes (CEPEA, Notícias "
        "Agrícolas e outras fontes aprovadas).",
    ),
    (
        "ANALISE_POR_QUE_ACONTECEU",
        "Em preparação — em breve, as causas apontadas pelas fontes para os "
        "movimentos da semana (clima, câmbio, oferta e demanda, política, "
        "logística).",
    ),
    (
        "ANALISE_CONSEQUENCIAS",
        "Em preparação — em breve, a reação de preço, volume e comportamento "
        "dos players observada na semana.",
    ),
    (
        "ANALISE_O_QUE_OBSERVAR",
        "Em preparação — em breve, os fatores-chave a observar na próxima "
        "semana.",
    ),
]

# Campos "opcionais": Impacto B2B e Impacto B2C. Quando as fontes nao
# cobrirem o angulo E nao houver uma leitura de mercado confiavel o
# suficiente pra propor (ver gerar_analise_semanal.py), o campo inteiro
# - card e titulo incluidos - some da pagina, em vez de mostrar um card
# vazio ou um texto vago. Por isso o marcador envolve o <article>
# inteiro (nao so o paragrafo) - ver commodities/_template.html.
CAMPOS_ANALISE_SEMANAL_OPCIONAIS = [
    (
        "ANALISE_IMPACTO_B2B",
        "Impacto B2B",
        "Em preparação — em breve, o que muda para quem compra e vende em "
        "grande volume, indústria e trading (quando as fontes cobrirem esse "
        "ângulo).",
    ),
    (
        "ANALISE_IMPACTO_B2C",
        "Impacto B2C",
        "Em preparação — em breve, o que muda para o produtor menor e o "
        "consumidor final (quando as fontes cobrirem esse ângulo).",
    ),
]


# ---------------------------------------------------------------------------
# 0) COTACOES REGIONAIS - cada commodity usa a fonte (Notícias
#    Agrícolas/CEPEA) que de fato traz as praças pedidas para ela; café é
#    o único caso agrupado por praça cafeeira (não por estado).
# ---------------------------------------------------------------------------

def buscar_cotacoes_regionais_da_pagina(config: dict) -> list:
    if config["slug"] == "cafe":
        return monitor.buscar_cotacoes_regionais_cafe_por_regiao()
    if config["slug"] == "soja":
        return monitor.buscar_cotacoes_regionais_mercado_fisico(
            "soja/soja-mercado-fisico-sindicatos-e-cooperativas",
            config["estados_regionais"],
        )
    if config["slug"] == "milho":
        return monitor.buscar_cotacoes_regionais_mercado_fisico(
            "milho/milho-mercado-fisico-sindicatos-e-cooperativas",
            config["estados_regionais"],
        )
    if config["slug"] == "boi-gordo":
        return monitor.buscar_cotacoes_regionais_boi(config["estados_regionais"])
    return []


# ---------------------------------------------------------------------------
# 1) SCAFFOLD - cria commodities/<slug>/index.html a partir do template,
#    SOMENTE se o arquivo ainda nao existir (nunca sobrescreve o que ja
#    foi gerado, para nao perder os dados do dia que ja estao la).
# ---------------------------------------------------------------------------

def montar_links_switch(slug_atual: str) -> str:
    links = []
    for c in COMMODITIES_PAGINAS:
        classe = ' class="active"' if c["slug"] == slug_atual else ""
        links.append(
            f'<a href="../{c["slug"]}/"{classe}>{escape(c["nome_exibicao"])}</a>'
        )
    return "\n      ".join(links)


def montar_opcoes_comparar(slug_atual: str) -> str:
    opcoes = ['<option value="">Comparar com…</option>']
    for c in COMMODITIES_PAGINAS:
        if c["slug"] == slug_atual:
            continue
        opcoes.append(f'<option value="{c["slug"]}">{escape(c["nome_exibicao"])}</option>')
    return "\n        ".join(opcoes)


def garantir_pagina_existe(config: dict) -> str:
    pasta_pagina = os.path.join(PASTA_COMMODITIES, config["slug"])
    caminho_pagina = os.path.join(pasta_pagina, "index.html")

    if os.path.exists(caminho_pagina):
        return caminho_pagina

    os.makedirs(pasta_pagina, exist_ok=True)

    with open(PASTA_TEMPLATE, encoding="utf-8") as f:
        html = f.read()

    substituicoes_estaticas = {
        "{{SLUG}}": config["slug"],
        "{{NOME_EXIBICAO}}": config["nome_exibicao"],
        "{{NOME_EXIBICAO_MINUSCULO}}": config["nome_exibicao"].lower(),
        "{{TITULO_PAGINA}}": config["titulo_pagina"],
        "{{META_DESCRICAO}}": config["meta_descricao"],
        "{{HEADLINE}}": config["headline"],
        "{{SWITCH_LINKS}}": montar_links_switch(config["slug"]),
        "{{EYEBROW_INICIAL}}": "",
        "{{UPDATED_INICIAL}}": "",
        "{{PRECO_FISICO_INICIAL}}": "",
        "{{COTACOES_REGIONAIS_INICIAL}}": "",
        "{{FUTURO_INICIAL}}": "",
        "{{GRAFICO_INICIAL}}": "",
        "{{GRAFICO_LEGENDA_STAT_INICIAL}}": "",
        "{{GRAFICO_LEGENDA_CAUSA_INICIAL}}": "",
        "{{JSONLD_PRODUTO_INICIAL}}": "",
        "{{DADOS_HISTORICO_JSON_INICIAL}}": "",
        "{{ANALISE_FONTES_INICIAL}}": "",
        "{{COMPARAR_OPCOES}}": montar_opcoes_comparar(config["slug"]),
        "{{RESUMO_ANALISTA_INICIAL}}": (
            f"Análise em preparação — em breve, um resumo do que está "
            f"movimentando o mercado de {config['nome_exibicao'].lower()} nesta semana."
        ),
        "{{NOTICIAS_INICIAL}}": "",
    }
    for chave_campo, texto_placeholder in CAMPOS_ANALISE_SEMANAL_FIXOS:
        substituicoes_estaticas[f"{{{{{chave_campo}_INICIAL}}}}"] = (
            f'<p class="analise-placeholder">{texto_placeholder}</p>'
        )
    for chave_campo, titulo_campo, texto_placeholder in CAMPOS_ANALISE_SEMANAL_OPCIONAIS:
        substituicoes_estaticas[f"{{{{{chave_campo}_INICIAL}}}}"] = (
            f'<h3>{titulo_campo}</h3>\n'
            f'        <div class="analise-texto"><p class="analise-placeholder">{texto_placeholder}</p></div>'
        )
    for chave, valor in substituicoes_estaticas.items():
        html = html.replace(chave, valor)

    with open(caminho_pagina, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Pagina criada: commodities/{config['slug']}/index.html")
    return caminho_pagina


# ---------------------------------------------------------------------------
# 2) HISTORICO - le todos os snapshots em dados/*.json e monta a serie de
#    preco fisico da commodity ao longo do tempo, para o grafico.
# ---------------------------------------------------------------------------

def _preco_fisico_para_float(preco_reais: str):
    """Preco fisico (nao convertido) vem formatado com PONTO decimal
    (ex: '159.76'), exceto casos ja convertidos (ex: Trigo), que usam
    virgula. Tenta os dois formatos, nessa ordem."""
    texto = str(preco_reais).strip()
    try:
        return float(texto)
    except ValueError:
        pass
    valor = monitor._texto_para_float(texto)
    return valor


def carregar_historico_fisico(nome_fisica: str, dias: int = 90) -> list:
    """Retorna uma lista de tuplas (data_str, preco_float) para a
    commodity, lendo os snapshots diarios salvos em dados/*.json,
    ordenada por data crescente, limitada aos ultimos `dias` arquivos
    disponiveis."""
    if not os.path.isdir(PASTA_DADOS):
        return []

    arquivos = sorted(
        f for f in os.listdir(PASTA_DADOS)
        if re.match(r"^\d{4}-\d{2}-\d{2}\.json$", f)
    )
    arquivos = arquivos[-dias:]

    serie = []
    for nome_arquivo in arquivos:
        caminho = os.path.join(PASTA_DADOS, nome_arquivo)
        try:
            with open(caminho, encoding="utf-8") as f:
                dados = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue

        for r in dados.get("resultados_commodities", []):
            if r.get("nome") == nome_fisica and "erro" not in r:
                valor = _preco_fisico_para_float(r.get("preco_reais"))
                if valor is not None:
                    data_arquivo = nome_arquivo.replace(".json", "")
                    serie.append((data_arquivo, valor))
                break

    return serie


# ---------------------------------------------------------------------------
# 3) GRAFICO - renderiza um SVG de linha simples (sem dependencia externa,
#    sem JS), no mesmo padrao visual sobrio do site.
# ---------------------------------------------------------------------------

def _fmt_brl(valor: float) -> str:
    """Formata um float no padrão R$ brasileiro (vírgula decimal, ponto de
    milhar), ex: 1728.61 -> '1.728,61'."""
    return f"{valor:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


def _fmt_data_br(data_iso: str) -> str:
    """Converte 'AAAA-MM-DD' (nome do arquivo em dados/) para 'DD/MM/AAAA'."""
    try:
        ano, mes, dia = data_iso.split("-")
        return f"{dia}/{mes}/{ano}"
    except ValueError:
        return data_iso


def _caminho_suave(pontos_xy: list) -> str:
    """Converte uma lista de pontos (x, y) num path SVG suavizado (curvas
    de Bézier cúbicas via Catmull-Rom uniforme), que passa EXATAMENTE
    por cada ponto - ao contrário de uma linha poligonal reta entre
    pontos consecutivos (o que antes deixava o gráfico com aparência
    "serrilhada" em séries com muita oscilação dia a dia). É o mesmo
    princípio usado pelo modo "spline" de bibliotecas de gráfico como
    Highcharts/Chart.js.

    Os pontos das extremidades são clampeados (repetidos) para o
    cálculo dos vizinhos, o que é o tratamento de borda padrão dessa
    técnica.
    """
    n = len(pontos_xy)
    if n < 2:
        return ""
    if n == 2:
        (x0, y0), (x1, y1) = pontos_xy
        return f"M {x0:.1f},{y0:.1f} L {x1:.1f},{y1:.1f}"

    def _p(i):
        return pontos_xy[max(0, min(n - 1, i))]

    x0, y0 = pontos_xy[0]
    partes = [f"M {x0:.1f},{y0:.1f}"]
    for i in range(n - 1):
        p0x, p0y = _p(i - 1)
        p1x, p1y = _p(i)
        p2x, p2y = _p(i + 1)
        p3x, p3y = _p(i + 2)
        c1x, c1y = p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6
        c2x, c2y = p2x - (p3x - p1x) / 6, p2y - (p3y - p1y) / 6
        partes.append(f"C {c1x:.1f},{c1y:.1f} {c2x:.1f},{c2y:.1f} {p2x:.1f},{p2y:.1f}")
    return " ".join(partes)


PERIODOS_GRAFICO = [("7d", "7 dias", 7), ("30d", "30 dias", 30), ("90d", "90 dias", 90)]


def montar_grafico_svg(serie: list, nome_exibicao: str, slug: str) -> str:
    """Monta o gráfico com abas de período (7/30/90 dias). Cada aba é
    renderizada inteira no servidor (_renderizar_svg_periodo) a partir
    do recorte correspondente de `serie`; o navegador só troca qual
    bloco fica visível (ver assets/interatividade.js), sem nenhum
    cálculo de coordenadas no cliente para essa parte.

    Períodos sem dado suficiente (menos de 2 pontos no recorte, comum
    logo após o lançamento do site, quando o histórico ainda é curto)
    não geram aba. Se sobrar só um período utilizável, mostra o gráfico
    sem abas (nada para alternar).
    """
    if len(serie) < 2:
        return (
            '<p style="opacity:.6;font-size:14px;">'
            "Histórico insuficiente ainda para montar o gráfico — volte em "
            "alguns dias, conforme mais snapshots diários forem acumulados."
            "</p>"
        )

    conteudos = []
    for sufixo, rotulo, dias in PERIODOS_GRAFICO:
        recorte = serie[-dias:]
        if len(recorte) < 2:
            continue
        conteudo = _renderizar_svg_periodo(recorte, nome_exibicao, slug, sufixo)
        conteudos.append((sufixo, rotulo, conteudo))

    if not conteudos:
        return ""
    if len(conteudos) == 1:
        return conteudos[0][2]

    botoes = "\n      ".join(
        f'<button type="button" class="periodo-btn{" active" if i == 0 else ""}" '
        f'data-periodo="{sufixo}" role="tab" aria-selected="{"true" if i == 0 else "false"}">{rotulo}</button>'
        for i, (sufixo, rotulo, _) in enumerate(conteudos)
    )
    painel = "\n      ".join(
        f'<div data-periodo="{sufixo}"{"" if i == 0 else " hidden"}>{conteudo}</div>'
        for i, (sufixo, _, conteudo) in enumerate(conteudos)
    )

    return (
        f'<div class="chart-periodos" role="tablist" aria-label="Período do gráfico">\n'
        f"      {botoes}\n"
        f"    </div>\n"
        f'    <div class="chart-painel">\n'
        f"      {painel}\n"
        f"    </div>"
    )


def _renderizar_svg_periodo(serie: list, nome_exibicao: str, slug_base: str, sufixo: str) -> str:
    slug = f"{slug_base}-{sufixo}"
    largura, altura = 900, 260
    # margem esquerda cresce com a quantidade de digitos do maior preco,
    # para o rotulo "R$ X.XXX,XX" nunca ser cortado pela borda do SVG
    maior_preco_texto = f"R$ {_fmt_brl(max(v for _, v in serie))}"
    margem_esq = max(50, 14 + len(maior_preco_texto) * 6)
    margem_dir, margem_topo, margem_baixo = 20, 20, 30

    valores = [v for _, v in serie]
    minimo, maximo = min(valores), max(valores)
    if minimo == maximo:
        minimo -= 1
        maximo += 1
    faixa = maximo - minimo

    largura_util = largura - margem_esq - margem_dir
    altura_util = altura - margem_topo - margem_baixo
    passo_x = largura_util / (len(serie) - 1)

    pontos = []
    for i, (data_str, valor) in enumerate(serie):
        x = margem_esq + i * passo_x
        y = margem_topo + altura_util - ((valor - minimo) / faixa) * altura_util
        pontos.append((x, y, data_str, valor))

    caminho_linha = _caminho_suave([(x, y) for x, y, _, _ in pontos])
    linha_base_y = margem_topo + altura_util
    caminho_area = (
        f"{caminho_linha} "
        f"L {pontos[-1][0]:.1f},{linha_base_y:.1f} "
        f"L {pontos[0][0]:.1f},{linha_base_y:.1f} Z"
    )

    cor_linha = "#4C7A1F" if valores[-1] >= valores[0] else "#9C3B2E"

    circulo_final_x, circulo_final_y, _, _ = pontos[-1]

    data_inicial = serie[0][0]
    data_final = serie[-1][0]

    # Pontos interativos: um circulo visivel pequeno + uma "area de toque"
    # maior e invisivel por cima (mais facil de acertar com o mouse/dedo),
    # cada um sabendo qual e o seu ponto visivel correspondente (para
    # destaca-lo) e carregando a data e o preco daquele dia.
    pontos_svg = []
    for i, (x, y, data_str, valor) in enumerate(pontos):
        id_ponto = f"ponto-{slug}-{i}"
        pontos_svg.append(
            f'<circle id="{id_ponto}" class="chart-dot" cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{cor_linha}"/>'
            f'<circle class="chart-hit" cx="{x:.1f}" cy="{y:.1f}" r="10" '
            f'fill="transparent" data-alvo="{id_ponto}" '
            f'data-data="{escape(_fmt_data_br(data_str))}" '
            f'data-preco="{escape(_fmt_brl(valor))}"/>'
        )
    pontos_svg_str = "\n  ".join(pontos_svg)

    id_unico = f"grafico-{slug}"
    id_gradiente = f"grad-{slug}"
    data_final_fmt = escape(_fmt_data_br(data_final))
    preco_final_fmt = _fmt_brl(valores[-1])

    svg = f'''<div class="chart-wrap" id="{id_unico}" data-slug="{slug_base}" data-margem-esq="{margem_esq}" data-margem-topo="{margem_topo}" data-altura-util="{altura_util}" data-largura-util="{largura_util}" data-num-pontos="{len(serie)}">
<svg viewBox="0 0 {largura} {altura}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Variação de preço de {escape(nome_exibicao)} no período">
  <defs>
    <linearGradient id="{id_gradiente}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{cor_linha}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="{cor_linha}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <line x1="{margem_esq}" y1="{margem_topo}" x2="{margem_esq}" y2="{margem_topo + altura_util}" stroke="rgba(11,60,31,0.14)" stroke-width="1"/>
  <line x1="{margem_esq}" y1="{margem_topo + altura_util}" x2="{largura - margem_dir}" y2="{margem_topo + altura_util}" stroke="rgba(11,60,31,0.14)" stroke-width="1"/>
  <text x="{margem_esq - 8}" y="{margem_topo + 4}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="11" fill="#0B3C1F" opacity="0.6">R$ {_fmt_brl(maximo)}</text>
  <text x="{margem_esq - 8}" y="{margem_topo + altura_util}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="11" fill="#0B3C1F" opacity="0.6">R$ {_fmt_brl(minimo)}</text>
  <path d="{caminho_area}" fill="url(#{id_gradiente})" stroke="none"/>
  <path d="{caminho_linha}" fill="none" stroke="{cor_linha}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  {pontos_svg_str}
  <circle cx="{circulo_final_x:.1f}" cy="{circulo_final_y:.1f}" r="4" fill="{cor_linha}"/>
</svg>
</div>
<div class="chart-footer">
  <span class="chart-footer-extremo">{escape(_fmt_data_br(data_inicial))}</span>
  <span class="chart-readout-texto">{data_final_fmt} · R$ {preco_final_fmt}</span>
  <span class="chart-footer-extremo">{data_final_fmt} · R$ {preco_final_fmt}</span>
</div>
<script>
(function(){{
  var raiz = document.getElementById("{id_unico}");
  if (!raiz) return;
  var rodape = raiz.nextElementSibling;
  var elTexto = rodape.querySelector(".chart-readout-texto");
  var pontos = raiz.querySelectorAll(".chart-hit");
  var ativo = null;
  pontos.forEach(function(ponto){{
    function ativar(){{
      if (ativo) ativo.classList.remove("chart-dot-ativo");
      var alvo = raiz.querySelector("#" + ponto.getAttribute("data-alvo"));
      if (alvo) {{ alvo.classList.add("chart-dot-ativo"); ativo = alvo; }}
      elTexto.textContent = ponto.getAttribute("data-data") + " · R$ " + ponto.getAttribute("data-preco");
    }}
    ponto.addEventListener("mouseenter", ativar);
    ponto.addEventListener("touchstart", ativar, {{passive: true}});
  }});
  raiz.addEventListener("mouseleave", function(){{
    if (ativo) {{ ativo.classList.remove("chart-dot-ativo"); ativo = null; }}
    elTexto.textContent = "{data_final_fmt} · R$ {preco_final_fmt}";
  }});
}})();
</script>'''

    return svg


def montar_legenda_grafico_stat(serie: list) -> str:
    """Legenda analítica automática do gráfico: variação percentual nos
    últimos ~5 pontos do histórico (aprox. uma semana de pregão),
    calculada a partir dos mesmos dados que já alimentam o SVG. Só o
    fato numérico - a causa ("puxada por X") é o marcador
    GRAFICO_LEGENDA_CAUSA, ao lado, preenchido manualmente (não temos
    como inferir causa de um número sozinho).

    Atualizada a cada rodada do gerador (ao contrário de
    GRAFICO_LEGENDA_CAUSA, que é editorial e não é tocada aqui).
    """
    if len(serie) < 2:
        return ""

    janela = min(5, len(serie) - 1)
    valor_inicio = serie[-(janela + 1)][1]
    valor_fim = serie[-1][1]
    if valor_inicio == 0:
        return ""

    variacao_pct = ((valor_fim - valor_inicio) / valor_inicio) * 100
    variacao_fmt = f"{abs(variacao_pct):.1f}".replace(".", ",")
    periodo_texto = "na semana" if janela >= 4 else "no período exibido"

    if variacao_pct > 0.1:
        rotulo, classe = f"Alta de {variacao_fmt}%", "up"
    elif variacao_pct < -0.1:
        rotulo, classe = f"Queda de {variacao_fmt}%", "down"
    else:
        rotulo, classe = "Estabilidade", ""

    return (
        f'<span class="chart-legenda-stat {classe}">{escape(rotulo)}</span> '
        f'{escape(periodo_texto)}.'
    )


def montar_dados_historico_json() -> str:
    """Monta um JSON compacto {slug: [[data, preco], ...]} com o
    histórico (até 90 dias) das 4 commodities, embutido uma vez em cada
    página de commodity (ver marcador DADOS_HISTORICO_JSON) pra
    alimentar o comparativo entre commodities no gráfico
    (assets/interatividade.js) - sem nenhuma requisição nova no
    navegador, só os mesmos dados que já geram os gráficos individuais.
    """
    dados = {
        c["slug"]: carregar_historico_fisico(c["nome_fisica"])
        for c in COMMODITIES_PAGINAS
    }
    bruto = json.dumps(dados, ensure_ascii=False, separators=(",", ":"))
    # O <script> precisa estar TODO dentro do marcador (não só o JSON) -
    # como <script> é um elemento de "raw text" em HTML, um comentário
    # <!-- --> colocado dentro dele não é interpretado como comentário
    # pelo navegador (fica texto literal, quebrando o JSON.parse do
    # lado do JS). Por isso a marcação fica por fora da tag inteira.
    return f'<script type="application/json" id="dados-historico-commodities">{bruto}</script>'


def montar_jsonld_produto(config: dict, fisica_filtrada: list) -> str:
    """Monta o JSON-LD (Product + Offer) com o preço do dia da commodity,
    para o marcador JSONLD_PRODUTO no <head> da página (script separado
    do JSON-LD estático de Organization/BreadcrumbList/WebPage, que não
    muda todo dia).

    Só emite algo quando há um preço válido do dia; em erro ou fonte
    indisponível, devolve string vazia (o <script> fica sem conteúdo,
    e é simplesmente ignorado por quem lê a página) em vez de publicar
    um preço desatualizado ou inventado.
    """
    if not fisica_filtrada or "erro" in fisica_filtrada[0]:
        return ""

    resultado = fisica_filtrada[0]
    try:
        preco_num = _preco_fisico_para_float(resultado["preco_reais"])
    except (ValueError, TypeError):
        return ""

    url_pagina = f"https://agrofertrader.github.io/AgroFerTrader-site/commodities/{config['slug']}/"
    dados_jsonld = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": config["nome_exibicao"],
        "description": config["meta_descricao"],
        "url": url_pagina,
        "offers": {
            "@type": "Offer",
            "url": url_pagina,
            "priceCurrency": "BRL",
            "price": f"{preco_num:.2f}",
            "availability": "https://schema.org/InStock",
            "priceValidUntil": datetime.now().strftime("%Y-%m-%d"),
        },
    }
    bruto = json.dumps(dados_jsonld, ensure_ascii=False, indent=2)
    # Ver comentário equivalente em montar_dados_historico_json(): o
    # <script> inteiro precisa estar dentro do marcador, não só o JSON,
    # senão os comentários HTML do marcador viram texto literal dentro
    # do bloco e o JSON-LD fica inválido pros crawlers (bug real que
    # existia aqui desde o Bloco 1 até esta correção).
    return f'<script type="application/ld+json">{bruto}</script>'


# ---------------------------------------------------------------------------
# 4) NOTICIAS POR CATEGORIA - mesmo padrao de scraping do
#    monitor_agro_v9.buscar_noticias_agro(), mas na pagina de categoria
#    da commodity (sem precisar do filtro de palavras-chave de comercio,
#    ja que a categoria em si ja restringe o assunto).
# ---------------------------------------------------------------------------

def buscar_noticias_por_categoria(categoria: str, quantidade: int = 5) -> list:
    from bs4 import BeautifulSoup

    cabecalhos = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }

    url_lista = f"https://www.noticiasagricolas.com.br/noticias/{categoria}"
    resposta = monitor.requests.get(url_lista, headers=cabecalhos, timeout=10)
    resposta.raise_for_status()
    sopa = BeautifulSoup(resposta.text, "lxml")

    candidatas = []
    links_ja_vistos = set()
    for link in sopa.select("a"):
        texto = link.get_text(strip=True)
        href = link.get("href")
        if texto and href and len(texto) > 40 and href not in links_ja_vistos:
            if href.startswith("/"):
                href = "https://www.noticiasagricolas.com.br" + href
            candidatas.append({"titulo": texto, "link": href})
            links_ja_vistos.add(href)
        if len(candidatas) >= quantidade:
            break

    for noticia in candidatas:
        try:
            resp_materia = monitor.requests.get(noticia["link"], headers=cabecalhos, timeout=10)
            resp_materia.raise_for_status()
            sopa_materia = BeautifulSoup(resp_materia.text, "lxml")
            resumo = None
            for paragrafo in sopa_materia.select("p"):
                texto_p = paragrafo.get_text(strip=True)
                if texto_p and len(texto_p) > 60:
                    resumo = texto_p
                    break
            noticia["resumo"] = (
                (resumo[:220] + "...") if resumo and len(resumo) > 220
                else (resumo or "Resumo não disponível — acesse a matéria completa pelo link.")
            )
        except Exception:
            noticia["resumo"] = "Resumo não disponível — acesse a matéria completa pelo link."
        noticia["fonte"] = "Notícias Agrícolas"

    return candidatas


# ---------------------------------------------------------------------------
# 5) MONTAGEM FINAL - reaproveita os proprios montadores de HTML do
#    gerar_site.py (mesmo card de preco, mesma tabela de futuro, mesmo
#    bloco de noticia), so que filtrados para UMA commodity.
# ---------------------------------------------------------------------------

def atualizar_pagina_commodity(config: dict, dados: dict) -> None:
    caminho_pagina = garantir_pagina_existe(config)

    fisica_filtrada = [
        r for r in dados["resultados_commodities"]
        if r.get("nome") == config["nome_fisica"]
    ]
    futuro_filtrado = [
        r for r in dados["resultados_futuros"]
        if r.get("nome") == config["nome_futuro"]
    ]

    try:
        noticias_categoria = buscar_noticias_por_categoria(config["categoria_noticias"])
    except Exception as e:
        noticias_categoria = []
        print(f"Aviso: nao foi possivel buscar noticias de {config['slug']} ({e})")

    historico = carregar_historico_fisico(config["nome_fisica"])

    try:
        cotacoes_regionais = buscar_cotacoes_regionais_da_pagina(config)
    except Exception as e:
        cotacoes_regionais = []
        print(f"Aviso: nao foi possivel buscar cotacoes regionais de {config['slug']} ({e})")

    with open(caminho_pagina, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "EYEBROW": site.montar_eyebrow(),
        "UPDATED": site.montar_updated(dados),
        # com_links=False: esse cartao de preco ja esta na propria pagina
        # de detalhes da commodity, entao um link "Ver detalhes" apontando
        # de volta pra "commodities/{slug}/" (relativo à raiz do site, como
        # e usado na home) resolveria errado a partir daqui e cairia num 404.
        "PRECO_FISICO": site.montar_precos_html(fisica_filtrada, com_links=False),
        "COTACOES_REGIONAIS": site.montar_cotacoes_regionais_html(cotacoes_regionais),
        "FUTURO": site.montar_futuros_html(futuro_filtrado),
        "GRAFICO": montar_grafico_svg(historico, config["nome_exibicao"], config["slug"]),
        "GRAFICO_LEGENDA_STAT": montar_legenda_grafico_stat(historico),
        "JSONLD_PRODUTO": montar_jsonld_produto(config, fisica_filtrada),
        "DADOS_HISTORICO_JSON": montar_dados_historico_json(),
        "NOTICIAS": site.montar_noticias_html(noticias_categoria),
    }

    for marcador, conteudo in substituicoes.items():
        html = site._substituir_entre_marcadores(html, marcador, conteudo)

    with open(caminho_pagina, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Pagina atualizada: commodities/{config['slug']}/index.html")


# ---------------------------------------------------------------------------
# 6) SITEMAP - regenerado a cada rodada a partir das paginas fixas do
#    site (home, entenda) + uma entrada por commodity em
#    COMMODITIES_PAGINAS, para nunca ficar desatualizado quando uma nova
#    commodity for adicionada aqui.
# ---------------------------------------------------------------------------

URL_BASE_SITE = "https://agrofertrader.github.io/AgroFerTrader-site"
PAGINAS_FIXAS_SITEMAP = ["", "entenda.html"]


def gerar_sitemap() -> None:
    urls = [f"{URL_BASE_SITE}/{pagina}" for pagina in PAGINAS_FIXAS_SITEMAP]
    urls += [f"{URL_BASE_SITE}/commodities/{c['slug']}/" for c in COMMODITIES_PAGINAS]

    linhas_url = "\n\n".join(f"    <url>\n        <loc>{escape(u)}</loc>\n    </url>" for u in urls)
    conteudo = (
        '<?xml version="1.0" encoding="UTF-8"?>\n\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n\n'
        f"{linhas_url}\n\n"
        "</urlset>\n"
    )

    caminho = os.path.join(PASTA_SITE, "sitemap.xml")
    with open(caminho, "w", encoding="utf-8") as f:
        f.write(conteudo)
    print("sitemap.xml atualizado")


def gerar_paginas_commodities() -> None:
    print("Buscando os mesmos dados do dia usados na home (monitor_agro_v9)...")
    dados = monitor.coletar_dados()

    os.makedirs(PASTA_COMMODITIES, exist_ok=True)

    for config in COMMODITIES_PAGINAS:
        atualizar_pagina_commodity(config, dados)

    gerar_sitemap()

    print("Todas as paginas de commodities foram atualizadas.")


if __name__ == "__main__":
    gerar_paginas_commodities()
