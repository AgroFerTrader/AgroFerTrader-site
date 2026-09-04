# -*- coding: utf-8 -*-
"""
Gerar Calculadora - AgroFer Trader
====================================
Gera calculadora/index.html: a calculadora de break-even/margem descrita
em agrofer-breakeven-e-pivo-regional-spec.md (Parte 2). Embute, para
soja, milho e café (boi gordo fica de fora - modelo hectares x sacas/ha
não se aplica a pecuária de corte, ver spec seção 7), os dados que a
calculadora precisa e que só o servidor tem: preço físico de hoje,
todos os vencimentos de contrato futuro (já em R$) e a produtividade
média regional de referência. O cálculo em si (fórmulas da seção 4)
roda inteiramente no navegador, em assets/calculadora.js - nada aqui
faz conta de break-even, só busca e formata os dados de entrada.

Uso diário (mesmo padrão de gerar_site.py / gerar_paginas_commodities.py):
    python gerar_calculadora.py
"""

import json
import os

import monitor_agro_v9 as monitor
import gerar_paginas_commodities as gpc
import gerar_site as site

PASTA_SITE = os.path.dirname(os.path.abspath(__file__))
PASTA_CALCULADORA = os.path.join(PASTA_SITE, "calculadora")
CAMINHO_TEMPLATE = os.path.join(PASTA_CALCULADORA, "_template.html")
CAMINHO_PAGINA = os.path.join(PASTA_CALCULADORA, "index.html")

# Pagina "outros modos" (spec, secao 11, Modos B e C) - acessada só por
# um link dentro da calculadora principal; usa os mesmos dados embutidos
# (montar_dados_calculadora_json), so muda o template/pagina.
PASTA_OUTROS_MODOS = os.path.join(PASTA_CALCULADORA, "outros-modos")
CAMINHO_TEMPLATE_OUTROS_MODOS = os.path.join(PASTA_OUTROS_MODOS, "_template.html")
CAMINHO_PAGINA_OUTROS_MODOS = os.path.join(PASTA_OUTROS_MODOS, "index.html")


# ---------------------------------------------------------------------------
# Produtividade média regional (sacas/ha) - fonte CONAB, 10º Levantamento
# da safra 2025/26 (Minas Gerais). Números de referência, não medidos pelo
# site - precisam ser revisados manualmente a cada safra nova (comentário
# de propósito aqui, para não ficar desatualizado por anos sem ninguém
# perceber). Café: estimativa própria da safra 2026 para MG, já em
# sacas/ha (não precisa de conversão t/ha -> sacas/ha).
# ---------------------------------------------------------------------------
PRODUTIVIDADE_MEDIA_REGIONAL = {
    "soja": {
        "sacas_ha": 63,
        "fonte": "CONAB, 10º Levantamento 2025/26 (3,8 t/ha, MG)",
    },
    "milho": {
        "sacas_ha": 112,
        "fonte": "CONAB, 10º Levantamento 2025/26 - 1ª safra (6,7 t/ha, MG)",
    },
    "cafe": {
        "sacas_ha": 28.6,
        "fonte": "Estimativa da safra 2026 para Minas Gerais",
    },
}

# Funrural - alíquota sobre a receita bruta da venda, retida na nota fiscal.
# Muda por lei de tempos em tempos (ex.: alterada em abril/2026 pela LC
# 224/2025) - mantenha ESTE dicionário como o único lugar do código onde
# a alíquota é definida, e confirme o valor vigente com um contador antes
# de publicar uma mudança.
ALIQUOTA_FUNRURAL = {
    "pessoa_fisica": 0.0163,
    "pessoa_juridica": 0.0223,
}

# Endpoint de persistência (Google Apps Script, implantado como Web App
# pelo usuário) - "Salvar meu histórico" (spec seção 4.1). Único lugar do
# código onde essa URL é definida; se o Apps Script for reimplantado com
# uma URL nova, só precisa trocar aqui. Vazio/None desliga a funcionalidade
# de salvar/carregar histórico sem quebrar o resto da calculadora (o
# cálculo e o PDF continuam funcionando sem depender disso).
URL_PERSISTENCIA_CALCULADORA = (
    "https://script.google.com/macros/s/"
    "AKfycbxovPLKOvDgh-yjsIy6ydkZhUsGTaRVavASr_Iim5rFfsQEvmqyr23x3U3NEKuV8O7P/exec"
)

# Culturas cobertas pela calculadora - boi gordo fica de fora (o modelo
# hectares plantados x sacas/ha não se aplica a pecuária de corte, que se
# pensa em cabeças/arrobas/taxa de lotação; ver spec, seção 7, decisão 2).
CULTURAS_CALCULADORA = [
    {"slug": "soja", "nome": "Soja", "nome_fisica": "Soja", "nome_futuro": "Soja Futuro (B3)"},
    {"slug": "milho", "nome": "Milho", "nome_fisica": "Milho", "nome_futuro": "Milho Futuro (B3)"},
    {"slug": "cafe", "nome": "Café Arábica", "nome_fisica": "Café Arábica", "nome_futuro": "Café Arábica Futuro (B3)"},
]


def montar_dados_calculadora(dados: dict) -> dict:
    """Monta o dicionário {culturas: {...}, aliquota_funrural: {...}} que
    vai embutido na página como JSON (ver marcador DADOS_CALCULADORA no
    template) - a única fonte de dados que assets/calculadora.js usa."""
    culturas = {}
    for cfg in CULTURAS_CALCULADORA:
        slug = cfg["slug"]

        preco_fisico_hoje = None
        for r in dados.get("resultados_commodities", []):
            if r.get("nome") == cfg["nome_fisica"] and "erro" not in r:
                try:
                    preco_fisico_hoje = gpc._preco_fisico_para_float(r["preco_reais"])
                except (ValueError, TypeError, KeyError):
                    preco_fisico_hoje = None
                break

        vencimentos = []
        for r in dados.get("resultados_futuros", []):
            if r.get("nome") == cfg["nome_futuro"] and "erro" not in r:
                for v in r.get("vencimentos", []):
                    if v.get("valor_reais") is not None:
                        vencimentos.append({"vencimento": v["vencimento"], "valor_reais": v["valor_reais"]})
                break

        produtividade = PRODUTIVIDADE_MEDIA_REGIONAL[slug]

        culturas[slug] = {
            "nome": cfg["nome"],
            "preco_fisico_hoje": preco_fisico_hoje,
            "vencimentos": vencimentos,
            "produtividade_media_sacas_ha": produtividade["sacas_ha"],
            "produtividade_fonte": produtividade["fonte"],
        }

    return {
        "culturas": culturas,
        "aliquota_funrural": ALIQUOTA_FUNRURAL,
        "url_persistencia": URL_PERSISTENCIA_CALCULADORA,
    }


def montar_dados_calculadora_json(dados: dict) -> str:
    bruto = json.dumps(montar_dados_calculadora(dados), ensure_ascii=False, separators=(",", ":"))
    # Ver comentário equivalente em gerar_paginas_commodities.montar_dados_historico_json:
    # o <script> inteiro precisa estar dentro do marcador, não só o JSON,
    # senão os comentários HTML do marcador viram texto literal dentro do
    # bloco e o JSON.parse do lado do JS quebra.
    return f'<script type="application/json" id="dados-calculadora">{bruto}</script>'


def garantir_pagina_existe() -> None:
    if os.path.exists(CAMINHO_PAGINA):
        return
    os.makedirs(PASTA_CALCULADORA, exist_ok=True)
    with open(CAMINHO_TEMPLATE, encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{DADOS_CALCULADORA_INICIAL}}", "")
    html = html.replace("{{EYEBROW_INICIAL}}", "")
    html = html.replace("{{UPDATED_INICIAL}}", "")
    with open(CAMINHO_PAGINA, "w", encoding="utf-8") as f:
        f.write(html)
    print("Pagina criada: calculadora/index.html")


def atualizar_pagina(dados: dict) -> None:
    garantir_pagina_existe()

    with open(CAMINHO_PAGINA, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "EYEBROW": site.montar_eyebrow(),
        "UPDATED": site.montar_updated(dados),
        "DADOS_CALCULADORA": montar_dados_calculadora_json(dados),
    }
    for marcador, conteudo in substituicoes.items():
        html = site._substituir_entre_marcadores(html, marcador, conteudo)

    with open(CAMINHO_PAGINA, "w", encoding="utf-8") as f:
        f.write(html)

    print("Pagina atualizada: calculadora/index.html")


def garantir_pagina_existe_outros_modos() -> None:
    if os.path.exists(CAMINHO_PAGINA_OUTROS_MODOS):
        return
    os.makedirs(PASTA_OUTROS_MODOS, exist_ok=True)
    with open(CAMINHO_TEMPLATE_OUTROS_MODOS, encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{DADOS_CALCULADORA_INICIAL}}", "")
    html = html.replace("{{EYEBROW_INICIAL}}", "")
    html = html.replace("{{UPDATED_INICIAL}}", "")
    with open(CAMINHO_PAGINA_OUTROS_MODOS, "w", encoding="utf-8") as f:
        f.write(html)
    print("Pagina criada: calculadora/outros-modos/index.html")


def atualizar_pagina_outros_modos(dados: dict) -> None:
    garantir_pagina_existe_outros_modos()

    with open(CAMINHO_PAGINA_OUTROS_MODOS, encoding="utf-8") as f:
        html = f.read()

    substituicoes = {
        "EYEBROW": site.montar_eyebrow(),
        "UPDATED": site.montar_updated(dados),
        "DADOS_CALCULADORA": montar_dados_calculadora_json(dados),
    }
    for marcador, conteudo in substituicoes.items():
        html = site._substituir_entre_marcadores(html, marcador, conteudo)

    with open(CAMINHO_PAGINA_OUTROS_MODOS, "w", encoding="utf-8") as f:
        f.write(html)

    print("Pagina atualizada: calculadora/outros-modos/index.html")


def gerar_calculadora() -> None:
    print("Buscando os mesmos dados do dia usados no resto do site (monitor_agro_v9)...")
    dados = monitor.coletar_dados()
    atualizar_pagina(dados)
    atualizar_pagina_outros_modos(dados)
    print("Calculadora atualizada.")


if __name__ == "__main__":
    gerar_calculadora()
