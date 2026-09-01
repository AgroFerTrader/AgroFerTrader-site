# -*- coding: utf-8 -*-
"""
Gerar Analise Semanal - AgroFer Trader
========================================
Ferramenta de apoio pro "Bloco de Analise da Semana" de cada pagina de
commodity - NAO e um processo automatizado. O fluxo e:

  1. Este script coleta o material bruto da semana (materias completas,
     com data e fonte) direto do Notícias Agrícolas, pra uma
     commodity.
  2. Voce e o Claude leem esse material juntos, numa conversa, e
     discutem o que aconteceu, por que, consequencias, impacto
     B2B/B2C e o que observar - SEMPRE com atribuicao clara a fonte de
     cada fato, nunca inventando nada. So os campos Impacto B2B/B2C
     podem trazer uma leitura de mercado sem fonte direta, e so quando
     houver confianca razoavel - nesse caso, marcada
     "(Leitura da AgroFer Trader)"; sem confianca nem cobertura, o
     campo fica de fora da pagina.
  3. Depois de fechado o texto, as funcoes de escrita deste modulo
     (atualizar_analise_semanal_pagina) gravam o resultado nos
     marcadores da pagina, e o commit/PR seguem o mesmo fluxo manual
     dos outros blocos deste projeto (branch propria, PR pra revisao,
     nunca commit direto na main).

Este modulo NAO chama nenhuma API de IA sozinho e NAO roda via GitHub
Actions - e uma ferramenta de linha de comando pra uso manual, numa
sessao de trabalho.

Uso (so a coleta, pra ler e discutir):
    python gerar_analise_semanal.py --commodity cafe
    python gerar_analise_semanal.py --commodity cafe --dias 7
"""

import argparse
import re
from datetime import datetime, timedelta
from html import escape

import requests

import gerar_paginas_commodities as paginas
import gerar_site as site

CABECALHOS_HTTP = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}


# ---------------------------------------------------------------------------
# 1) COLETA - materias completas da ultima semana, com data real (nao so
#    manchete + primeiro paragrafo, como o scraper diario de noticias
#    usado na secao "Noticias" das paginas).
# ---------------------------------------------------------------------------

def _parse_data_hora_listagem(texto_hora: str) -> datetime | None:
    """Converte o texto de data/hora mostrado na listagem de noticias do
    Notícias Agrícolas para um datetime. A fonte mostra duas variantes:
    'DD/MM/AAAA - HH:MM' para materias de dias anteriores, ou so
    'HH:MM' (sem data) para materias publicadas hoje. Devolve None se o
    texto nao bater com nenhum dos dois formatos (layout mudou)."""
    texto = texto_hora.strip()

    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})\s*-\s*(\d{2}):(\d{2})$", texto)
    if m:
        dia, mes, ano, hora, minuto = (int(g) for g in m.groups())
        try:
            return datetime(ano, mes, dia, hora, minuto)
        except ValueError:
            return None

    m = re.match(r"^(\d{2}):(\d{2})$", texto)
    if m:
        hora, minuto = (int(g) for g in m.groups())
        hoje = datetime.now()
        return hoje.replace(hour=hora, minute=minuto, second=0, microsecond=0)

    return None


def coletar_materias_semana(categoria: str, dias: int = 7, max_candidatos: int = 20) -> list:
    """
    Coleta as materias publicadas nos ultimos `dias` dias na pagina de
    categoria de uma commodity no Notícias Agrícolas, com o TEXTO
    COMPLETO de cada materia - diferente de
    gerar_paginas_commodities.buscar_noticias_por_categoria(), que traz
    so 5 manchetes com um paragrafo de resumo (usado na secao
    "Noticias" das paginas). Aqui o volume e a profundidade precisam
    ser maiores, porque e material de leitura pra discussao, nao so
    exibicao.

    A pagina de categoria tem DOIS padroes de HTML diferentes
    (confirmado inspecionando o HTML real): os cards em destaque no
    topo (<a><div class="destaques-noticias">...<span class="hora">
    ...<h2>) e a lista principal abaixo (<a><span class="hora">...
    <div><h2>) - mas em ambos o <a> e o ancestral comum mais proximo
    que contem tanto o <span class="hora"> quanto o titulo (<h2>/<h3>)
    como descendentes, entao um unico seletor cobre os dois.

    Retorna uma lista de dicts {"titulo", "link", "data" (datetime),
    "corpo" (texto completo, paragrafos concatenados)}, mais recente
    primeiro. Materias sem corpo extraivel sao descartadas.
    """
    from bs4 import BeautifulSoup

    url_lista = f"https://www.noticiasagricolas.com.br/noticias/{categoria}"
    resposta = requests.get(url_lista, headers=CABECALHOS_HTTP, timeout=10)
    resposta.raise_for_status()
    sopa = BeautifulSoup(resposta.text, "lxml")

    limite = datetime.now() - timedelta(days=dias)
    candidatos = []
    links_vistos = set()

    for link_tag in sopa.find_all("a", href=True):
        hora_tag = link_tag.find("span", class_="hora")
        titulo_tag = link_tag.find(["h2", "h3"])
        if not hora_tag or not titulo_tag:
            continue

        href = link_tag["href"]
        if not href or href in links_vistos:
            continue

        data_hora = _parse_data_hora_listagem(hora_tag.get_text(strip=True))
        if data_hora is None or data_hora < limite:
            continue

        links_vistos.add(href)
        if href.startswith("/"):
            href = "https://www.noticiasagricolas.com.br" + href

        candidatos.append({
            "titulo": titulo_tag.get_text(strip=True),
            "link": href,
            "data": data_hora,
        })

        if len(candidatos) >= max_candidatos:
            break

    candidatos.sort(key=lambda c: c["data"], reverse=True)

    materias = []
    for candidata in candidatos:
        try:
            resp_materia = requests.get(candidata["link"], headers=CABECALHOS_HTTP, timeout=10)
            resp_materia.raise_for_status()
            sopa_materia = BeautifulSoup(resp_materia.text, "lxml")
            paragrafos = [
                p.get_text(strip=True)
                for p in sopa_materia.select("p")
                if len(p.get_text(strip=True)) > 40
            ]
            corpo = "\n".join(paragrafos[:12])
        except Exception as e:
            print(f"Aviso: falha ao buscar materia {candidata['link']} ({e})")
            corpo = ""

        if not corpo:
            continue
        materias.append({**candidata, "corpo": corpo})

    return materias


# ---------------------------------------------------------------------------
# 2) MONTAGEM HTML - converte o texto ja discutido/fechado (em conversa)
#    nos mesmos blocos HTML que os marcadores do template esperam.
#    Use estas funcoes manualmente depois de fechar o texto de cada
#    campo - nao ha sintese automatica neste modulo.
# ---------------------------------------------------------------------------

def _paragrafos_html(paragrafos: list) -> str:
    return "\n".join(f"<p>{escape(str(p))}</p>" for p in paragrafos if str(p).strip())


def _campo_opcional_html(titulo: str, paragrafos: list) -> str:
    """Monta o titulo + texto completo de um campo opcional (Impacto
    B2B/B2C). Devolve string vazia quando a lista de paragrafos vier
    vazia - o campo inteiro (titulo incluido) some da pagina nesse caso
    (ver commodities/_template.html, onde o marcador envolve o <h3> +
    o texto juntos, nao so o paragrafo)."""
    if not paragrafos:
        return ""
    corpo = _paragrafos_html(paragrafos)
    return f'<h3>{escape(titulo)}</h3>\n        <div class="analise-texto">{corpo}</div>'


def montar_rodape_fontes(fontes: list, data_atualizacao: datetime) -> str:
    if not fontes:
        return ""
    lista_fontes = ", ".join(escape(str(f)) for f in fontes)
    data_fmt = data_atualizacao.strftime("%d/%m/%Y")
    return f"Fontes consultadas nesta semana: {lista_fontes} · Atualizado em {data_fmt}"


def atualizar_analise_semanal_pagina(
    slug: str,
    resumo_analista: str,
    o_que_aconteceu: list,
    por_que_aconteceu: list,
    consequencias: list,
    impacto_b2b: list,
    impacto_b2c: list,
    o_que_observar: list,
    fontes_consultadas: list,
    grafico_legenda_causa: str = "",
    data_atualizacao: datetime | None = None,
) -> bool:
    """Grava o texto ja fechado (em conversa) nos marcadores da pagina
    commodities/<slug>/index.html. Cada parametro *_lista e uma lista
    de paragrafos (texto simples, sem HTML); impacto_b2b/impacto_b2c
    vazios fazem o card inteiro sumir da pagina."""
    data_atualizacao = data_atualizacao or datetime.now()
    caminho_pagina = f"{paginas.PASTA_COMMODITIES}/{slug}/index.html"

    import os
    if not os.path.exists(caminho_pagina):
        print(f"Aviso: {caminho_pagina} nao existe - rode gerar_paginas_commodities.py primeiro.")
        return False

    with open(caminho_pagina, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "RESUMO_ANALISTA": escape(resumo_analista),
        "ANALISE_O_QUE_ACONTECEU": _paragrafos_html(o_que_aconteceu),
        "ANALISE_POR_QUE_ACONTECEU": _paragrafos_html(por_que_aconteceu),
        "ANALISE_CONSEQUENCIAS": _paragrafos_html(consequencias),
        "ANALISE_IMPACTO_B2B": _campo_opcional_html("Impacto B2B", impacto_b2b),
        "ANALISE_IMPACTO_B2C": _campo_opcional_html("Impacto B2C", impacto_b2c),
        "ANALISE_O_QUE_OBSERVAR": _paragrafos_html(o_que_observar),
        "ANALISE_FONTES": montar_rodape_fontes(fontes_consultadas, data_atualizacao),
        "GRAFICO_LEGENDA_CAUSA": (
            f", {escape(grafico_legenda_causa)}." if grafico_legenda_causa else ""
        ),
    }

    for marcador, conteudo in substituicoes.items():
        html = site._substituir_entre_marcadores(html, marcador, conteudo)

    with open(caminho_pagina, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Analise semanal escrita em commodities/{slug}/index.html")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Coleta as materias da ultima semana de uma commodity, pra leitura/discussao manual."
    )
    parser.add_argument("--commodity", required=True, help="slug da commodity (soja, milho, cafe, boi-gordo)")
    parser.add_argument("--dias", type=int, default=7, help="janela de dias pra tras (padrao: 7)")
    args = parser.parse_args()

    config = next((c for c in paginas.COMMODITIES_PAGINAS if c["slug"] == args.commodity), None)
    if config is None:
        slugs_validos = ", ".join(c["slug"] for c in paginas.COMMODITIES_PAGINAS)
        raise SystemExit(f"Commodity '{args.commodity}' nao encontrada. Opcoes: {slugs_validos}")

    materias = coletar_materias_semana(config["categoria_noticias"], dias=args.dias)
    print(f"=== {config['nome_exibicao']} - {len(materias)} materia(s) nos ultimos {args.dias} dias ===\n")
    for m in materias:
        print(f"### {m['titulo']}")
        print(f"Data: {m['data'].strftime('%d/%m/%Y %H:%M')} | Fonte: Notícias Agrícolas | Link: {m['link']}")
        print(m["corpo"])
        print()
