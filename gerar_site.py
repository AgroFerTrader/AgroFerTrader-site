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
"""

import json
import os
import re
from datetime import datetime
from html import escape

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
    os.makedirs(PASTA_DADOS, exist_ok=True)
    caminho = os.path.join(PASTA_DADOS, f"{datetime.now().strftime('%Y-%m-%d')}.json")
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)


def _seta_e_classe(variacao) -> tuple:
    v = monitor._variacao_para_float(variacao)
    if v is None:
        return ("•", "")
    if v > 0:
        return ("▲", "up")
    if v < 0:
        return ("▼", "down")
    return ("•", "")


def _nome_curto(nome_completo: str) -> str:
    return nome_completo.split(" (")[0].upper()


def montar_ticker_html(dolar, resultados_commodities) -> str:
    itens = []

    if dolar is not None:
        seta, classe = _seta_e_classe(dolar["variacao_pct"])
        itens.append(
            valor_dolar = f"{dolar['valor']:.4f}"
        itens.append(
            f'<span class="item">DÓLAR <b>R$ {escape(valor_dolar)}</b> '
            f'<span class="{classe}">{seta} {abs(dolar["variacao_pct"]):.2f}%</span></span>'
        )

    for r in resultados_commodities:
        if "erro" in r:
            continue

        seta, classe = _seta_e_classe(r["variacao_pct"])
        nome = escape(_nome_curto(r["nome"]))
        preco = escape(str(r["preco_reais"]))
        variacao = escape(str(r["variacao_pct"]))

        itens.append(
            f'<span class="item">{nome} <b>R$ {preco}</b> '
            f'<span class="{classe}">{seta} {variacao}%</span></span>'
        )

    todos = itens + itens
    return "\n      ".join(todos)


def montar_precos_html(resultados_commodities) -> str:
    unidades = {"Boi Gordo": "por arroba"}
    blocos = []

    for r in resultados_commodities:
        nome_original = str(r["nome"])
        nome_limpo = nome_original.split(" (")[0]
        nome_html = escape(nome_limpo)

        if "erro" in r:
            blocos.append(
                f'<article class="price-card">'
                f'<div class="price-name">{nome_html}</div>'
                f'<div class="price-meta">Indisponível no momento</div>'
                f'</article>'
            )
            continue

        seta, classe = _seta_e_classe(r["variacao_pct"])
        unidade = unidades.get(nome_limpo, "por saca de 60kg")

        blocos.append(
            f'<article class="price-card">\n'
            f'  <div class="price-name">{nome_html}</div>\n'
            f'  <div class="price-value">R$ {escape(str(r["preco_reais"]))}</div>\n'
            f'  <div class="price-var {classe}">{seta} {escape(str(r["variacao_pct"]))}%</div>\n'
            f'  <div class="price-meta">{escape(unidade)}</div>\n'
            f'</article>'
        )

    return "\n      ".join(blocos)


def montar_explain_html(explicacoes_macro: list) -> str:
    paragrafos = [
        l for l in explicacoes_macro
        if l and not l.startswith("---")
    ]

    blocos = []
    for p in paragrafos:
        classe = ' class="obs"' if p.startswith("Obs.:") else ""
        blocos.append(f"<p{classe}>{escape(str(p))}</p>")

    return "\n      ".join(blocos)


def montar_futuros_html(resultados_futuros: list) -> str:
    """
    Monta as linhas da tabela de mercado futuro B3.

    IMPORTANTE:
    O monitor continua fazendo todos os cálculos normalmente e entrega
    o resultado final em r["preco_reais"]. Aqui apenas formatamos a
    apresentação para o visitante, removendo fórmulas/conversões internas
    como "(≈ US$ ... x R$ ...)".

    Exemplos exibidos:
      Soja       -> R$ 147,80/sc
      Café       -> R$ 2.105,94/sc
      Milho      -> R$ 71,45/sc
      Boi Gordo  -> R$ 343,35/@
      Dólar      -> R$ 5,1885
    """
    linhas = []

    for r in resultados_futuros:
        nome_original = str(r["nome"])

        if "erro" in r:
            linhas.append(
                f'<tr><td>{escape(nome_original)}</td>'
                f'<td colspan="3">Indisponível no momento</td></tr>'
            )
            continue

        seta, classe = _seta_e_classe(r["variacao_pct"])
        nome_limpo = nome_original.replace(" Futuro (B3)", "")
        contrato = str(r["data"]).replace("contrato ", "")

        # O cálculo permanece no monitor_agro_v9.py.
        # Aqui pegamos somente o resultado final e limpamos qualquer
        # informação auxiliar que eventualmente venha junto.
        preco_final = str(r["preco_reais"]).strip()

        # Remove explicações de conversão/cálculo entre parênteses.
        preco_final = re.sub(r"\s*\([^)]*\)", "", preco_final).strip()

        # Padroniza a unidade de exibição sem alterar o valor calculado.
        nome_normalizado = nome_limpo.lower()

        if "dólar" in nome_normalizado or "dolar" in nome_normalizado:
            # Mantém somente o número final e acrescenta a unidade.
            valor = preco_final.replace("R$/US$", "").replace("R$ /US$", "").strip()
            preco_exibicao = f"{valor} R$/US$"
        elif "boi gordo" in nome_normalizado:
            valor = preco_final.replace("R$/@", "").replace("R$ /@", "").strip()
            preco_exibicao = f"{valor} R$/@"
        else:
            # Soja, milho, trigo, café etc.
            valor = preco_final
            valor = valor.replace("R$/sc 60 kg", "").replace("R$/sc", "").strip()
            valor = valor.replace("/sc 60 kg", "").replace("/sc", "").strip()
            preco_exibicao = f"{valor} R$/sc"

        linhas.append(
            f'<tr><td>{escape(nome_limpo)}</td>'
            f'<td>{escape(contrato)}</td>'
            f'<td class="val">{escape(preco_exibicao)}</td>'
            f'<td class="{classe}">{seta} {escape(str(r["variacao_pct"]))}%</td></tr>'
        )

    return "\n        ".join(linhas)

def montar_noticias_html(noticias: list) -> str:
    if not noticias:
        return (
            '<p style="opacity:.6;font-size:14px;">'
            'Nenhuma notícia de comércio/economia agro encontrada hoje.'
            '</p>'
        )

    blocos = []

    for n in noticias:
        link = escape(str(n.get("link", "")), quote=True)
        titulo = escape(str(n.get("titulo", "")))
        resumo = escape(str(n.get("resumo", "")))
        fonte = escape(str(n.get("fonte", "Notícias Agrícolas")))

        blocos.append(
            f'<article class="news-item">\n'
            f'  <p class="news-title"><a href="{link}" target="_blank" rel="noopener">{titulo}</a></p>\n'
            f'  <p class="news-summary">{resumo}</p>\n'
            f'  <p class="news-source">Fonte: {fonte}</p>\n'
            f'</article>'
        )

    return "\n    ".join(blocos)


def montar_eyebrow() -> str:
    agora = datetime.now()
    dia_semana = DIAS_SEMANA_PT[agora.weekday()]
    mes = MESES_PT[agora.month - 1]

    return (
        f"{dia_semana}, {agora.day:02d} de {mes} de "
        f"{agora.year} · fechamento do dia anterior"
    )


def montar_updated(dados: dict) -> str:
    data_referencia = None

    if dados["resultados_commodities"]:
        primeiro_ok = next(
            (r for r in dados["resultados_commodities"] if "erro" not in r),
            None
        )
        if primeiro_ok:
            data_referencia = primeiro_ok["data"]

    if not data_referencia:
        data_referencia = datetime.now().strftime("%d/%m/%Y")

    return f"Fonte: CEPEA/Esalq · dado de {data_referencia}"


def _substituir_entre_marcadores(html: str, marcador: str, novo_conteudo: str) -> str:
    padrao = re.compile(
        rf"(<!-- {marcador}:START -->)(.*?)(<!-- {marcador}:END -->)",
        re.DOTALL,
    )

    if not padrao.search(html):
        raise ValueError(
            f"Marcador '{marcador}' não encontrado no template - "
            f"o index.html foi editado?"
        )

    return padrao.sub(
        lambda m: f"{m.group(1)}\n{novo_conteudo}\n{m.group(3)}",
        html
    )


def gerar_site() -> None:
    print("Buscando dados do dia (mesma fonte usada no e-mail)...")
    dados = monitor.coletar_dados()

    print("Salvando snapshot diário em dados/...")
    salvar_snapshot_diario(dados)

    print("Lendo template index.html...")
    with open(CAMINHO_TEMPLATE, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "TICKER": montar_ticker_html(
            dados["dolar"],
            dados["resultados_commodities"]
        ),
        "EYEBROW": montar_eyebrow(),
        "UPDATED": montar_updated(dados),
        "PRICES": montar_precos_html(dados["resultados_commodities"]),
        "EXPLAIN": montar_explain_html(dados["explicacoes_macro"]),
        "FUTURES": montar_futuros_html(dados["resultados_futuros"]),
        "NEWS": montar_noticias_html(dados["noticias"]),
    }

    for marcador, conteudo in substituicoes.items():
        html = _substituir_entre_marcadores(
            html,
            marcador,
            conteudo
        )

    with open(CAMINHO_TEMPLATE, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Site atualizado com sucesso: {CAMINHO_TEMPLATE}")


if __name__ == "__main__":
    gerar_site()
