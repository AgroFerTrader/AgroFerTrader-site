# -*- coding: utf-8 -*-
"""
Enviar Newsletter - AgroFer Trader
=====================================
Recurso 3 da especificacao de 5 recursos (setembro/2026). Monta a
campanha semanal por e-mail a partir do MESMO conteudo ja aprovado e
publicado no site (analises/<slug>.md), insere no template
emails/newsletter.html, e envia via API do Brevo.

Este script NUNCA gera texto de analise novo - so reaproveita o que ja
esta em analises/*.md (mesma fonte usada por gerar_paginas_commodities.py)
e pede, na linha de comando, as duas unicas decisoes editoriais que nao
dá pra automatizar sem virar redacao por conta propria: qual commodity
vira a materia principal da semana, e qual o titulo/manchete dela.

SEGURANCA - este script so deve rodar por acionamento manual:
  - Localmente: python enviar_newsletter.py --commodity boi-gordo --titulo "..."
    Sempre mostra a previa completa e pede confirmacao (s/n) antes de
    enviar de verdade.
  - Via GitHub Actions: so em workflow_dispatch (nunca em cron/agendamento
    automatico - ver .github/workflows/enviar_newsletter.yml). Como o
    Actions nao tem terminal interativo pra digitar "s", o workflow exige
    um input booleano "confirmar" explicito (marcado por quem aciona o
    workflow na aba Actions) - sem isso, o script so imprime a previa e
    encerra sem enviar nada.

Uso:
    # ver a previa sem enviar nada (sempre seguro, sem precisar de chave)
    python enviar_newsletter.py --commodity boi-gordo --titulo "Titulo da semana" --dry-run

    # rodar de verdade (interativo, pede confirmacao s/n)
    python enviar_newsletter.py --commodity boi-gordo --titulo "Titulo da semana"
"""

import argparse
import os
import re
import sys
import webbrowser
from datetime import datetime, timedelta
from html import escape

import requests

import gerar_paginas_commodities as gpc

PASTA_SITE = os.path.dirname(os.path.abspath(__file__))
CAMINHO_TEMPLATE_NEWSLETTER = os.path.join(PASTA_SITE, "emails", "newsletter.html")
PASTA_SAIDA = os.path.join(PASTA_SITE, "emails", "_enviados")

# Preencher com os dados reais da conta Brevo antes do primeiro envio de
# verdade - nao sao segredo (diferente da API key, que vem do secret
# BREVO_API_KEY), so precisam ser configurados uma vez.
BREVO_LIST_ID = None  # ID da lista de contatos no Brevo (Contacts > Lists)
BREVO_REMETENTE = {
    "name": "AgroFer Trader",
    "email": "contato@agrofertrader.com",  # precisa ser um remetente verificado no Brevo
}

NOMES_COMMODITY_EMOJI = {
    "soja": "🌱",
    "milho": "🌽",
    "cafe": "☕",
    "boi-gordo": "🐂",
}
NOMES_COMMODITY_EXIBICAO = {
    "soja": "Soja",
    "milho": "Milho",
    "cafe": "Café",
    "boi-gordo": "Boi gordo",
}
SLUGS_VALIDOS = list(NOMES_COMMODITY_EXIBICAO)


def _ler_secoes(slug: str) -> dict:
    """Le analises/<slug>.md e devolve {titulo_secao: corpo_texto_puro},
    reaproveitando o mesmo parser usado para publicar as paginas do site
    (gerar_paginas_commodities._secoes_analise_md) - garante que a
    newsletter usa exatamente o mesmo texto aprovado, nao uma copia
    divergente."""
    caminho = os.path.join(gpc.PASTA_ANALISES, f"{slug}.md")
    if not os.path.exists(caminho):
        raise SystemExit(f"Nao encontrei analises/{slug}.md - rode isso depois de publicar a analise da semana no site.")
    with open(caminho, encoding="utf-8") as f:
        texto_md = f.read()
    return gpc._secoes_analise_md(texto_md)


def _primeiro_paragrafo(corpo: str) -> str:
    blocos = re.split(r"\n\s*\n", corpo.strip())
    return blocos[0].strip().replace("\n", " ") if blocos else ""


def _primeira_frase(texto: str, limite: int = 120) -> str:
    """Primeira frase de um paragrafo (ate o primeiro '. ' ou o texto
    inteiro se for mais curto que isso); se ainda assim ficar mais longa
    que `limite`, corta na ultima palavra inteira antes do limite (nunca
    no meio de uma palavra) e acrescenta reticencias - usado só nos
    resumos curtos de 'tambem nesta semana', nunca no corpo principal."""
    frase = re.split(r"(?<=[.!?])\s+", texto.strip())[0]
    if len(frase) <= limite:
        return frase
    cortada = frase[:limite]
    # Prefere cortar numa pontuacao de pausa (vírgula, travessão, ponto e
    # vírgula) perto do limite - corte mais natural que parar em
    # qualquer palavra, contanto que nao jogue fora mais de 1/3 do texto
    # disponivel so por causa disso.
    melhor_corte = max(
        cortada.rfind(","), cortada.rfind(" — "), cortada.rfind(";"), cortada.rfind(":")
    )
    if melhor_corte > limite * 0.6:
        cortada = cortada[:melhor_corte]
    else:
        ultimo_espaco = cortada.rfind(" ")
        if ultimo_espaco > 0:
            cortada = cortada[:ultimo_espaco]
    return cortada.rstrip(" ,;:—-") + "…"


def _formatar_periodo_semana(hoje: datetime) -> str:
    """'1 a 5 de setembro de 2026' - segunda a sexta da semana de `hoje`,
    em portugues. Puramente mecanico (so calcula datas), nao decide nada
    sobre o conteudo."""
    meses = [
        "janeiro", "fevereiro", "março", "abril", "maio", "junho",
        "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
    ]
    segunda = hoje - timedelta(days=hoje.weekday())
    sexta = segunda + timedelta(days=4)
    if segunda.month == sexta.month:
        return f"{segunda.day} a {sexta.day} de {meses[segunda.month - 1]} de {segunda.year}"
    return (
        f"{segunda.day} de {meses[segunda.month - 1]} a "
        f"{sexta.day} de {meses[sexta.month - 1]} de {sexta.year}"
    )


def montar_html_newsletter(slug_principal: str, titulo: str, data_referencia: datetime) -> str:
    """Monta o HTML final da campanha: le o template aprovado
    (emails/newsletter.html) e substitui só os trechos variáveis (período,
    título, corpo, caixa de observação, resumo das outras 3 commodities) -
    todo o texto inserido vem de analises/*.md, já publicado e aprovado."""
    if slug_principal not in SLUGS_VALIDOS:
        raise SystemExit(f"Commodity '{slug_principal}' invalida. Opcoes: {', '.join(SLUGS_VALIDOS)}")

    with open(CAMINHO_TEMPLATE_NEWSLETTER, encoding="utf-8") as f:
        html = f.read()

    secoes_principal = _ler_secoes(slug_principal)
    _, corpo_o_que = gpc._secao_por_prefixo(secoes_principal, "O que aconteceu")
    _, corpo_por_que = gpc._secao_por_prefixo(secoes_principal, "Por que aconteceu")
    _, corpo_observar = gpc._secao_por_prefixo(secoes_principal, "O que observar")

    paragrafo_corpo_1 = escape(_primeiro_paragrafo(corpo_o_que), quote=False)
    paragrafo_corpo_2 = escape(_primeiro_paragrafo(corpo_por_que), quote=False)
    texto_observar = escape(_primeiro_paragrafo(corpo_observar), quote=False)

    periodo = _formatar_periodo_semana(data_referencia)

    def _substituir_obrigatorio(padrao: str, repl, texto: str, rotulo: str) -> str:
        """Como re.sub, mas ESTOURA erro se o padrao nao casar - uma
        substituicao que falha silenciosamente aqui significa mandar a
        newsletter com o texto de exemplo do template (ja aconteceu:
        commodity errada aparecendo no corpo do e-mail porque o regex
        antigo nao batia com a estrutura real do HTML e o re.sub, sem
        contagem checada, simplesmente devolvia o texto original sem
        avisar nada)."""
        novo_texto, n = re.subn(padrao, repl, texto, count=1, flags=re.DOTALL)
        if n != 1:
            raise SystemExit(
                f"Falha ao montar a newsletter: o marcador '{rotulo}' não foi "
                f"encontrado em emails/newsletter.html (o template pode ter mudado "
                f"de estrutura - ajuste o regex correspondente em enviar_newsletter.py)."
            )
        return novo_texto

    # 1) Selo de edicao (periodo da semana)
    html = _substituir_obrigatorio(
        r"Análise Semanal · [^<]*",
        f"Análise Semanal · {periodo}",
        html,
        "selo de período",
    )

    # 2) Titulo principal (H1) - o template de exemplo usa <br> pra quebrar
    # em duas linhas; aqui deixamos o titulo inteiro numa linha só e o
    # <br> cuidando da quebra visual se o texto for longo o bastante.
    html = _substituir_obrigatorio(
        r'(<h1 style="[^"]*">)\s*.*?\s*(</h1>)',
        lambda m: m.group(1) + "\n              " + escape(titulo, quote=False) + m.group(2),
        html,
        "título (H1)",
    )

    # 3) Corpo - ancorado no proprio marcador <!-- CORPO --> e no <td>
    # logo em seguida (nao no que vem DEPOIS do corpo, que e o que
    # quebrou antes: o template nao tem um </table> ali, so </td></tr>).
    html = _substituir_obrigatorio(
        r'(<!-- CORPO -->\s*<tr>\s*<td style="[^"]*">)\s*.*?\s*(</td>\s*</tr>)',
        lambda m: m.group(1) + "\n            " + paragrafo_corpo_1 + "\n            <br><br>\n            " + paragrafo_corpo_2 + "\n          " + m.group(2),
        html,
        "corpo (CORPO)",
    )

    # 4) Caixa "O QUE OBSERVAR" - ancorada no texto literal "O QUE
    # OBSERVAR</div>" (unico na pagina) e no <div> seguinte.
    html = _substituir_obrigatorio(
        r'(O QUE OBSERVAR</div>\s*<div style="[^"]*">)\s*.*?\s*(</div>)',
        lambda m: m.group(1) + "\n                    " + texto_observar + "\n                  " + m.group(2),
        html,
        "caixa O QUE OBSERVAR",
    )

    # 5) "Tambem nesta semana" - as outras 3 commodities, resumidas em uma
    # frase cada (a primeira frase de "O que aconteceu" de cada uma,
    # excerto literal - nao e sintese nova).
    outras = [s for s in SLUGS_VALIDOS if s != slug_principal]
    linhas = []
    for slug in outras:
        secoes = _ler_secoes(slug)
        _, corpo = gpc._secao_por_prefixo(secoes, "O que aconteceu")
        resumo = escape(_primeira_frase(_primeiro_paragrafo(corpo)), quote=False)
        emoji = NOMES_COMMODITY_EMOJI[slug]
        nome = NOMES_COMMODITY_EXIBICAO[slug]
        ultima = slug == outras[-1]
        borda = "" if ultima else " border-bottom:1px solid #F0EEE6;"
        linhas.append(
            f'<tr>\n                <td style="padding: 8px 0;{borda} font-size:14px; color:#34382F;">'
            f"{emoji} <strong>{nome}</strong> — {resumo}</td>\n              </tr>"
        )

    html = _substituir_obrigatorio(
        r'(Também nesta semana\s*</div>\s*<table[^>]*>)\s*.*?\s*(</table>)',
        lambda m: m.group(1) + "\n              " + "\n              ".join(linhas) + "\n            " + m.group(2),
        html,
        "lista Também nesta semana",
    )

    return html


def salvar_preview(html: str, slug_principal: str) -> str:
    os.makedirs(PASTA_SAIDA, exist_ok=True)
    nome_arquivo = f"preview_{slug_principal}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.html"
    caminho = os.path.join(PASTA_SAIDA, nome_arquivo)
    with open(caminho, "w", encoding="utf-8") as f:
        f.write(html)
    return caminho


def _extrair_texto_plano_para_preview(html: str) -> str:
    """Resumo em texto puro (assunto + primeiras linhas do corpo) pra
    mostrar no terminal - a previa visual completa fica no arquivo HTML
    salvo/aberto no navegador."""
    m_titulo = re.search(r'<h1[^>]*>\s*(.*?)\s*</h1>', html, re.DOTALL)
    titulo = re.sub(r"<[^>]+>", " ", m_titulo.group(1)).strip() if m_titulo else "(titulo nao encontrado)"
    m_periodo = re.search(r"Análise Semanal · ([^<]*)", html)
    periodo = m_periodo.group(1).strip() if m_periodo else "?"
    return f"Assunto: {titulo}\nPeríodo: {periodo}"


def enviar_campanha_brevo(html: str, titulo: str, api_key: str) -> None:
    if not BREVO_LIST_ID:
        raise SystemExit(
            "BREVO_LIST_ID nao configurado - edite a constante no topo deste "
            "arquivo com o ID da lista de contatos (Brevo > Contacts > Lists)."
        )

    cabecalhos = {"api-key": api_key, "Content-Type": "application/json", "Accept": "application/json"}

    payload_campanha = {
        "name": f"Newsletter - {titulo} ({datetime.now().strftime('%d/%m/%Y')})",
        "subject": titulo,
        "sender": BREVO_REMETENTE,
        "type": "classic",
        "htmlContent": html,
        "recipients": {"listIds": [BREVO_LIST_ID]},
    }
    resposta = requests.post(
        "https://api.brevo.com/v3/emailCampaigns", json=payload_campanha, headers=cabecalhos, timeout=30
    )
    resposta.raise_for_status()
    campanha_id = resposta.json()["id"]
    print(f"Campanha criada no Brevo (id {campanha_id}). Disparando envio...")

    resposta_envio = requests.post(
        f"https://api.brevo.com/v3/emailCampaigns/{campanha_id}/sendNow", headers=cabecalhos, timeout=30
    )
    resposta_envio.raise_for_status()
    print("Envio disparado com sucesso.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Monta e envia a newsletter semanal (Recurso 3).")
    parser.add_argument("--commodity", required=True, choices=SLUGS_VALIDOS, help="Commodity que vira a materia principal da semana")
    parser.add_argument("--titulo", required=True, help="Titulo/manchete da newsletter (decisao editorial, nao gerada automaticamente)")
    parser.add_argument("--dry-run", action="store_true", help="So gera e salva a previa, nunca envia (nao precisa de API key)")
    parser.add_argument(
        "--confirmar",
        action="store_true",
        help="Pula a pergunta interativa s/n - use SO em automação explicitamente acionada (ex.: workflow_dispatch com input 'confirmar' marcado)",
    )
    args = parser.parse_args()

    html = montar_html_newsletter(args.commodity, args.titulo, datetime.now())
    caminho_preview = salvar_preview(html, args.commodity)

    print("=" * 70)
    print("PRÉVIA DA NEWSLETTER")
    print("=" * 70)
    print(_extrair_texto_plano_para_preview(html))
    print(f"\nPrévia completa salva em: {caminho_preview}")
    print("=" * 70)

    if args.dry_run:
        print("\n--dry-run: nada foi enviado.")
        try:
            webbrowser.open(f"file://{caminho_preview}")
        except Exception:
            pass
        return

    api_key = os.environ.get("BREVO_API_KEY")
    if not api_key:
        raise SystemExit(
            "Variável de ambiente BREVO_API_KEY não encontrada. Configure-a antes de "
            "rodar sem --dry-run (localmente: export/set BREVO_API_KEY=...; no "
            "GitHub Actions, já vem do secret configurado)."
        )

    if args.confirmar:
        print("\n--confirmar informado: prosseguindo com o envio sem pergunta interativa.")
    elif sys.stdin.isatty():
        try:
            webbrowser.open(f"file://{caminho_preview}")
        except Exception:
            pass
        resposta = input("\nConfirma o ENVIO REAL desta campanha para toda a lista? (s/n): ").strip().lower()
        if resposta != "s":
            print("Envio cancelado.")
            return
    else:
        print(
            "\nSessão não interativa e --confirmar não foi informado - "
            "encerrando SEM enviar (isso é o comportamento esperado em CI "
            "sem confirmação explícita)."
        )
        return

    enviar_campanha_brevo(html, args.titulo, api_key)


if __name__ == "__main__":
    main()
