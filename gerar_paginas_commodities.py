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
        "titulo_pagina": "Preço da Soja Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura da soja atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas do mercado de soja.",
        "headline": "Soja: preço de hoje, futuro e histórico.",
        "subtitulo": "Cotação física (CEPEA/Esalq) e futura (B3) da soja, atualizadas diariamente, com histórico de variação e notícias específicas do mercado.",
    },
    {
        "slug": "milho",
        "nome_exibicao": "Milho",
        "nome_fisica": "Milho",
        "nome_futuro": "Milho Futuro (B3)",
        "categoria_noticias": "milho",
        "titulo_pagina": "Preço do Milho Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura do milho atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas do mercado de milho.",
        "headline": "Milho: preço de hoje, futuro e histórico.",
        "subtitulo": "Cotação física (CEPEA/Esalq) e futura (B3) do milho, atualizadas diariamente, com histórico de variação e notícias específicas do mercado.",
    },
    {
        "slug": "cafe",
        "nome_exibicao": "Café Arábica",
        "nome_fisica": "Café Arábica",
        "nome_futuro": "Café Arábica Futuro (B3)",
        "categoria_noticias": "cafe",
        "titulo_pagina": "Preço do Café Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura do café arábica atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas do mercado de café.",
        "headline": "Café: preço de hoje, futuro e histórico.",
        "subtitulo": "Cotação física (CEPEA/Esalq) e futura (B3) do café arábica, atualizadas diariamente, com histórico de variação e notícias específicas do mercado.",
    },
    {
        "slug": "boi-gordo",
        "nome_exibicao": "Boi Gordo",
        "nome_fisica": "Boi Gordo",
        "nome_futuro": "Boi Gordo Futuro (B3)",
        "categoria_noticias": "boi",
        "titulo_pagina": "Preço do Boi Gordo Hoje — Cotação Física, Futuro e Notícias",
        "meta_descricao": "Cotação física e futura do boi gordo atualizadas diariamente (CEPEA/Esalq e B3), com histórico de preços e notícias específicas da pecuária de corte.",
        "headline": "Boi Gordo: preço de hoje, futuro e histórico.",
        "subtitulo": "Cotação física (CEPEA/Esalq) e futura (B3) do boi gordo, atualizadas diariamente, com histórico de variação e notícias específicas da pecuária.",
    },
]


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
        "{{SUBTITULO}}": config["subtitulo"],
        "{{SWITCH_LINKS}}": montar_links_switch(config["slug"]),
        "{{EYEBROW_INICIAL}}": "",
        "{{UPDATED_INICIAL}}": "",
        "{{PRECO_FISICO_INICIAL}}": "",
        "{{FUTURO_INICIAL}}": "",
        "{{GRAFICO_INICIAL}}": "",
        "{{RELATORIO_SEMANAL_INICIAL}}": (
            '<p class="report-placeholder">'
            "Relatório semanal em preparação — em breve, uma análise comentada "
            "sobre os principais movimentos desta commodity na última semana."
            "</p>"
        ),
        "{{NOTICIAS_INICIAL}}": "",
    }
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

def montar_grafico_svg(serie: list, nome_exibicao: str) -> str:
    if len(serie) < 2:
        return (
            '<p style="opacity:.6;font-size:14px;">'
            "Histórico insuficiente ainda para montar o gráfico — volte em "
            "alguns dias, conforme mais snapshots diários forem acumulados."
            "</p>"
        )

    largura, altura = 900, 260
    # margem esquerda cresce com a quantidade de digitos do maior preco,
    # para o rotulo "R$ X.XXX,XX" nunca ser cortado pela borda do SVG
    maior_preco_texto = f"R$ {max(v for _, v in serie):.2f}"
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
    for i, (_, valor) in enumerate(serie):
        x = margem_esq + i * passo_x
        y = margem_topo + altura_util - ((valor - minimo) / faixa) * altura_util
        pontos.append((x, y))

    pontos_str = " ".join(f"{x:.1f},{y:.1f}" for x, y in pontos)

    cor_linha = "#4C7A1F" if valores[-1] >= valores[0] else "#9C3B2E"

    circulo_final_x, circulo_final_y = pontos[-1]

    data_inicial = serie[0][0]
    data_final = serie[-1][0]

    svg = f'''<svg viewBox="0 0 {largura} {altura}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Variação de preço de {escape(nome_exibicao)} no período">
  <line x1="{margem_esq}" y1="{margem_topo}" x2="{margem_esq}" y2="{margem_topo + altura_util}" stroke="rgba(11,60,31,0.14)" stroke-width="1"/>
  <line x1="{margem_esq}" y1="{margem_topo + altura_util}" x2="{largura - margem_dir}" y2="{margem_topo + altura_util}" stroke="rgba(11,60,31,0.14)" stroke-width="1"/>
  <text x="{margem_esq - 8}" y="{margem_topo + 4}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="11" fill="#0B3C1F" opacity="0.6">R$ {maximo:.2f}</text>
  <text x="{margem_esq - 8}" y="{margem_topo + altura_util}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="11" fill="#0B3C1F" opacity="0.6">R$ {minimo:.2f}</text>
  <polyline points="{pontos_str}" fill="none" stroke="{cor_linha}" stroke-width="2.5"/>
  <circle cx="{circulo_final_x:.1f}" cy="{circulo_final_y:.1f}" r="4" fill="{cor_linha}"/>
</svg>'''

    legenda = (
        f'<div class="chart-legend"><span>{escape(data_inicial)}</span>'
        f'<span>{escape(data_final)} · R$ {valores[-1]:.2f}</span></div>'
    )

    return svg + "\n" + legenda


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

    with open(caminho_pagina, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "EYEBROW": site.montar_eyebrow(),
        "UPDATED": site.montar_updated(dados),
        "PRECO_FISICO": site.montar_precos_html(fisica_filtrada),
        "FUTURO": site.montar_futuros_html(futuro_filtrado),
        "GRAFICO": montar_grafico_svg(historico, config["nome_exibicao"]),
        "NOTICIAS": site.montar_noticias_html(noticias_categoria),
    }

    for marcador, conteudo in substituicoes.items():
        html = site._substituir_entre_marcadores(html, marcador, conteudo)

    with open(caminho_pagina, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Pagina atualizada: commodities/{config['slug']}/index.html")


def gerar_paginas_commodities() -> None:
    print("Buscando os mesmos dados do dia usados na home (monitor_agro_v9)...")
    dados = monitor.coletar_dados()

    os.makedirs(PASTA_COMMODITIES, exist_ok=True)

    for config in COMMODITIES_PAGINAS:
        atualizar_pagina_commodity(config, dados)

    print("Todas as paginas de commodities foram atualizadas.")


if __name__ == "__main__":
    gerar_paginas_commodities()
