# -*- coding: utf-8 -*-
"""
Gerar Analise Semanal - AgroFer Trader
========================================
Gera o bloco "Analise da Semana" (os 6 campos: O que aconteceu, Por que
aconteceu, Consequencias no mercado, Impacto B2B, Impacto B2C, O que
observar) de cada pagina de commodity, a partir de materias reais
publicadas na ultima semana no Notícias Agrícolas.

PREMISSA CENTRAL: este script NAO cria opiniao ou analise propria. Ele
consolida e reorganiza o que as proprias fontes ja noticiaram na
semana, com atribuicao clara a cada uma. A unica excecao controlada sao
os campos Impacto B2B/Impacto B2C: quando as fontes nao cobrirem esse
angulo, uma leitura de mercado pode ser proposta com base em
conhecimento geral (nunca inventando fato/numero), mas SEMPRE rotulada
"(Leitura da AgroFer Trader)" para nao ser confundida com reportagem -
e so quando houver confianca razoavel; sem confianca, o campo fica de
fora da pagina (nao aparece card nenhum), em vez de mostrar algo vago.

Como a sintese exige interpretar texto (juntar fatos, separar causas,
notar divergencia entre fontes) - trabalho que um script determinístico
nao faz sozinho -, este modulo chama a API da Claude (Anthropic) para
essa etapa. O scraping em si (coletar as materias) e puro Python, sem
IA.

NAO PUBLICA nada direto no site ao vivo: escreve o resultado nas
paginas commodities/<slug>/index.html de uma COPIA local do repositorio
(o workflow do GitHub Actions que chama este script roda numa branch
nova, commita e abre um Pull Request - nunca commita direto na main).
Alguem (voce) revisa o PR e decide mergear ou pedir ajuste.

Requisitos (alem dos do monitor_agro_v9.py): pip install anthropic
Variavel de ambiente obrigatoria: ANTHROPIC_API_KEY

Uso:
    python gerar_analise_semanal.py
    python gerar_analise_semanal.py --commodity cafe   (so uma, pra testar)
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta
from html import escape

import requests

import gerar_paginas_commodities as paginas
import gerar_site as site
import monitor_agro_v9 as monitor

MODELO_CLAUDE = "claude-opus-5"

CABECALHOS_HTTP = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}


# ---------------------------------------------------------------------------
# 1) COLETA - materias completas da ultima semana, com data real (nao so
#    manchete + primeiro paragrafo, como o scraper diario de noticias).
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
    ser maiores, porque o texto completo e a materia-prima da sintese
    feita pela IA.

    A pagina de categoria mistem DOIS padroes de listagem diferentes
    (confirmado inspecionando o HTML real) - os cards em destaque no
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
# 2) SINTESE - chamada a API da Claude para consolidar as materias da
#    semana nos 6 campos do bloco de analise, com atribuicao.
# ---------------------------------------------------------------------------

INSTRUCOES_SINTESE = """Você é o processo editorial do AgroFer Trader, um site de \
inteligência e análise de mercado agrícola. Toda semana, você recebe um \
conjunto de matérias jornalísticas REAIS (título, data, fonte, texto \
completo) publicadas na última semana sobre UMA commodity. Sua tarefa é \
CONSOLIDAR e REORGANIZAR o que essas fontes já noticiaram - nunca criar \
opinião ou análise própria além do que a regra 4 permite explicitamente.

REGRAS OBRIGATÓRIAS:

1. Cada frase nos campos "o_que_aconteceu", "por_que_aconteceu", \
"consequencias" e "o_que_observar" deve vir DIRETAMENTE do conteúdo das \
matérias fornecidas, reescrita com suas próprias palavras (nunca copiada \
literalmente), com atribuição clara à fonte e, quando disponível, à data \
(ex.: "segundo Notícias Agrícolas, 26/08"). NÃO invente causas, números \
ou eventos que não estejam nas matérias.

2. Se as fontes divergirem sobre a causa de um movimento, registre a \
divergência explicitamente em vez de escolher uma versão só.

3. Se não houver material suficiente nas matérias fornecidas para \
preencher "o_que_aconteceu", "por_que_aconteceu", "consequencias" ou \
"o_que_observar", o(s) parágrafo(s) desse campo deve(m) dizer isso \
explicitamente (ex.: "Não houve cobertura suficiente das fontes sobre X \
nesta semana") - nunca preencher com texto genérico ou vago. Esses 4 \
campos NUNCA ficam com array vazio - sempre pelo menos um parágrafo,\
mesmo que seja só para admitir a falta de cobertura.

4. EXCEÇÃO específica para "impacto_b2b" e "impacto_b2c": se as \
matérias não cobrirem esse ângulo, você TEM PERMISSÃO de escrever uma \
leitura provável baseada no seu conhecimento geral de mercado - MAS \
SOMENTE quando tiver confiança razoável na afirmação, e ela deve ser \
CLARAMENTE marcada com o prefixo "(Leitura da AgroFer Trader)" em vez \
de atribuída a uma fonte. Se você não tiver confiança suficiente NEM \
cobertura das fontes, devolva um array VAZIO [] para esse campo - não \
escreva nada, nem um placeholder. Um card vazio não aparece na página \
(é o comportamento esperado, não um erro).

5. "resumo_analista": 2-3 linhas, tom de manchete de analista, \
resumindo o que aconteceu e por quê nesta semana - ainda baseado só no \
que está nas matérias (mesma regra 1).

6. "grafico_legenda_causa": uma frase curta (uma linha, sem ponto final \
no início, começando com letra minúscula, ex.: "puxada pela realização \
de lucros após a disparada de segunda-feira") complementando um dado de \
variação percentual que já foi calculado separadamente - não repita o \
número aqui, só a causa, com atribuição.

7. "fontes_consultadas": liste os nomes das fontes (ex.: "Notícias \
Agrícolas") efetivamente usadas para preencher os campos acima - não \
liste fontes só mencionadas de passagem sem uso real no texto.

8. "cobertura_suficiente": true se havia matérias suficientes para \
produzir uma análise minimamente completa desta semana; false se as \
matérias fornecidas eram claramente insuficientes (poucas ou \
irrelevantes) para qualquer leitura confiável - nesse caso os campos \
"o_que_aconteceu" etc. devem apenas registrar a falta de cobertura \
(regra 3), sem forçar uma narrativa.

FORMATO: cada campo de texto é uma lista de parágrafos em texto simples \
(sem HTML, sem markdown), em português do Brasil. Um parágrafo por item \
da lista."""

SCHEMA_SINTESE = {
    "type": "object",
    "properties": {
        "cobertura_suficiente": {"type": "boolean"},
        "resumo_analista": {"type": "string"},
        "o_que_aconteceu": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "por_que_aconteceu": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "consequencias": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "impacto_b2b": {"type": "array", "items": {"type": "string"}},
        "impacto_b2c": {"type": "array", "items": {"type": "string"}},
        "o_que_observar": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "grafico_legenda_causa": {"type": "string"},
        "fontes_consultadas": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "cobertura_suficiente", "resumo_analista", "o_que_aconteceu",
        "por_que_aconteceu", "consequencias", "impacto_b2b", "impacto_b2c",
        "o_que_observar", "grafico_legenda_causa", "fontes_consultadas",
    ],
    "additionalProperties": False,
}


def _montar_prompt_materias(nome_exibicao: str, materias: list) -> str:
    partes = [f"Commodity: {nome_exibicao}\n"]
    for m in materias:
        partes.append(
            f"### {m['titulo']}\n"
            f"Fonte: Notícias Agrícolas | Data: {m['data'].strftime('%d/%m/%Y %H:%M')} | "
            f"Link: {m['link']}\n"
            f"{m['corpo']}\n"
        )
    return "\n".join(partes)


def sintetizar_analise_semanal(nome_exibicao: str, materias: list) -> dict | None:
    """Chama a API da Claude para consolidar as materias da semana nos 6
    campos do bloco de analise. Devolve None se nao houver materia
    nenhuma (nesse caso nao vale a pena nem chamar a API)."""
    if not materias:
        return None

    import anthropic

    client = anthropic.Anthropic()
    resposta = client.messages.create(
        model=MODELO_CLAUDE,
        max_tokens=8000,
        system=INSTRUCOES_SINTESE,
        messages=[{
            "role": "user",
            "content": _montar_prompt_materias(nome_exibicao, materias),
        }],
        output_config={
            "effort": "high",
            "format": {"type": "json_schema", "schema": SCHEMA_SINTESE},
        },
    )

    texto = next(b.text for b in resposta.content if b.type == "text")
    return json.loads(texto)


# ---------------------------------------------------------------------------
# 3) MONTAGEM HTML - converte o resultado estruturado da IA nos mesmos
#    blocos HTML que os marcadores do template esperam.
# ---------------------------------------------------------------------------

def _paragrafos_html(paragrafos: list) -> str:
    return "\n".join(f"<p>{escape(str(p))}</p>" for p in paragrafos if str(p).strip())


def _campo_opcional_html(titulo: str, paragrafos: list) -> str:
    """Monta o <article> completo de um campo opcional (Impacto B2B/B2C).
    Devolve string vazia quando a lista de paragrafos vier vazia - o
    card inteiro some da pagina nesse caso (ver commodities/_template.html,
    onde o marcador envolve o <article> inteiro, nao so o texto)."""
    if not paragrafos:
        return ""
    corpo = _paragrafos_html(paragrafos)
    return (
        '<article class="analise-campo">\n'
        f'        <h3>{escape(titulo)}</h3>\n'
        f'        <div class="analise-corpo">{corpo}</div>\n'
        '      </article>'
    )


def montar_rodape_fontes(fontes: list, data_atualizacao: datetime) -> str:
    if not fontes:
        return ""
    lista_fontes = ", ".join(escape(str(f)) for f in fontes)
    data_fmt = data_atualizacao.strftime("%d/%m/%Y")
    return f"Fontes consultadas nesta semana: {lista_fontes} · Atualizado em {data_fmt}"


# ---------------------------------------------------------------------------
# 4) ESCRITA - grava o resultado nos marcadores da pagina da commodity.
#    Estes marcadores NAO fazem parte do dict `substituicoes` do
#    gerador diario (gerar_paginas_commodities.py) - so este script os
#    toca, uma vez por semana, e sempre numa branch/PR separada (nunca
#    direto na pagina publicada).
# ---------------------------------------------------------------------------

def atualizar_analise_semanal_pagina(config: dict, sintese: dict, data_atualizacao: datetime) -> bool:
    caminho_pagina = os.path.join(paginas.PASTA_COMMODITIES, config["slug"], "index.html")
    if not os.path.exists(caminho_pagina):
        print(f"Aviso: {caminho_pagina} nao existe - rode gerar_paginas_commodities.py primeiro.")
        return False

    with open(caminho_pagina, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "RESUMO_ANALISTA": escape(sintese["resumo_analista"]),
        "ANALISE_O_QUE_ACONTECEU": _paragrafos_html(sintese["o_que_aconteceu"]),
        "ANALISE_POR_QUE_ACONTECEU": _paragrafos_html(sintese["por_que_aconteceu"]),
        "ANALISE_CONSEQUENCIAS": _paragrafos_html(sintese["consequencias"]),
        "ANALISE_IMPACTO_B2B": _campo_opcional_html("Impacto B2B", sintese["impacto_b2b"]),
        "ANALISE_IMPACTO_B2C": _campo_opcional_html("Impacto B2C", sintese["impacto_b2c"]),
        "ANALISE_O_QUE_OBSERVAR": _paragrafos_html(sintese["o_que_observar"]),
        "ANALISE_FONTES": montar_rodape_fontes(sintese["fontes_consultadas"], data_atualizacao),
        "GRAFICO_LEGENDA_CAUSA": (
            f", {escape(sintese['grafico_legenda_causa'])}."
            if sintese.get("grafico_legenda_causa") else ""
        ),
    }

    for marcador, conteudo in substituicoes.items():
        html = site._substituir_entre_marcadores(html, marcador, conteudo)

    with open(caminho_pagina, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Analise semanal escrita em commodities/{config['slug']}/index.html")
    return True


# ---------------------------------------------------------------------------
# 5) ORQUESTRACAO
# ---------------------------------------------------------------------------

def gerar_analise_semanal(slugs: list | None = None) -> list:
    """Roda o pipeline completo (coleta -> sintese -> escrita) para as
    commodities pedidas (todas, se slugs vier None). Devolve a lista dos
    slugs que de fato tiveram a pagina atualizada, para o workflow do
    GitHub Actions decidir se vale a pena commitar/abrir PR."""
    agora = datetime.now()
    atualizados = []

    for config in paginas.COMMODITIES_PAGINAS:
        if slugs and config["slug"] not in slugs:
            continue

        print(f"=== {config['nome_exibicao']} ===")
        try:
            materias = coletar_materias_semana(config["categoria_noticias"])
        except Exception as e:
            print(f"Aviso: falha ao coletar materias de {config['slug']} ({e})")
            continue

        print(f"{len(materias)} materia(s) da ultima semana encontrada(s).")
        if not materias:
            print("Sem materias suficientes - pulando esta commodity.")
            continue

        try:
            sintese = sintetizar_analise_semanal(config["nome_exibicao"], materias)
        except Exception as e:
            print(f"Aviso: falha ao sintetizar analise de {config['slug']} ({e})")
            continue

        if sintese is None:
            continue

        if atualizar_analise_semanal_pagina(config, sintese, agora):
            atualizados.append(config["slug"])

    return atualizados


if __name__ == "__main__":
    filtro = None
    if "--commodity" in sys.argv:
        filtro = [sys.argv[sys.argv.index("--commodity") + 1]]

    slugs_atualizados = gerar_analise_semanal(filtro)

    if slugs_atualizados:
        print(f"\nConcluido. Paginas atualizadas: {', '.join(slugs_atualizados)}")
    else:
        print("\nNenhuma pagina foi atualizada nesta rodada.")
