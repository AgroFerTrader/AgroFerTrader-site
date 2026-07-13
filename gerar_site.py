# -*- coding: utf-8 -*-
"""
Gerar Site - AgroFer Trader
============================
Gera o site (index.html) automaticamente a partir dos mesmos dados que o
monitor_agro_v9.py ja busca (dolar, Selic, commodities fisicas, futuros
B3, noticias). A pagina entenda.html e conteudo evergreen (nao muda todo
dia) e nao e tocada por este script.

Requisitos: os mesmos do monitor_agro_v9.py (requests, pandas, lxml,
beautifulsoup4), mais este proprio arquivo monitor_agro_v9.py no mesmo
diretorio (importado como modulo).

Uso diario:
    python gerar_site.py

O que este script faz, passo a passo:
  1. Busca os dados do dia (reaproveita monitor_agro_v9.coletar_dados(),
     a MESMA funcao que gera o e-mail - sem duplicar logica de scraping).
  2. Salva um snapshot bruto em dados/AAAA-MM-DD.json - guarda historico
     desde o primeiro dia, mesmo o site sendo uma pagina so hoje. Isso
     evita ter que esperar meses coletando de novo se um dia voce quiser
     evoluir pra graficos ou historico navegavel.
  3. Le index.html como MOLDE (o arquivo tem marcadores tipo
     <!-- TICKER:START --> ... <!-- TICKER:END --> demarcando o que e
     dado do dia) e troca so o conteudo entre os marcadores.
  4. Sobrescreve index.html com a versao atualizada.

Publicar no ar (GitHub Pages):
    1. Crie um repositorio no GitHub e suba esta pasta (index.html,
       entenda.html, assets/, monitor_agro_v9.py, gerar_site.py).
    2. Nas configuracoes do repositorio (Settings > Pages), ative o
       GitHub Pages apontando pra branch principal.
    3. Pra automatizar (rodar sozinho todo dia), crie um workflow do
       GitHub Actions (arquivo .github/workflows/atualizar.yml) que roda
       "python gerar_site.py" e depois faz commit + push do index.html
       atualizado - mesmo esquema usado pra automatizar o e-mail.
"""

import json
import os
import re
from datetime import datetime

import monitor_agro_v9 as monitor

PASTA_SITE = os.path.dirname(os.path.abspath(__file__))
CAMINHO_TEMPLATE = os.path.join(PASTA_SITE, "index.html")
PASTA_DADOS = os.path.join(PASTA_SITE, "dados")

MESES_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]
DIAS_SEMANA_PT = [
    "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira",
    "Sexta-feira", "Sábado", "Domingo",
]


def salvar_snapshot_diario(dados: dict) -> None:
    """
    Salva os dados brutos do dia em dados/AAAA-MM-DD.json.

    Guardar isso desde o primeiro dia (mesmo o site sendo so uma pagina
    estatica hoje) e o que permite, no futuro, montar graficos de preco
    ao longo do tempo ou um historico navegavel - sem essa base, seria
    preciso esperar meses coletando de novo a partir do zero.
    """
    os.makedirs(PASTA_DADOS, exist_ok=True)
    caminho = os.path.join(PASTA_DADOS, f"{datetime.now().strftime('%Y-%m-%d')}.json")
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)


def _seta_e_classe(variacao) -> tuple:
    """Devolve (seta unicode, classe css 'up'/'down'/'') para uma variacao,
    reaproveitando o parser de variacao ja validado no monitor_agro_v9."""
    v = monitor._variacao_para_float(variacao)
    if v is None:
        return ("•", "")
    if v > 0:
        return ("▲", "up")
    if v < 0:
        return ("▼", "down")
    return ("•", "")


def _nome_curto(nome_completo: str) -> str:
    """Tira anotacoes tipo '(R$/saca 60kg)' do nome, para caber no ticker.
    Ex: 'Trigo (R$/saca 60kg)' -> 'TRIGO'"""
    return nome_completo.split(" (")[0].upper()


def montar_ticker_html(dolar, resultados_commodities) -> str:
    """Monta os <span class="item"> do ticker rolante, a partir do dolar
    oficial + todas as commodities fisicas. Duplica a lista uma vez (o
    CSS do ticker depende disso pra fazer o loop parecer continuo)."""
    itens = []
    if dolar is not None:
        seta, classe = _seta_e_classe(dolar["variacao_pct"])
        itens.append(
            f'<span class="item">DÓLAR <b>R$ {dolar["valor"]:.4f}</b> '
            f'<span class="{classe}">{seta} {abs(dolar["variacao_pct"]):.2f}%</span></span>'
        )
    for r in resultados_commodities:
        if "erro" in r:
            continue
        seta, classe = _seta_e_classe(r["variacao_pct"])
        itens.append(
            f'<span class="item">{_nome_curto(r["nome"])} <b>R$ {r["preco_reais"]}</b> '
            f'<span class="{classe}">{seta} {r["variacao_pct"]}%</span></span>'
        )
    todos = itens + itens  # duplica pra loop continuo do CSS
    return "\n      ".join(todos)


def montar_precos_html(resultados_commodities) -> str:
    """Monta os cartões de preço físico (um por commodity)."""
    # Unidade de exibição por commodity - Boi Gordo é por arroba, o
    # resto por saca de 60kg (assim como já mostramos no e-mail).
    unidades = {"Boi Gordo": "por arroba"}
    blocos = []
    for r in resultados_commodities:
        if "erro" in r:
            blocos.append(
                f'<div class="price-card">'
                f'<div class="price-name">{r["nome"]}</div>'
                f'<div class="price-meta">Indisponível no momento</div>'
                f'</div>'
            )
            continue
        seta, classe = _seta_e_classe(r["variacao_pct"])
        nome_limpo = r["nome"].split(" (")[0]
        unidade = unidades.get(nome_limpo, "por saca de 60kg")
        blocos.append(
            f'<div class="price-card">\n'
            f'  <div class="price-name">{nome_limpo}</div>\n'
            f'  <div class="price-value">R$ {r["preco_reais"]}</div>\n'
            f'  <div class="price-var {classe}">{seta} {r["variacao_pct"]}%</div>\n'
            f'  <div class="price-meta">{unidade}</div>\n'
            f'</div>'
        )
    return "\n      ".join(blocos)


def montar_explain_html(explicacoes_macro: list) -> str:
    """Monta os parágrafos da seção 'O que isso significa', a partir das
    mesmas linhas geradas por gerar_explicacao_macro() (já variadas e
    adaptativas - ver monitor_agro_v9.py)."""
    paragrafos = [
        l for l in explicacoes_macro
        if l and not l.startswith("---")
    ]
    blocos = []
    for p in paragrafos:
        classe = ' class="obs"' if p.startswith("Obs.:") else ""
        blocos.append(f"<p{classe}>{p}</p>")
    return "\n      ".join(blocos)


def montar_futuros_html(resultados_futuros: list) -> str:
    """Monta as linhas da tabela de mercado futuro B3."""
    linhas = []
    for r in resultados_futuros:
        if "erro" in r:
            linhas.append(f'<tr><td>{r["nome"]}</td><td colspan="3">Indisponível no momento</td></tr>')
            continue
        seta, classe = _seta_e_classe(r["variacao_pct"])
        nome_limpo = r["nome"].replace(" Futuro (B3)", "")
        contrato = r["data"].replace("contrato ", "")
        linhas.append(
            f'<tr><td>{nome_limpo}</td><td>{contrato}</td>'
            f'<td class="val">{r["preco_reais"]}</td>'
            f'<td class="{classe}">{seta} {r["variacao_pct"]}%</td></tr>'
        )
    return "\n        ".join(linhas)


def montar_noticias_html(noticias: list) -> str:
    """Monta os blocos de notícia em destaque."""
    if not noticias:
        return '<p style="opacity:.6;font-size:14px;">Nenhuma notícia de comércio/economia agro encontrada hoje.</p>'
    blocos = []
    for n in noticias:
        blocos.append(
            f'<div class="news-item">\n'
            f'  <p class="news-title"><a href="{n["link"]}" target="_blank" rel="noopener">{n["titulo"]}</a></p>\n'
            f'  <p class="news-summary">{n.get("resumo", "")}</p>\n'
            f'  <p class="news-source">Fonte: {n.get("fonte", "Notícias Agrícolas")}</p>\n'
            f'</div>'
        )
    return "\n    ".join(blocos)


def montar_eyebrow() -> str:
    """Ex: 'Quinta-feira, 09 de julho de 2026 · fechamento do dia anterior'"""
    agora = datetime.now()
    dia_semana = DIAS_SEMANA_PT[agora.weekday()]
    mes = MESES_PT[agora.month - 1]
    return f"{dia_semana}, {agora.day:02d} de {mes} de {agora.year} · fechamento do dia anterior"


def montar_updated(dados: dict) -> str:
    data_referencia = None
    if dados["resultados_commodities"]:
        primeiro_ok = next((r for r in dados["resultados_commodities"] if "erro" not in r), None)
        if primeiro_ok:
            data_referencia = primeiro_ok["data"]
    if not data_referencia:
        data_referencia = datetime.now().strftime("%d/%m/%Y")
    return f"Fonte: CEPEA/Esalq · dado de {data_referencia}"


def _substituir_entre_marcadores(html: str, marcador: str, novo_conteudo: str) -> str:
    """Troca o conteúdo entre <!-- MARCADOR:START --> e <!-- MARCADOR:END -->
    pelo novo_conteudo, mantendo os próprios marcadores no lugar (para
    permitir rodar o gerador várias vezes seguidas sem acumular lixo)."""
    padrao = re.compile(
        rf"(<!-- {marcador}:START -->)(.*?)(<!-- {marcador}:END -->)",
        re.DOTALL,
    )
    if not padrao.search(html):
        raise ValueError(f"Marcador '{marcador}' não encontrado no template - o index.html foi editado?")
    return padrao.sub(lambda m: f"{m.group(1)}\n{novo_conteudo}\n{m.group(3)}", html)


def gerar_site() -> None:
    print("Buscando dados do dia (mesma fonte usada no e-mail)...")
    dados = monitor.coletar_dados()

    print("Salvando snapshot diário em dados/...")
    salvar_snapshot_diario(dados)

    print("Lendo template index.html...")
    with open(CAMINHO_TEMPLATE, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "TICKER": montar_ticker_html(dados["dolar"], dados["resultados_commodities"]),
        "EYEBROW": montar_eyebrow(),
        "UPDATED": montar_updated(dados),
        "PRICES": montar_precos_html(dados["resultados_commodities"]),
        "EXPLAIN": montar_explain_html(dados["explicacoes_macro"]),
        "FUTURES": montar_futuros_html(dados["resultados_futuros"]),
        "NEWS": montar_noticias_html(dados["noticias"]),
    }

    for marcador, conteudo in substituicoes.items():
        html = _substituir_entre_marcadores(html, marcador, conteudo)

    with open(CAMINHO_TEMPLATE, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Site atualizado com sucesso: {CAMINHO_TEMPLATE}")


if __name__ == "__main__":
    gerar_site()
