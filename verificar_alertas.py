# -*- coding: utf-8 -*-
"""
Verificar Alertas de Preço - AgroFer Trader
===============================================
Recurso 4 da especificacao de 5 recursos (setembro/2026). Le a planilha
de alertas (Google Sheets, criada a partir de um Google Forms) e, para
cada linha ainda nao notificada, compara o preco CEPEA do dia daquela
commodity com o valor-alvo cadastrado. Quando o criterio e atingido,
dispara um e-mail padronizado via Brevo e marca a linha como notificada.

Diferente de enviar_newsletter.py, este script RODA AUTOMATICAMENTE
(via GitHub Actions, uma vez por dia) porque nao envolve nenhuma decisao
editorial - e so uma comparacao numerica objetiva (preco de hoje vs.
valor cadastrado) e o disparo de um e-mail com texto fixo, sempre igual
na estrutura, só trocando os números.

Configuracao necessaria antes do primeiro uso (ver constantes abaixo):
  - PLANILHA_ALERTAS_ID: o ID da planilha do Google Sheets (o trecho da
    URL entre "/d/" e "/edit").
  - GOOGLE_SHEETS_CREDENTIALS (variavel de ambiente/secret): o JSON
    completo da credencial de conta de servico, com acesso de leitura E
    escrita na planilha (compartilhada com o "client_email" dela).
  - BREVO_API_KEY (variavel de ambiente/secret): ja usada por
    enviar_newsletter.py.

Uso:
    python verificar_alertas.py             # roda de verdade
    python verificar_alertas.py --dry-run   # so mostra o que faria, sem
                                             # enviar e-mail nem escrever
                                             # na planilha
"""

import argparse
import json
import os
import re
import unicodedata
from html import escape

import gspread
import requests
from google.oauth2.service_account import Credentials

import gerar_paginas_commodities as gpc
import monitor_agro_v9 as monitor

PASTA_SITE = os.path.dirname(os.path.abspath(__file__))
CAMINHO_TEMPLATE_ALERTA = os.path.join(PASTA_SITE, "emails", "alerta-preco.html")

# Preencher com o ID real da planilha (Google Sheets > Compartilhar >
# copiar link > o trecho entre "/d/" e "/edit") antes do primeiro uso.
PLANILHA_ALERTAS_ID = "SUA_PLANILHA_ID_AQUI"

ESCOPOS_GOOGLE = [
    "https://www.googleapis.com/auth/spreadsheets",
]

BREVO_REMETENTE = {
    "name": "AgroFer Trader",
    "email": "contato@agrofertrader.com",  # precisa ser um remetente verificado no Brevo
}

# Mapeia o texto que pode aparecer na coluna "commodity" da planilha
# (o que a pessoa escolheu no Google Forms) para o slug interno usado
# pelo resto do site, e para o nome exatamente como aparece em
# resultados_commodities (monitor_agro_v9). Case/acentos sao ignorados
# na comparacao (ver _normalizar).
COMMODITIES_ALERTA = {
    "soja": {"slug": "soja", "nome_fisica": "Soja"},
    "milho": {"slug": "milho", "nome_fisica": "Milho"},
    "cafe": {"slug": "cafe", "nome_fisica": "Café Arábica"},
    "boi gordo": {"slug": "boi-gordo", "nome_fisica": "Boi Gordo"},
    "boi-gordo": {"slug": "boi-gordo", "nome_fisica": "Boi Gordo"},
}

# Nomes de coluna aceitos na planilha, por campo - comparados ja
# normalizados (sem acento, minusculo, sem espaco extra). Cobre as
# variacoes mais prováveis de como o Google Forms pode ter nomeado cada
# pergunta, sem depender de um texto exato.
COLUNAS_ACEITAS = {
    "email": ["email", "e-mail", "seu email", "seu e-mail"],
    "commodity": ["commodity", "cultura", "produto"],
    "direcao": ["direcao", "direção", "quando avisar"],
    "valor_alvo": ["valor_alvo", "valor alvo", "valor de referencia", "valor de referência", "preco alvo", "preço alvo"],
    "notificado": ["notificado", "notificado (sim/nao)", "notificado (sim/não)"],
}


def _normalizar(texto: str) -> str:
    texto = unicodedata.normalize("NFD", str(texto or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", texto).strip().lower()


def _mapear_colunas(cabecalho: list) -> dict:
    """Devolve {campo_interno: nome_real_da_coluna}, casando os nomes
    reais do cabecalho da planilha (linha 1) contra COLUNAS_ACEITAS -
    assim o script nao quebra se o Google Forms tiver nomeado a coluna
    com um texto ligeiramente diferente do esperado."""
    normalizados = {_normalizar(col): col for col in cabecalho}
    mapa = {}
    faltando = []
    for campo, aceitos in COLUNAS_ACEITAS.items():
        encontrado = next((normalizados[a] for a in aceitos if a in normalizados), None)
        if encontrado is None:
            faltando.append(campo)
        else:
            mapa[campo] = encontrado
    if faltando:
        raise SystemExit(
            f"Não encontrei a(s) coluna(s) {faltando} no cabeçalho da planilha "
            f"({cabecalho}). Ajuste COLUNAS_ACEITAS em verificar_alertas.py "
            f"para incluir o nome real usado."
        )
    return mapa


def _eh_notificado(valor: str) -> bool:
    return _normalizar(valor) in ("sim", "s", "true", "yes", "1")


def _direcao_e_subida(direcao: str) -> bool:
    """True = 'avisar quando subir acima de'; False = 'avisar quando cair
    abaixo de'. Aceita qualquer frase que contenha 'subir'/'acima' ou
    'cair'/'abaixo', sem depender do texto exato da pergunta no Forms."""
    d = _normalizar(direcao)
    if "sub" in d or "acima" in d or "alta" in d:
        return True
    if "cai" in d or "abaixo" in d or "baixa" in d or "queda" in d:
        return False
    raise ValueError(f"Não entendi a direção do alerta: '{direcao}' (esperava algo com 'subir'/'acima' ou 'cair'/'abaixo').")


def avaliar_alerta(direcao: str, valor_alvo: float, preco_hoje: float) -> bool:
    """Funcao pura (sem I/O) que decide se um alerta deve disparar hoje -
    separada do resto pra dar pra testar sem planilha nem rede."""
    if _direcao_e_subida(direcao):
        return preco_hoje >= valor_alvo
    return preco_hoje <= valor_alvo


def _obter_precos_hoje() -> dict:
    """{slug: preco_float} pros 4 nomes_fisica usados em
    resultados_commodities - mesma fonte que o resto do site (CEPEA/Esalq
    via monitor_agro_v9), pra o alerta nunca divergir do preco mostrado
    nas paginas de commodity."""
    dados = monitor.coletar_dados()
    precos = {}
    for cfg in COMMODITIES_ALERTA.values():
        slug = cfg["slug"]
        if slug in precos:
            continue
        for r in dados.get("resultados_commodities", []):
            if r.get("nome") == cfg["nome_fisica"] and "erro" not in r:
                try:
                    precos[slug] = gpc._preco_fisico_para_float(r["preco_reais"])
                except (ValueError, TypeError, KeyError):
                    pass
                break
    return precos


def montar_email_alerta(commodity_nome: str, commodity_slug: str, direcao: str, valor_alvo: float, preco_hoje: float) -> tuple:
    """Devolve (assunto, html) do e-mail de alerta, a partir do template
    emails/alerta-preco.html - texto sempre no mesmo formato fixo, so
    trocando os numeros (nunca uma leitura nova sobre o motivo do preco
    ter se movido - regra editorial da spec, secao 4.1)."""
    with open(CAMINHO_TEMPLATE_ALERTA, encoding="utf-8") as f:
        html = f.read()

    verbo = "atingiu ou superou" if _direcao_e_subida(direcao) else "atingiu ou ficou abaixo de"
    preco_hoje_fmt = gpc._fmt_brl(preco_hoje)
    valor_alvo_fmt = gpc._fmt_brl(valor_alvo)
    assunto = f"Alerta de preço — {commodity_nome} atingiu R$ {preco_hoje_fmt}"
    corpo = (
        f"O preço de {commodity_nome} no mercado físico (CEPEA/Esalq) {verbo} o valor de "
        f"R$ {valor_alvo_fmt} que você definiu como alerta."
    )

    substituicoes = {
        "TITULO_ALERTA": escape(f"{commodity_nome} atingiu R$ {preco_hoje_fmt}", quote=False),
        "CORPO_ALERTA": escape(corpo, quote=False),
        "PRECO_HOJE": escape(f"R$ {preco_hoje_fmt}", quote=False),
        "VALOR_ALVO": escape(f"R$ {valor_alvo_fmt}", quote=False),
        "LINK_COMMODITY": f"https://agrofertrader.github.io/AgroFerTrader-site/commodities/{commodity_slug}/",
    }
    for chave, valor in substituicoes.items():
        novo_html, n = re.subn(re.escape(chave), valor, html)
        if n == 0:
            raise SystemExit(f"Marcador '{chave}' não encontrado em emails/alerta-preco.html.")
        html = novo_html

    return assunto, html


def enviar_email_brevo(destinatario: str, assunto: str, html: str, api_key: str) -> None:
    cabecalhos = {"api-key": api_key, "Content-Type": "application/json", "Accept": "application/json"}
    payload = {
        "sender": BREVO_REMETENTE,
        "to": [{"email": destinatario}],
        "subject": assunto,
        "htmlContent": html,
    }
    resposta = requests.post("https://api.brevo.com/v3/smtp/email", json=payload, headers=cabecalhos, timeout=30)
    resposta.raise_for_status()


class NaoConfigurado(Exception):
    """Levantada quando PLANILHA_ALERTAS_ID (ou a credencial) ainda nao
    foi configurado - diferente de um erro de execucao de verdade, isso
    e tratado como um no-op silencioso (saida 0) quando este script roda
    dentro do pipeline diario automatico (ver atualizar-site.yml), pra
    nao quebrar a publicacao das cotacoes so porque o Recurso 4 ainda
    nao foi configurado com os dados reais da planilha."""


def _conectar_planilha():
    if PLANILHA_ALERTAS_ID == "SUA_PLANILHA_ID_AQUI":
        raise NaoConfigurado("PLANILHA_ALERTAS_ID ainda não foi configurado em verificar_alertas.py.")
    credenciais_json = os.environ.get("GOOGLE_SHEETS_CREDENTIALS")
    if not credenciais_json:
        raise NaoConfigurado("Variável de ambiente GOOGLE_SHEETS_CREDENTIALS não encontrada.")

    info = json.loads(credenciais_json)
    credenciais = Credentials.from_service_account_info(info, scopes=ESCOPOS_GOOGLE)
    cliente = gspread.authorize(credenciais)
    return cliente.open_by_key(PLANILHA_ALERTAS_ID).sheet1


def verificar_alertas(dry_run: bool = False) -> None:
    try:
        planilha = _conectar_planilha()
    except NaoConfigurado as e:
        print(f"Recurso de alerta de preço ainda não configurado ({e}) - pulando, sem erro.")
        return
    linhas = planilha.get_all_values()
    if not linhas:
        print("Planilha vazia - nada a fazer.")
        return

    cabecalho, registros = linhas[0], linhas[1:]
    colunas = _mapear_colunas(cabecalho)
    indice = {campo: cabecalho.index(nome_real) for campo, nome_real in colunas.items()}
    indice_notificado = indice["notificado"]

    precos_hoje = _obter_precos_hoje()
    enviados = 0

    for num_linha, linha in enumerate(registros, start=2):  # linha 1 = cabecalho
        if _eh_notificado(linha[indice["notificado"]]):
            continue

        email = linha[indice["email"]].strip()
        commodity_texto = linha[indice["commodity"]].strip()
        direcao = linha[indice["direcao"]].strip()
        valor_alvo_texto = linha[indice["valor_alvo"]].strip()

        cfg = COMMODITIES_ALERTA.get(_normalizar(commodity_texto))
        if not cfg or not email or not valor_alvo_texto:
            print(f"Linha {num_linha}: dados incompletos ou commodity não reconhecida ('{commodity_texto}') - pulando.")
            continue

        try:
            valor_alvo = float(valor_alvo_texto.replace(",", "."))
        except ValueError:
            print(f"Linha {num_linha}: valor_alvo inválido ('{valor_alvo_texto}') - pulando.")
            continue

        preco_hoje = precos_hoje.get(cfg["slug"])
        if preco_hoje is None:
            print(f"Linha {num_linha}: sem preço de hoje disponível para {cfg['nome_fisica']} - pulando.")
            continue

        try:
            dispara = avaliar_alerta(direcao, valor_alvo, preco_hoje)
        except ValueError as e:
            print(f"Linha {num_linha}: {e} - pulando.")
            continue

        if not dispara:
            continue

        print(
            f"Linha {num_linha}: ALERTA -> {email} | {cfg['nome_fisica']} | "
            f"direção='{direcao}' | alvo={valor_alvo} | hoje={preco_hoje}"
        )
        if dry_run:
            enviados += 1
            continue

        api_key = os.environ.get("BREVO_API_KEY")
        if not api_key:
            raise SystemExit("Variável de ambiente BREVO_API_KEY não encontrada.")

        assunto, html = montar_email_alerta(cfg["nome_fisica"], cfg["slug"], direcao, valor_alvo, preco_hoje)
        enviar_email_brevo(email, assunto, html, api_key)
        planilha.update_cell(num_linha, indice_notificado + 1, "sim")
        enviados += 1
        print(f"  -> e-mail enviado e planilha atualizada (linha {num_linha}).")

    print(f"\nConcluído. {enviados} alerta(s) {'identificado(s) (dry-run)' if dry_run else 'enviado(s)'}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verifica e dispara alertas de preço cadastrados na planilha (Recurso 4).")
    parser.add_argument("--dry-run", action="store_true", help="Só mostra o que faria, sem enviar e-mail nem gravar na planilha")
    args = parser.parse_args()
    verificar_alertas(dry_run=args.dry_run)
