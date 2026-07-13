"""
Monitor Agro - Coleta diária de câmbio, Selic e preço da soja
================================================================

Este script busca:
  1. Dólar comercial (PTAX) - API pública do Banco Central
  2. Taxa Selic - API pública do Banco Central
  3. Preço da soja (indicador CEPEA/Esalq) - tabela pública do site
  4. Manchetes recentes de notícias sobre comércio agro (nacional/internacional)

Requisitos (instalar uma vez):
    pip install requests pandas lxml beautifulsoup4

Como usar agora (manual):
    python monitor_agro_v9.py

Envio automático por e-mail (do seu e-mail empresarial para o pessoal):
    Configure as variáveis de ambiente abaixo e o script manda o resumo
    por e-mail sozinho toda vez que rodar (detalhes na função
    enviar_email() mais abaixo):

        SMTP_USUARIO       -> seu e-mail EMPRESARIAL (quem envia/autentica)
        SMTP_SENHA         -> senha de app do e-mail empresarial
        EMAIL_DESTINATARIO -> seu e-mail PESSOAL (quem recebe o resumo)
        SMTP_SERVIDOR, SMTP_PORTA -> dados do servidor SMTP da empresa

Como automatizar (rodar todo dia sozinho):
    - Windows: Agendador de Tarefas -> criar tarefa que roda
      "python monitor_agro_v9.py" todo dia às 8h, por exemplo.
    - Mac/Linux: crontab -e, adicionar uma linha tipo:
      0 8 * * * /usr/bin/python3 /caminho/para/monitor_agro_v9.py
    - Nuvem (roda mesmo com o PC desligado, recomendado para uso
      empresarial contínuo): GitHub Actions, com um workflow agendado
      (cron) que executa este script. As credenciais de e-mail ficam
      guardadas nos "Secrets" do repositório (nunca no código).

CORREÇÕES E NOVIDADES NESTA VERSÃO (v9):
    - Corrigido o Trigo: o indicador do Notícias Agrícolas/CEPEA para
      trigo é divulgado em R$/tonelada, enquanto as demais commodities
      desta lista são acompanhadas em R$/saca de 60kg. Foi adicionada
      conversão automática (R$/tonelada x 60/1000 = R$/saca) para o
      Trigo ficar no mesmo padrão das outras.
    - Adicionada seção explicativa (gerar_explicacao_macro) sobre como
      dólar e Selic tendem a afetar o preço de commodities como o café.
    - Adicionada busca de manchetes de notícias sobre comércio agro
      nacional/internacional (buscar_noticias_agro), via scraping do
      Notícias Agrícolas. Como não existe API pública de notícias desse
      portal, essa parte depende do HTML atual do site e pode precisar
      de ajuste se o layout mudar (ver comentário na função).
"""

import os
import random
import smtplib
import ssl
from email.message import EmailMessage

import requests
import pandas as pd
from datetime import datetime


def buscar_serie_bacen(codigo_serie: int, dias: int = 5) -> pd.DataFrame:
    """Busca uma série temporal no SGS do Banco Central (ex: dólar, Selic)."""
    url = (
        f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo_serie}/"
        f"dados/ultimos/{dias}?formato=json"
    )
    resposta = requests.get(url, timeout=10)
    resposta.raise_for_status()
    dados = resposta.json()
    df = pd.DataFrame(dados)
    df["valor"] = df["valor"].astype(float)
    return df


def buscar_dolar() -> dict:
    # Código 1 = Dólar comercial venda (SGS/Bacen)
    df = buscar_serie_bacen(1, dias=5)
    ultimo = df.iloc[-1]
    anterior = df.iloc[-2]
    variacao = ((ultimo["valor"] - anterior["valor"]) / anterior["valor"]) * 100
    return {"data": ultimo["data"], "valor": ultimo["valor"], "variacao_pct": variacao}


def buscar_dolar_tempo_real() -> dict:
    """
    Busca a cotação do dólar comercial em TEMPO REAL (spot), via AwesomeAPI
    (economia.awesomeapi.com.br) - gratuita, sem necessidade de chave/conta.

    Diferença importante em relação a buscar_dolar() (PTAX):
    - PTAX é uma taxa OFICIAL de referência, calculada pelo Banco Central
      UMA VEZ por dia, a partir da média das operações do dia. É o que
      contratos, balanços e a maioria dos indicadores usam como padrão.
    - Esta função (AwesomeAPI) reflete a cotação de mercado circulando
      AGORA, atualizada continuamente durante o pregão - mais parecida
      com o "dólar no visor" que você vê em corretoras/plataformas.
    Nenhuma das duas está "errada" - são só propósitos diferentes.
    """
    url = "https://economia.awesomeapi.com.br/json/last/USD-BRL"
    resposta = requests.get(url, timeout=10)
    resposta.raise_for_status()
    dados = resposta.json()["USDBRL"]
    hora_cotacao = datetime.fromtimestamp(int(dados["timestamp"])).strftime("%d/%m/%Y %H:%M:%S")
    return {
        "compra": float(dados["bid"]),
        "venda": float(dados["ask"]),
        "variacao_pct": float(dados["pctChange"]),
        "hora": hora_cotacao,
    }


def buscar_selic() -> dict:
    # Código 432 = Meta Selic definida pelo Copom (SGS/Bacen)
    df = buscar_serie_bacen(432, dias=5)
    ultimo = df.iloc[-1]
    return {"data": ultimo["data"], "valor": ultimo["valor"]}


def _texto_para_float(texto: str) -> float:
    """Converte um preço em formato BR (ex: '68,50' ou '1.234,56') para float.
    Mantém apenas dígitos, ponto e vírgula; ponto = separador de milhar,
    vírgula = separador decimal."""
    limpo = "".join(c for c in str(texto) if c.isdigit() or c in ",.")
    if not limpo:
        raise ValueError(f"Não foi possível converter '{texto}' para número")
    limpo = limpo.replace(".", "").replace(",", ".")
    return float(limpo)


def _achar_coluna(colunas_originais: list, palavras_chave: list) -> str | None:
    """Encontra o nome real de uma coluna, testando as palavras-chave em
    ORDEM DE PRIORIDADE (a primeira palavra-chave da lista é testada em
    todas as colunas antes de passar pra próxima). Isso importa quando uma
    página tem mais de uma coluna parecida (ex: "R$/tonelada" e "R$/saca"
    na mesma tabela) - a ordem da lista de palavras decide qual delas
    contar como a coluna de preço certa."""
    for palavra in palavras_chave:
        for coluna in colunas_originais:
            if palavra in str(coluna).lower():
                return coluna
    return None


def buscar_cotacao_noticias_agricolas(
    caminho: str,
    nome_exibicao: str,
    fator_conversao: float = 1.0,
    palavras_chave_preco: list | None = None,
    modo_diagnostico: bool = False,
) -> dict:
    """
    Função genérica para buscar cotação de uma commodity no Notícias
    Agrícolas, que republica indicadores da CEPEA/Esalq (a CEPEA direto
    bloqueia acesso automatizado, então usamos essa fonte alternativa).

    caminho: caminho completo depois de /cotacoes/ (ex: "milho/indicador-cepea-esalq-milho")
    nome_exibicao: nome bonito para mostrar no resumo (ex: "Milho")
    fator_conversao: multiplicador aplicado ao preço bruto extraído da
        página, usado quando a fonte publica em uma unidade diferente da
        que queremos exibir (ex: Trigo vem em R$/tonelada e convertemos
        para R$/saca de 60kg multiplicando por 60/1000). Use 1.0 quando
        a unidade da fonte já é a desejada (não faz conversão nenhuma).
    palavras_chave_preco: lista opcional de palavras-chave, em ORDEM DE
        PRIORIDADE, para achar a coluna de preço certa quando a página
        tem mais de uma coluna parecida (ex: Trigo pode ter "R$/tonelada"
        E alguma outra coluna com "R$"; passar ["tonelada"] garante que
        pegamos a coluna certa em vez de uma genérica). Se None, usa
        apenas a lista padrão.
    modo_diagnostico: se True, ao invés de retornar o resultado, imprime
        no terminal todas as tabelas encontradas na página (nomes de
        coluna e primeira linha) - útil para descobrir a estrutura real
        da página quando o valor buscado parecer errado.

    Cada commodity tem uma página de indicador com endereço próprio (não
    segue um padrão único), então o caminho precisa ser o específico de
    cada uma. A leitura das colunas é flexível (procura por palavras-chave
    em vez de nome exato), pois cada página usa nomes ligeiramente
    diferentes para as mesmas informações.
    """
    from io import StringIO

    url = f"https://www.noticiasagricolas.com.br/cotacoes/{caminho}"
    cabecalhos = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }
    resposta = requests.get(url, headers=cabecalhos, timeout=10)
    resposta.raise_for_status()

    tabelas = pd.read_html(StringIO(resposta.text), decimal=",", thousands=".")

    if modo_diagnostico:
        print(f"\n=== DIAGNÓSTICO: {nome_exibicao} ({url}) ===")
        for i, tabela in enumerate(tabelas):
            print(f"-- Tabela {i} -- colunas: {list(tabela.columns)}")
            if not tabela.empty:
                print(f"   primeira linha: {tabela.iloc[0].to_dict()}")
        return {}

    lista_busca_preco = list(palavras_chave_preco or []) + ["valor", "preç", "preco", "r$"]

    for tabela in tabelas:
        colunas = list(tabela.columns)
        coluna_data = _achar_coluna(colunas, ["data", "fecham", "vencimento"])
        coluna_preco = _achar_coluna(colunas, lista_busca_preco)
        coluna_variacao = _achar_coluna(colunas, ["variaç", "var("])

        if coluna_data and coluna_preco:
            primeira_linha = tabela.iloc[0]
            valor_bruto = primeira_linha[coluna_preco]

            if fator_conversao != 1.0:
                # O pandas (read_html com decimal="," e thousands=".") já
                # converte o preço da página para um número Python normal
                # (ex: 1364.03, com PONTO como decimal - não mais formato
                # BR). Por isso tentamos converter direto com float() aqui;
                # só caímos no parser de texto BR (_texto_para_float) se
                # o valor vier como string com "R$"/milhar (fallback).
                try:
                    valor_numerico = float(valor_bruto)
                except (TypeError, ValueError):
                    valor_numerico = _texto_para_float(str(valor_bruto))
                preco_convertido = valor_numerico * fator_conversao
                preco_final = f"{preco_convertido:.2f}".replace(".", ",")
            else:
                preco_final = str(valor_bruto)

            return {
                "nome": nome_exibicao,
                "data": str(primeira_linha[coluna_data]),
                "preco_reais": preco_final,
                "variacao_pct": str(primeira_linha[coluna_variacao]) if coluna_variacao else "n/d",
            }

    raise ValueError(f"Não encontrei tabela de preços reconhecível para {nome_exibicao}")


# Lista de commodities monitoradas. Cada uma tem um caminho específico
# (descoberto individualmente), pois a estrutura do site não é uniforme.
# Para adicionar outra, é preciso achar o caminho exato da página do
# indicador dessa commodity no Notícias Agrícolas.
COMMODITIES_MONITORADAS = [
    ("soja", "Soja", 1.0, None),
    ("milho/indicador-cepea-esalq-milho", "Milho", 1.0, None),
    # O indicador de Trigo do Notícias Agrícolas/CEPEA é divulgado em
    # R$/tonelada, diferente das demais commodities desta lista, que são
    # acompanhadas em R$/saca de 60kg. Fator de conversão: 1 tonelada =
    # 1000kg = 1000/60 sacas, então preço-por-saca = preço-por-tonelada * (60/1000).
    # Passamos ["tonelada"] como prioridade de coluna para garantir que a
    # coluna de preço encontrada seja mesmo a de R$/tonelada (e não outra
    # coluna com "R$" que porventura exista na mesma tabela).
    ("trigo/preco-medio-do-trigo-cepea-esalq", "Trigo (R$/saca 60kg)", 60 / 1000, ["tonelada"]),
    ("cafe/indicador-cepea-esalq-cafe-arabica", "Café Arábica", 1.0, None),
    ("boi-gordo/boi-gordo-indicador-esalq-bmf", "Boi Gordo", 1.0, None),
    ("algodao/algodao-indicador-cepea-esalq-a-prazo", "Algodão", 1.0, None),
    ("sucroenergetico/acucar-cristal-cepea", "Açúcar Cristal", 1.0, None),
]


def buscar_todas_commodities() -> list:
    """Busca a cotação de todas as commodities da lista acima."""
    resultados = []
    for slug, nome, fator, palavras_preco in COMMODITIES_MONITORADAS:
        try:
            resultado = buscar_cotacao_noticias_agricolas(
                slug, nome, fator_conversao=fator, palavras_chave_preco=palavras_preco
            )
            resultados.append(resultado)
        except Exception as e:
            resultados.append({"nome": nome, "erro": str(e)})
    return resultados


def diagnosticar_commodity(nome_procurado: str) -> None:
    """Roda o modo de diagnóstico (imprime as tabelas cruas da página) para
    a commodity OU futuro cujo nome contém o texto passado (sem diferenciar
    maiúsculas/minúsculas). Use isso se algum preço parecer errado, para
    ver exatamente quais colunas a página tem."""
    encontrada = False
    for slug, nome, fator, palavras_preco in COMMODITIES_MONITORADAS:
        if nome_procurado.lower() in nome.lower():
            encontrada = True
            buscar_cotacao_noticias_agricolas(
                slug, nome, fator_conversao=fator,
                palavras_chave_preco=palavras_preco, modo_diagnostico=True,
            )
    for slug, nome, fator in FUTUROS_B3_MONITORADOS:
        if nome_procurado.lower() in nome.lower():
            encontrada = True
            buscar_futuro_b3(slug, nome, fator_conversao=fator, modo_diagnostico=True)
    if not encontrada:
        print(f"Nenhuma commodity/futuro monitorado contém '{nome_procurado}' no nome.")


# ---------------------------------------------------------------------------
# MERCADO FUTURO (B3) - expectativa de preço, diferente do mercado FÍSICO
# ---------------------------------------------------------------------------
# As commodities acima (COMMODITIES_MONITORADAS) são o indicador CEPEA/Esalq:
# preço FÍSICO médio de HOJE, o que o produtor efetivamente negocia agora.
#
# Os itens abaixo são o FECHAMENTO do contrato futuro mais próximo na B3:
# o preço que o mercado financeiro está precificando para entrega futura
# (é a "expectativa" do mercado - informação que a maioria dos produtores
# não acompanha de perto, mas que é padrão no dia a dia de uma trader).
# Fonte: B3, republicado pelo Notícias Agrícolas (mesmo portal usado acima).
#
# IMPORTANTE (estrutura DIFERENTE da dos indicadores físicos acima): essas
# páginas usam colunas "Contrato - Mês" (qual vencimento) e "Fechamento
# (UNIDADE)" (o preço, com a unidade real dentro do próprio nome da coluna -
# ex: "Fechamento (US$/sc 60 kg)"), em vez de "Data"/"Preço" como nas
# páginas físicas. Por isso usamos buscar_futuro_b3() abaixo, uma função
# separada de buscar_cotacao_noticias_agricolas() (usar a mesma função
# geraria erro, pois a palavra "Fechamento" seria confundida com uma
# coluna de DATA em vez de PREÇO - bug real encontrado e corrigido aqui).
#
# Também é o FECHAMENTO mais recente (atualizado 1x/dia), não uma cotação
# corrente tick-a-tick. Isso normalmente exige conta em corretora ou
# provedor de dados pago.
FUTUROS_B3_MONITORADOS = [
    # O Dólar Futuro da B3 é cotado oficialmente em "R$ por US$ 1.000,00"
    # (confirmado na documentação da própria B3), não R$ por US$ 1 - por
    # isso o fator de conversão 1/1000 abaixo. Sem essa conversão, o valor
    # bruto da página (ex: 5137,0) pareceria um erro grosseiro (R$5.137
    # por dólar!), quando na verdade significa R$5,137/US$.
    ("mercado-financeiro/dolar-b3", "Dólar Futuro (B3)", 1 / 1000),
    ("soja/soja-b3-pregao-regular", "Soja Futuro (B3)", 1.0),
    ("milho/milho-b3-prego-regular", "Milho Futuro (B3)", 1.0),
    ("boi-gordo/boi-gordo-b3-prego-regular", "Boi Gordo Futuro (B3)", 1.0),
    ("cafe/cafe-arabica-4-5-b3-prego-regular", "Café Arábica Futuro (B3)", 1.0),
]


def buscar_futuro_b3(
    caminho: str, nome_exibicao: str, fator_conversao: float = 1.0, modo_diagnostico: bool = False
) -> dict:
    """
    Busca o fechamento mais recente de um contrato futuro na B3 (via
    Notícias Agrícolas). Estrutura de colunas típica dessas páginas:
    "Contrato - Mês" (vencimento) / "Fechamento (UNIDADE)" (preço, com a
    unidade real embutida no próprio nome da coluna) / "Variação (%)".

    Em vez de assumir uma unidade (o que já causou um erro real com o
    Trigo físico), extraímos a unidade DIRETO do cabeçalho da coluna
    (ex: "US$/sc 60 kg") e devolvemos junto com o preço - assim o valor
    mostrado sempre carrega a unidade certa, sem "adivinhação".

    fator_conversao: multiplicador aplicado ao valor bruto ANTES de
    exibir (ex: 1/1000 para o Dólar Futuro, cuja cotação da B3 é em
    R$ por US$ 1.000,00, não R$ por US$ 1,00). Use 1.0 quando o valor
    bruto já está na unidade que o cabeçalho da coluna informa.
    """
    from io import StringIO
    import re as _re

    url = f"https://www.noticiasagricolas.com.br/cotacoes/{caminho}"
    cabecalhos = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }
    resposta = requests.get(url, headers=cabecalhos, timeout=10)
    resposta.raise_for_status()
    tabelas = pd.read_html(StringIO(resposta.text), decimal=",", thousands=".")

    if modo_diagnostico:
        print(f"\n=== DIAGNÓSTICO: {nome_exibicao} ({url}) ===")
        for i, tabela in enumerate(tabelas):
            print(f"-- Tabela {i} -- colunas: {list(tabela.columns)}")
            if not tabela.empty:
                print(f"   primeira linha: {tabela.iloc[0].to_dict()}")
        return {}

    for tabela in tabelas:
        colunas = list(tabela.columns)
        coluna_contrato = _achar_coluna(colunas, ["contrato", "mês", "mes", "vencimento"])
        coluna_preco = _achar_coluna(colunas, ["fechamento", "preç", "preco", "valor"])
        coluna_variacao = _achar_coluna(colunas, ["variaç", "var"])

        if coluna_contrato and coluna_preco:
            primeira_linha = tabela.iloc[0]

            # Extrai a unidade de dentro do próprio nome da coluna, ex:
            # "Fechamento (US$/sc 60 kg)" -> "US$/sc 60 kg"
            match_unidade = _re.search(r"\(([^)]+)\)", str(coluna_preco))
            unidade = match_unidade.group(1) if match_unidade else ""

            preco_bruto = primeira_linha[coluna_preco]
            valor_numerico = None
            try:
                valor_numerico = float(preco_bruto) * fator_conversao
                casas_decimais = 4 if fator_conversao != 1.0 else 2
                preco_formatado = f"{valor_numerico:.{casas_decimais}f}".replace(".", ",")
            except (TypeError, ValueError):
                preco_formatado = str(preco_bruto)

            return {
                "nome": nome_exibicao,
                "data": f"contrato {primeira_linha[coluna_contrato]}",
                "preco_reais": f"{preco_formatado} {unidade}".strip(),
                "variacao_pct": str(primeira_linha[coluna_variacao]) if coluna_variacao else "n/d",
                # Guardados separados (além do texto formatado acima) para
                # permitir converter para Real depois, em coletar_dados():
                "valor_numerico": valor_numerico,
                "unidade": unidade,
            }

    raise ValueError(f"Não encontrei tabela de futuro reconhecível para {nome_exibicao}")


def buscar_todos_futuros() -> list:
    """Busca o fechamento mais recente de todos os futuros B3 da lista acima."""
    resultados = []
    for slug, nome, fator in FUTUROS_B3_MONITORADOS:
        try:
            resultado = buscar_futuro_b3(slug, nome, fator_conversao=fator)
            resultados.append(resultado)
        except Exception as e:
            resultados.append({"nome": nome, "erro": str(e)})
    return resultados


def converter_futuros_para_reais(resultados_futuros: list, taxa_dolar: float | None) -> list:
    """
    Converte para Real qualquer item da lista que esteja cotado em dólar
    (ex: Soja Futuro, Café Arábica Futuro), usando a taxa de câmbio
    informada. Todos os outros itens (já em R$, ou o próprio Dólar Futuro,
    que já É a cotação do câmbio) ficam como estão.

    O valor original em dólar é mantido entre parênteses, como referência
    para conferência - só a moeda "principal" exibida muda para Real.

    Se taxa_dolar vier None (não foi possível buscar o dólar agora), os
    itens em dólar são mantidos como estão e ganham uma nota avisando que
    não foi possível converter.
    """
    resultados_convertidos = []
    for resultado in resultados_futuros:
        if "erro" in resultado or not resultado.get("unidade"):
            resultados_convertidos.append(resultado)
            continue

        unidade = resultado["unidade"]
        valor_numerico = resultado.get("valor_numerico")

        # "R$/US$" é a cotação do dólar em si (Dólar Futuro) - já é,
        # por definição, uma cotação em Real. Não há o que converter.
        if "US$" not in unidade or "R$/US$" in unidade:
            resultados_convertidos.append(resultado)
            continue

        if taxa_dolar is None or valor_numerico is None:
            resultado = dict(resultado)
            resultado["preco_reais"] = f"{resultado['preco_reais']} (não convertido - dólar indisponível)"
            resultados_convertidos.append(resultado)
            continue

        valor_em_reais = valor_numerico * taxa_dolar
        unidade_em_reais = unidade.replace("US$", "R$")
        preco_original_formatado = f"{valor_numerico:.2f}".replace(".", ",")

        resultado = dict(resultado)
        taxa_formatada = f"{taxa_dolar:.4f}".replace(".", ",")
        resultado["preco_reais"] = (
            f"R$ {valor_em_reais:.2f}".replace(".", ",")
            + f" /{unidade_em_reais.split('/', 1)[1] if '/' in unidade_em_reais else ''}"
            + f" (≈ US$ {preco_original_formatado} x R$ {taxa_formatada})"
        )
        resultados_convertidos.append(resultado)

    return resultados_convertidos


# NOTA SOBRE GERGELIM E PIMENTA DO REINO:
# Ao pesquisar, não foi encontrada uma fonte com indicador diário público
# e confiável para esses dois produtos, no padrão dos grãos principais.
# - Pimenta do reino: existe referência de preço via CEASA-PA, mas com
#   atualização irregular (não diária), pouco confiável para automatizar.
# - Gergelim: só foram encontrados anúncios individuais em marketplaces
#   (tipo MF Rural), que são ofertas de vendedores, não um indicador de
#   mercado consolidado.
# Se esses produtos forem importantes para o negócio, o caminho realista
# no momento é coleta manual (contato direto com cooperativas/associações
# do setor), não automação via scraping.


def _variacao_para_float(texto) -> float | None:
    """Converte um texto de variação percentual (ex: '+0.50', '-2,78', '2.1')
    para float, tolerando tanto ponto quanto vírgula como decimal e sinal
    explícito. Retorna None se não for possível converter (ex: 'n/d')."""
    if texto is None:
        return None
    limpo = str(texto).strip().replace("%", "")
    if limpo in ("", "n/d", "-", "--"):
        return None
    if "," in limpo and "." in limpo:
        limpo = limpo.replace(".", "").replace(",", ".")
    elif "," in limpo:
        limpo = limpo.replace(",", ".")
    try:
        return float(limpo)
    except ValueError:
        return None


def _rotulo_variacao(variacao: float | None) -> str:
    """Traduz um número de variação percentual num rótulo textual (usado
    tanto no e-mail em texto puro quanto no HTML)."""
    if variacao is None:
        return "sem dado de variação"
    if variacao > 2:
        return "forte alta"
    if variacao > 0.3:
        return "leve alta"
    if variacao > -0.3:
        return "estável"
    if variacao > -2:
        return "leve queda"
    return "forte queda"


def _cor_variacao(variacao: float | None) -> str:
    """Cor (hex) associada à variação, para uso no e-mail em HTML."""
    if variacao is None:
        return "#6b7280"  # cinza
    if variacao > 0.3:
        return "#1f8a4c"  # verde
    if variacao < -0.3:
        return "#c62828"  # vermelho
    return "#6b7280"  # cinza (estável)


def _nota_defasagem(data_str: str) -> str | None:
    """Se a data do dado não for a data de hoje, devolve uma nota explicando
    que isso é normal (fontes publicam com defasagem de 1 dia útil), em vez
    de deixar parecer um bug. Retorna None se a data for hoje ou não puder
    ser comparada."""
    hoje = datetime.now().strftime("%d/%m/%Y")
    if not data_str or data_str == hoje:
        return None
    return (
        f"(dado mais recente disponível é de {data_str}, não de hoje — "
        "isso é normal: PTAX, Selic e indicadores agro costumam ser "
        "publicados com defasagem de 1 dia útil, ou refletem o último "
        "dia útil quando hoje é fim de semana/feriado)"
    )


def gerar_explicacao_macro(dolar: dict | None, selic: dict | None) -> list:
    """
    Gera linhas explicando, de forma geral, como dólar e Selic tendem a
    afetar o preço de commodities de exportação (o café é usado como
    referência porque é precificado em dólar no mercado internacional).

    Para cada cenário (faixa de variação do dólar, faixa da Selic) existem
    VÁRIAS frases equivalentes pré-escritas, e uma é sorteada aleatoriamente
    a cada execução - assim o e-mail não repete sempre o mesmo texto em
    dias com cenário parecido, mesmo com a mesma faixa de variação.

    Importante: são relações históricas/gerais, não regras fixas - clima,
    quebra de safra, estoques mundiais e demanda também influenciam o
    preço e podem se sobrepor ao efeito cambial ou da Selic.
    """
    linhas = ["", "--- Como dólar e Selic tendem a afetar o café e outras commodities ---"]

    if dolar is not None:
        variacao = dolar["variacao_pct"]
        rotulo = _rotulo_variacao(variacao)

        variantes_dolar = {
            "forte alta": [
                f"Dólar em forte alta hoje ({variacao:+.2f}%): café, soja e demais "
                "commodities de exportação são precificadas em dólar no mercado "
                "internacional, então um movimento cambial desse tamanho costuma "
                "repassar rápido para o preço interno - a mesma cotação em USD "
                "passa a valer bem mais em reais, tornando a exportação ainda "
                "mais vantajosa.",
                f"Alta acentuada do câmbio ({variacao:+.2f}%): esse tipo de "
                "movimento tende a se refletir de forma quase imediata no preço "
                "doméstico de commodities cotadas internacionalmente, já que "
                "exportar fica mais atrativo com o real mais desvalorizado.",
                f"O dólar disparou hoje ({variacao:+.2f}%). Historicamente, altas "
                "dessa magnitude pressionam com força o preço interno de "
                "commodities como café e soja para cima, por conta do efeito "
                "direto sobre a paridade de exportação.",
            ],
            "leve alta": [
                f"Dólar em leve alta ({variacao:+.2f}%): o movimento é moderado, "
                "mas já tende a favorecer um pouco o preço interno de commodities "
                "exportadas, já que a mesma cotação em dólar rende mais reais.",
                f"Câmbio subiu discretamente hoje ({variacao:+.2f}%) - não é uma "
                "virada de tendência, mas pequenas altas como essa historicamente "
                "já dão um empurrão positivo ao preço doméstico de commodities de "
                "exportação.",
                f"Alta suave do dólar ({variacao:+.2f}%): efeito tende a ser "
                "discreto, mas na mesma direção de sempre - real mais fraco "
                "favorece um pouco quem exporta café, soja e afins.",
            ],
            "estável": [
                f"Dólar praticamente estável hoje ({variacao:+.2f}%): sem pressão "
                "cambial relevante sobre os preços agrícolas no momento - outros "
                "fatores (clima, safra, demanda) tendem a pesar mais que o câmbio "
                "hoje.",
                f"Câmbio sem grandes variações ({variacao:+.2f}%): não é o dólar "
                "que deve explicar os movimentos de preço agrícola hoje, e sim "
                "fatores de oferta e demanda específicos de cada commodity.",
                f"Dólar de lado ({variacao:+.2f}%): num dia como esse, vale mais "
                "olhar para os fundamentos de cada mercado (clima, safra, "
                "estoques) do que para o câmbio.",
            ],
            "leve queda": [
                f"Dólar em leve queda ({variacao:+.2f}%): o real um pouco mais "
                "valorizado tende a reduzir de forma discreta o incentivo à "
                "exportação, pressionando levemente o preço interno de "
                "commodities cotadas em dólar.",
                f"Câmbio recuou de forma moderada hoje ({variacao:+.2f}%) - efeito "
                "inverso do de uma alta: a mesma cotação internacional passa a "
                "render um pouco menos em reais.",
                f"Queda suave do dólar ({variacao:+.2f}%): tende a esfriar "
                "discretamente o apetite por exportação, com leve efeito de baixa "
                "sobre o preço doméstico de commodities.",
            ],
            "forte queda": [
                f"Dólar em forte queda ({variacao:+.2f}%): com o real bem mais "
                "valorizado, a mesma cotação internacional em dólar rende bem "
                "menos em reais, o que tende a pressionar para baixo o preço "
                "interno de commodities de exportação como café e soja.",
                f"Queda acentuada do câmbio ({variacao:+.2f}%): esse tipo de "
                "movimento costuma reduzir rapidamente a atratividade da "
                "exportação, com efeito de baixa relevante sobre o preço "
                "doméstico de commodities cotadas internacionalmente.",
                f"O dólar recuou com força hoje ({variacao:+.2f}%). Quedas dessa "
                "magnitude tendem a pesar bastante sobre o preço interno de "
                "commodities exportadas, já que a paridade de exportação piora "
                "rapidamente.",
            ],
        }
        linhas.append(random.choice(variantes_dolar[rotulo]))

    if selic is not None:
        valor_selic = selic["valor"]
        if valor_selic >= 12:
            faixa_selic = "alta"
        elif valor_selic >= 8:
            faixa_selic = "media"
        else:
            faixa_selic = "baixa"

        variantes_selic = {
            "alta": [
                f"Selic em {valor_selic:.2f}% ao ano - um patamar considerado "
                "alto: o crédito rural fica mais caro e carregar estoque também, "
                "o que costuma levar produtores a vender mais rápido para gerar "
                "caixa, pressionando o preço para baixo no curto prazo. Juros "
                "altos também tendem a atrair capital estrangeiro e valorizar o "
                "real, reforçando essa pressão via câmbio.",
                f"Com a Selic em {valor_selic:.2f}% ao ano, o custo de "
                "financiamento no campo segue elevado - isso tende a acelerar "
                "vendas (para gerar caixa) e, por atrair capital estrangeiro, "
                "também tende a fortalecer o real. Os dois efeitos juntos "
                "costumam pressionar o preço das commodities exportadas para "
                "baixo.",
                f"Juros em {valor_selic:.2f}% ao ano seguem em patamar alto - "
                "carregar estoque fica caro, o que empurra produtores a vender "
                "mais rápido, e o diferencial de juros atrai capital estrangeiro, "
                "valorizando o real. Ambos tendem a pesar contra o preço em "
                "reais das commodities de exportação.",
            ],
            "media": [
                f"Selic em {valor_selic:.2f}% ao ano - patamar intermediário: o "
                "custo de crédito rural não é nem baixo nem excessivamente alto, "
                "então esse fator tende a ter peso moderado sobre a decisão de "
                "venda dos produtores.",
                f"Com a Selic em {valor_selic:.2f}% ao ano, o efeito sobre o "
                "preço das commodities tende a ser mais discreto que em cenários "
                "de juros muito altos ou muito baixos - vale acompanhar de perto "
                "outros fatores nesse patamar.",
                f"Juros em {valor_selic:.2f}% ao ano estão numa faixa "
                "intermediária - nem estimulam venda apressada, nem dão muito "
                "fôlego extra ao produtor para segurar estoque.",
            ],
            "baixa": [
                f"Selic em {valor_selic:.2f}% ao ano - um patamar considerado "
                "baixo: crédito rural mais barato reduz a pressa do produtor em "
                "vender para gerar caixa, e juros baixos tendem a enfraquecer o "
                "real, o que favorece o preço em reais das commodities "
                "exportadas.",
                f"Com a Selic em {valor_selic:.2f}% ao ano, o custo de carregar "
                "estoque é menor - produtores tendem a ter mais fôlego para "
                "negociar melhores preços, e o real historicamente mais fraco "
                "nesse cenário favorece quem exporta.",
                f"Juros em {valor_selic:.2f}% ao ano seguem baixos - menos "
                "pressão para vender rápido, e um real tendencialmente mais "
                "fraco tende a favorecer o preço das commodities exportadas.",
            ],
        }
        linhas.append(random.choice(variantes_selic[faixa_selic]))

    variantes_obs = [
        "Obs.: essas são tendências gerais - clima, quebra de safra, estoques "
        "mundiais e demanda de outros países também afetam o preço e podem "
        "superar o efeito isolado do câmbio ou da Selic.",
        "Obs.: vale lembrar que essas são relações históricas, não regras "
        "fixas - fatores como clima, safra e demanda internacional podem se "
        "sobrepor facilmente ao efeito do câmbio ou dos juros.",
        "Obs.: nenhuma dessas relações é garantida - clima, oferta mundial e "
        "demanda por vezes pesam mais que câmbio e juros na formação do "
        "preço final.",
    ]
    linhas.append(random.choice(variantes_obs))

    return linhas


import unicodedata


def _sem_acentos(texto: str) -> str:
    """Remove acentos para facilitar comparação de palavras-chave."""
    return "".join(
        c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn"
    )


# Palavras-chave usadas para filtrar, dentre TODAS as manchetes do site,
# apenas as que tratam de comércio/economia ligado ao agro (exportação,
# importação, tarifas, acordos comerciais, câmbio, safra, mercado
# internacional etc.) - em vez de trazer qualquer notícia do portal.
#
# IMPORTANTE (única exceção proposital de ortografia neste arquivo): as
# palavras abaixo ficam SEM ACENTO de propósito, porque são comparadas
# contra o título da notícia já com os acentos removidos (função
# _sem_acentos). Se colocássemos acento aqui, a comparação deixaria de
# bater e o filtro pararia de funcionar. Isso não aparece em nenhum
# texto visível para você (e-mail/terminal) - é só uma lista interna de
# comparação.
PALAVRAS_CHAVE_NOTICIAS_COMERCIO = [
    "exporta", "importa", "tarifa", "comerc", "acordo", "china", "estados unidos",
    "uniao europeia", "mercosul", "protecionis", "sobretaxa", "antidumping",
    "cambio", "dolar", "embargo", "sancao", "frete", "porto", "logistica",
    "safra", "estoque mundial", "demanda internacional", "opep",
    "organizacao mundial do comercio", "taxacao", "imposto de importacao",
]


def buscar_noticias_agro(quantidade: int = 5, candidatos_brutos: int = 30) -> list:
    """
    Busca manchetes recentes no Notícias Agrícolas, filtra apenas as que
    tratam de comércio/economia ligada ao agro (não traz qualquer notícia
    do portal) e busca um resumo real de cada matéria (não só o link).

    candidatos_brutos: quantas manchetes brutas olhar antes de filtrar
        (precisa ser maior que `quantidade` porque nem toda manchete bate
        com as palavras-chave de comércio/economia).

    OBS IMPORTANTE: não existe uma API pública de notícias desse portal,
    então esta função faz scraping do HTML da página de notícias e, para
    cada matéria filtrada, faz uma segunda requisição para tentar extrair
    um parágrafo de resumo. Se o site mudar o layout, os seletores abaixo
    podem parar de encontrar as manchetes ou o resumo - nesse caso, abra a
    página no navegador, use "Inspecionar elemento" e ajuste os seletores
    (`sopa.select("a")` para a lista de manchetes, `sopa.select("p")` para
    o resumo da matéria).
    """
    from bs4 import BeautifulSoup

    cabecalhos = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }

    url_lista = "https://www.noticiasagricolas.com.br/noticias"
    resposta = requests.get(url_lista, headers=cabecalhos, timeout=10)
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
        if len(candidatas) >= candidatos_brutos:
            break

    # Filtra apenas as manchetes relevantes para comércio/economia do agro
    filtradas = []
    for candidata in candidatas:
        titulo_normalizado = _sem_acentos(candidata["titulo"].lower())
        if any(palavra in titulo_normalizado for palavra in PALAVRAS_CHAVE_NOTICIAS_COMERCIO):
            filtradas.append(candidata)
        if len(filtradas) >= quantidade:
            break

    # Se o filtro for rigoroso demais e não achar nada, cai para as
    # manchetes mais recentes sem filtro (para não deixar a seção vazia).
    usando_fallback_sem_filtro = False
    if not filtradas:
        filtradas = candidatas[:quantidade]
        usando_fallback_sem_filtro = True

    # Para cada manchete filtrada, tenta buscar um resumo real (não só o link)
    for noticia in filtradas:
        try:
            resp_materia = requests.get(noticia["link"], headers=cabecalhos, timeout=10)
            resp_materia.raise_for_status()
            sopa_materia = BeautifulSoup(resp_materia.text, "lxml")
            resumo = None
            for paragrafo in sopa_materia.select("p"):
                texto_p = paragrafo.get_text(strip=True)
                if texto_p and len(texto_p) > 60:
                    resumo = texto_p
                    break
            if resumo:
                noticia["resumo"] = (resumo[:220] + "...") if len(resumo) > 220 else resumo
            else:
                noticia["resumo"] = "Resumo não disponível — acesse a matéria completa pelo link."
        except Exception:
            noticia["resumo"] = "Resumo não disponível — acesse a matéria completa pelo link."
        noticia["fonte"] = "Notícias Agrícolas"

    if usando_fallback_sem_filtro:
        for noticia in filtradas:
            noticia["resumo"] = (
                "[fora do filtro de comércio/economia agro] " + noticia["resumo"]
            )

    return filtradas


def coletar_dados() -> dict:
    """Busca todos os dados do dia UMA ÚNICA VEZ (dólar PTAX, dólar tempo
    real, Selic, commodities físicas, futuros B3, notícias) e devolve num
    dicionário. Tanto o resumo em texto quanto o e-mail em HTML são
    montados a partir deste mesmo dicionário, para não fazer as mesmas
    requisições duas vezes."""
    dolar = None
    dolar_tr = None
    selic = None
    erro_dolar = None
    erro_dolar_tr = None
    erro_selic = None

    try:
        dolar = buscar_dolar()
    except Exception as e:
        erro_dolar = str(e)

    try:
        dolar_tr = buscar_dolar_tempo_real()
    except Exception as e:
        erro_dolar_tr = str(e)

    try:
        selic = buscar_selic()
    except Exception as e:
        erro_selic = str(e)

    resultados_commodities = buscar_todas_commodities()
    resultados_futuros = buscar_todos_futuros()

    # Converte para Real qualquer item cotado em dólar (Soja Futuro, Café
    # Arábica Futuro), para que TODOS os preços do e-mail fiquem na mesma
    # moeda. Usa o dólar oficial (PTAX) como taxa de referência - a mesma
    # cadência diária dos demais dados; se a PTAX não estiver disponível,
    # usa o dólar em tempo real como alternativa.
    taxa_dolar_para_conversao = None
    if dolar is not None:
        taxa_dolar_para_conversao = dolar["valor"]
    elif dolar_tr is not None:
        taxa_dolar_para_conversao = dolar_tr["venda"]
    resultados_futuros = converter_futuros_para_reais(resultados_futuros, taxa_dolar_para_conversao)

    explicacoes_macro = gerar_explicacao_macro(dolar, selic)

    noticias = []
    erro_noticias = None
    try:
        noticias = buscar_noticias_agro()
    except Exception as e:
        erro_noticias = str(e)

    return {
        "dolar": dolar,
        "erro_dolar": erro_dolar,
        "dolar_tr": dolar_tr,
        "erro_dolar_tr": erro_dolar_tr,
        "selic": selic,
        "erro_selic": erro_selic,
        "resultados_commodities": resultados_commodities,
        "resultados_futuros": resultados_futuros,
        "explicacoes_macro": explicacoes_macro,
        "noticias": noticias,
        "erro_noticias": erro_noticias,
    }


def montar_resumo_texto(dados: dict) -> str:
    """Monta a versão em texto puro do resumo (usada no terminal, no
    histórico salvo em arquivo, e como fallback do e-mail), a partir do
    dicionário devolvido por coletar_dados()."""
    linhas = [f"=== Monitor Agro - {datetime.now().strftime('%d/%m/%Y %H:%M')} ===\n"]

    dolar = dados["dolar"]
    selic = dados["selic"]
    dolar_tr = dados["dolar_tr"]

    if dolar is not None:
        seta = "subiu" if dolar["variacao_pct"] > 0 else "caiu"
        nota = _nota_defasagem(dolar["data"])
        linhas.append(
            f"Dólar oficial (PTAX): R$ {dolar['valor']:.4f} "
            f"({seta} {abs(dolar['variacao_pct']):.2f}% desde o último dado, {dolar['data']})"
            + (f" {nota}" if nota else "")
        )
    else:
        linhas.append(f"Não foi possível buscar o dólar agora ({dados['erro_dolar']})")

    if selic is not None:
        nota = _nota_defasagem(selic["data"])
        linhas.append(
            f"Selic (meta Copom): {selic['valor']:.2f}% ao ano ({selic['data']})"
            + (f" {nota}" if nota else "")
        )
    else:
        linhas.append(f"Não foi possível buscar a Selic agora ({dados['erro_selic']})")

    linhas.append("")  # linha em branco antes das commodities
    linhas.append("--- Mercado físico (indicador CEPEA/Esalq - preço de hoje) ---")
    for resultado in dados["resultados_commodities"]:
        if "erro" in resultado:
            linhas.append(f"{resultado['nome']}: não foi possível buscar agora ({resultado['erro']})")
        else:
            linhas.append(
                f"{resultado['nome']}: R$ {resultado['preco_reais']} "
                f"(variação {resultado['variacao_pct']}, dado de {resultado['data']})"
            )

    linhas.append("")
    linhas.append("--- Mercado Futuro / Cotação em Tempo Real ---")
    if dolar_tr is not None:
        seta_tr = "subiu" if dolar_tr["variacao_pct"] > 0 else "caiu"
        linhas.append(
            f"Dólar em TEMPO REAL (AwesomeAPI, spot): compra R$ {dolar_tr['compra']:.4f} / "
            f"venda R$ {dolar_tr['venda']:.4f} "
            f"({seta_tr} {abs(dolar_tr['variacao_pct']):.2f}% hoje, última atualização {dolar_tr['hora']})"
        )
    elif dados["erro_dolar_tr"]:
        linhas.append(f"Não foi possível buscar o dólar em tempo real agora ({dados['erro_dolar_tr']})")
    for resultado in dados["resultados_futuros"]:
        if "erro" in resultado:
            linhas.append(f"{resultado['nome']}: não foi possível buscar agora ({resultado['erro']})")
        else:
            linhas.append(
                f"{resultado['nome']}: {resultado['preco_reais']} "
                f"(variação {resultado['variacao_pct']}, {resultado['data']})"
            )

    # Seção explicativa: o que dólar/Selic subindo ou caindo tende a
    # significar para o preço do café e de outras commodities exportadas.
    linhas.extend(dados["explicacoes_macro"])

    # Seção de notícias: manchetes recentes sobre comércio agro nacional
    # e internacional (já filtradas e resumidas), para dar contexto
    # qualitativo aos números acima.
    linhas.append("")
    linhas.append("--- Notícias de comércio agro em destaque ---")
    if dados["noticias"]:
        for noticia in dados["noticias"]:
            linhas.append(f"- {noticia['titulo']}")
            linhas.append(f"  {noticia.get('resumo', '')}")
            linhas.append(f"  Fonte: {noticia.get('fonte', 'Notícias Agrícolas')} | {noticia['link']}")
    elif dados["erro_noticias"]:
        linhas.append(f"Não foi possível buscar notícias agora ({dados['erro_noticias']})")
    else:
        linhas.append(
            "Nenhuma notícia de comércio/economia agro encontrada nesta busca "
            "(o layout do site pode ter mudado - ver comentário na função buscar_noticias_agro)."
        )

    return "\n".join(linhas)


def gerar_email_html(
    dolar: dict | None,
    dolar_tr: dict | None,
    selic: dict | None,
    resultados_commodities: list,
    resultados_futuros: list,
    explicacoes_macro: list,
    noticias: list,
) -> str:
    """
    Monta a versão em HTML do e-mail diário: layout com seções, cores que
    mudam de acordo com alta/queda (verde/vermelho/cinza), e o texto
    explicativo de dólar/Selic. Usa apenas CSS inline (necessário para boa
    compatibilidade em clientes de e-mail como Gmail/Outlook).
    """
    hoje_fmt = datetime.now().strftime("%d/%m/%Y às %H:%M")

    # --- Bloco de câmbio oficial e juros ---
    linhas_macro_html = ""
    if dolar is not None:
        cor = _cor_variacao(dolar["variacao_pct"])
        rotulo = _rotulo_variacao(dolar["variacao_pct"])
        nota = _nota_defasagem(dolar["data"])
        linhas_macro_html += f"""
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
            <span style="font-size:15px;color:#111827;font-weight:600;">Dólar oficial (PTAX)</span>
            <span style="font-size:10px;color:#9ca3af;"> (referência Bacen)</span><br>
            <span style="font-size:22px;color:#111827;font-weight:700;">R$ {dolar['valor']:.4f}</span>
            <span style="font-size:13px;color:{cor};font-weight:600;"> &nbsp;{rotulo} ({dolar['variacao_pct']:+.2f}%)</span>
            <div style="font-size:12px;color:#6b7280;margin-top:2px;">Dado de {dolar['data']}{" — " + nota if nota else ""}</div>
          </td>
        </tr>"""
    if selic is not None:
        nota = _nota_defasagem(selic["data"])
        linhas_macro_html += f"""
        <tr>
          <td style="padding:10px 0;">
            <span style="font-size:15px;color:#111827;font-weight:600;">Selic (meta Copom)</span><br>
            <span style="font-size:22px;color:#111827;font-weight:700;">{selic['valor']:.2f}% a.a.</span>
            <div style="font-size:12px;color:#6b7280;margin-top:2px;">Dado de {selic['data']}{" — " + nota if nota else ""}</div>
          </td>
        </tr>"""

    # --- Bloco de commodities (tabela) ---
    linhas_commodities_html = ""
    for resultado in resultados_commodities:
        if "erro" in resultado:
            linhas_commodities_html += f"""
            <tr>
              <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;">{resultado['nome']}</td>
              <td colspan="2" style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">indisponível no momento</td>
            </tr>"""
            continue
        variacao = _variacao_para_float(resultado["variacao_pct"])
        cor = _cor_variacao(variacao)
        rotulo = _rotulo_variacao(variacao)
        nota = _nota_defasagem(resultado["data"])
        linhas_commodities_html += f"""
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;font-weight:500;">{resultado['nome']}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;text-align:right;white-space:nowrap;">R$ {resultado['preco_reais']}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:{cor};font-weight:600;text-align:right;white-space:nowrap;">{rotulo}{f" ({resultado['variacao_pct']})" if resultado['variacao_pct'] != 'n/d' else ""}</td>
        </tr>"""
        if nota:
            linhas_commodities_html += f"""
            <tr>
              <td colspan="3" style="padding:0 10px 8px 10px;font-size:11px;color:#9ca3af;">{nota}</td>
            </tr>"""

    # --- Bloco de futuros / tempo real (tabela) ---
    linhas_futuros_html = ""
    if dolar_tr is not None:
        cor_tr = _cor_variacao(dolar_tr["variacao_pct"])
        rotulo_tr = _rotulo_variacao(dolar_tr["variacao_pct"])
        linhas_futuros_html += f"""
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;font-weight:500;">🔴 Dólar (spot, tempo real)</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;text-align:right;white-space:nowrap;">R$ {dolar_tr['venda']:.4f}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:{cor_tr};font-weight:600;text-align:right;white-space:nowrap;">{rotulo_tr} ({dolar_tr['variacao_pct']:+.2f}%)</td>
        </tr>
        <tr>
          <td colspan="3" style="padding:0 10px 8px 10px;font-size:11px;color:#9ca3af;">Compra R$ {dolar_tr['compra']:.4f} · Atualizado às {dolar_tr['hora']} (AwesomeAPI)</td>
        </tr>"""
    for resultado in resultados_futuros:
        if "erro" in resultado:
            linhas_futuros_html += f"""
            <tr>
              <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;">{resultado['nome']}</td>
              <td colspan="2" style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#9ca3af;">indisponível no momento</td>
            </tr>"""
            continue
        variacao = _variacao_para_float(resultado["variacao_pct"])
        cor = _cor_variacao(variacao)
        rotulo = _rotulo_variacao(variacao)
        linhas_futuros_html += f"""
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;font-weight:500;">{resultado['nome']}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111827;text-align:right;white-space:nowrap;">{resultado['preco_reais']}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:{cor};font-weight:600;text-align:right;white-space:nowrap;">{rotulo}{f" ({resultado['variacao_pct']})" if resultado['variacao_pct'] != 'n/d' else ""}</td>
        </tr>
        <tr>
          <td colspan="3" style="padding:0 10px 8px 10px;font-size:11px;color:#9ca3af;">Fechamento mais recente · {resultado['data']}</td>
        </tr>"""

    # --- Bloco explicativo (contexto macro) ---
    paragrafos_explicacao = [
        l for l in explicacoes_macro
        if l and not l.startswith("---") and not l.startswith("Obs.:")
    ]
    obs_explicacao = next((l for l in explicacoes_macro if l.startswith("Obs.:")), None)
    explicacao_html = "".join(
        f'<p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 10px 0;">{p}</p>'
        for p in paragrafos_explicacao
    )
    if obs_explicacao:
        explicacao_html += (
            f'<p style="font-size:12px;color:#9ca3af;line-height:1.5;margin:10px 0 0 0;'
            f'font-style:italic;">{obs_explicacao}</p>'
        )

    # --- Bloco de noticias ---
    if noticias:
        noticias_html = ""
        for noticia in noticias:
            noticias_html += f"""
            <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #f0f0f0;">
              <a href="{noticia['link']}" style="font-size:14px;color:#1f2937;font-weight:600;text-decoration:none;">{noticia['titulo']}</a>
              <p style="font-size:13px;color:#4b5563;line-height:1.5;margin:6px 0;">{noticia.get('resumo', '')}</p>
              <span style="font-size:11px;color:#9ca3af;">Fonte: {noticia.get('fonte', 'Notícias Agrícolas')} — <a href="{noticia['link']}" style="color:#9ca3af;">ler matéria completa</a></span>
            </div>"""
    else:
        noticias_html = (
            '<p style="font-size:13px;color:#9ca3af;">Nenhuma notícia de comércio/economia agro '
            "encontrada nesta busca.</p>"
        )

    html = f"""\
<!DOCTYPE html>
<html lang="pt-br">
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">

          <tr>
            <td style="background-color:#14532d;padding:20px 24px;">
              <span style="font-size:20px;color:#ffffff;font-weight:700;">🌾 Monitor Agro</span><br>
              <span style="font-size:13px;color:#bbf7d0;">Resumo diário — {hoje_fmt}</span>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 24px 4px 24px;">
              <span style="font-size:15px;color:#111827;font-weight:700;">Câmbio e juros</span>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
                {linhas_macro_html}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px 4px 24px;">
              <span style="font-size:15px;color:#111827;font-weight:700;">Mercado físico</span>
              <span style="font-size:11px;color:#9ca3af;"> — indicador CEPEA/Esalq, preço de hoje</span>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
                {linhas_commodities_html}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px 4px 24px;">
              <span style="font-size:15px;color:#111827;font-weight:700;">Mercado Futuro / Cotação em Tempo Real</span>
              <span style="font-size:11px;color:#9ca3af;"> — dólar spot + fechamento mais recente dos futuros B3</span>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
                {linhas_futuros_html}
              </table>
              <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:8px 0 0 0;font-style:italic;">
                Diferença: o mercado físico (acima) é o preço que se negocia hoje na entrega
                imediata. O futuro B3 é o preço que o mercado financeiro está precificando agora
                para entrega em um mês futuro — reflete a expectativa dos operadores (clima,
                safra, câmbio, demanda externa), útil para decisões de hedge e timing de
                venda/compra. Já o dólar acima é cotação spot em tempo real (diferente da PTAX
                oficial, que é a referência fechada 1x/dia).
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 24px 4px 24px;background-color:#f9fafb;">
              <span style="font-size:15px;color:#111827;font-weight:700;">O que isso significa?</span>
              <div style="margin-top:8px;">{explicacao_html}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 24px 20px 24px;">
              <span style="font-size:15px;color:#111827;font-weight:700;">Notícias de comércio agro em destaque</span>
              <div style="margin-top:10px;">{noticias_html}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 24px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">
                Conteúdo gerado automaticamente a partir de fontes públicas (Banco Central,
                AwesomeAPI, B3 e CEPEA/Esalq, estas duas últimas via Notícias Agrícolas) para
                fins informativos. Não constitui recomendação de investimento ou negócio.
                Confira sempre a fonte original antes de decisões importantes.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    return html


def enviar_email(resumo: str, html: str | None = None) -> None:
    """
    Envia o resumo por e-mail via SMTP, em HTML (com fallback em texto
    puro para clientes de e-mail antigos que não renderizam HTML).

    As credenciais NÃO ficam no código - vêm de variáveis de ambiente,
    para não expor senha/usuário se o script for compartilhado ou versionado.
    Configure estas variáveis no seu sistema (ou nos "Secrets" do GitHub
    Actions, se for rodar na nuvem):

        SMTP_SERVIDOR      -> ex: smtp.gmail.com, smtp-mail.outlook.com
        SMTP_PORTA         -> ex: 587
        SMTP_USUARIO       -> seu e-mail completo, ex: nome@gmail.com
        SMTP_SENHA         -> senha de app (NUNCA a senha normal da conta, veja nota abaixo)
        EMAIL_DESTINATARIO -> e-mail(s) que vao receber o resumo

    PARA MANDAR PARA MAIS DE UMA PESSOA (ex: você e seu irmão), separe os
    endereços por VÍRGULA dentro da mesma variável:

        $env:EMAIL_DESTINATARIO = "voce@gmail.com,seuirmao@gmail.com"

    NOTA IMPORTANTE SOBRE SENHA:
    A maioria dos provedores (Gmail, Outlook/M365) BLOQUEIA login direto de
    scripts com a senha normal por segurança. É preciso gerar uma "senha de
    app" (App Password) específica para isso:
      - Gmail: https://myaccount.google.com/apppasswords (exige verificação
        em duas etapas ativada na conta)
      - Microsoft 365 / Outlook: gerado em Segurança da conta > Senhas de app
        (ou perguntar ao TI da empresa, pois contas corporativas M365 muitas
        vezes têm essa opção desativada por política - nesse caso, pergunte
        ao TI qual é o método de autenticação SMTP liberado internamente)
    """
    servidor = os.environ.get("SMTP_SERVIDOR")
    porta = os.environ.get("SMTP_PORTA", "587")
    usuario = os.environ.get("SMTP_USUARIO")
    senha = os.environ.get("SMTP_SENHA")
    destinatarios = os.environ.get("EMAIL_DESTINATARIO")

    faltando = [
        nome for nome, valor in [
            ("SMTP_SERVIDOR", servidor),
            ("SMTP_USUARIO", usuario),
            ("SMTP_SENHA", senha),
            ("EMAIL_DESTINATARIO", destinatarios),
        ] if not valor
    ]
    if faltando:
        print(
            "Aviso: e-mail não enviado. Faltam as variáveis de ambiente: "
            + ", ".join(faltando)
        )
        return

    mensagem = EmailMessage()
    mensagem["Subject"] = f"Monitor Agro - Resumo diário {datetime.now().strftime('%d/%m/%Y')}"
    mensagem["From"] = usuario
    mensagem["To"] = destinatarios
    mensagem.set_content(resumo)  # versão texto puro (fallback)
    if html:
        # Anexa a versão bonita em HTML como alternativa "preferida" -
        # é o que estava faltando antes: sem esta linha, o e-mail saía
        # só em texto puro, mesmo com o html sendo gerado corretamente.
        mensagem.add_alternative(html, subtype="html")

    contexto = ssl.create_default_context()
    try:
        with smtplib.SMTP(servidor, int(porta)) as smtp:
            smtp.starttls(context=contexto)
            smtp.login(usuario, senha)
            smtp.send_message(mensagem)
        print(f"E-mail enviado com sucesso para: {destinatarios}")
    except Exception as e:
        print(f"Falha ao enviar e-mail: {e}")


if __name__ == "__main__":
    import sys

    # Modo diagnóstico: python monitor_agro_v9.py --diagnostico "Trigo"
    # Imprime a estrutura crua da página daquela commodity (nomes de coluna
    # e primeira linha), sem enviar e-mail nem salvar histórico. Use isso se
    # algum preço continuar parecendo errado, e me mande o que aparecer.
    if len(sys.argv) >= 3 and sys.argv[1] == "--diagnostico":
        diagnosticar_commodity(sys.argv[2])
        sys.exit(0)

    dados = coletar_dados()
    resumo = montar_resumo_texto(dados)
    print("=== Monitor Agro v9 (com e-mail em HTML habilitado) ===")
    print(resumo)

    # Salva um histórico simples em arquivo de texto, um resumo por execução
    with open("historico_monitor_agro.txt", "a", encoding="utf-8") as arquivo:
        arquivo.write(resumo + "\n\n")

    # Monta a versão bonita em HTML a partir dos MESMOS dados já coletados
    html = gerar_email_html(
        dados["dolar"],
        dados["dolar_tr"],
        dados["selic"],
        dados["resultados_commodities"],
        dados["resultados_futuros"],
        dados["explicacoes_macro"],
        dados["noticias"],
    )

    # Envia por e-mail (só funciona se as variáveis de ambiente estiverem
    # configuradas - veja a função enviar_email() acima)
    enviar_email(resumo, html)