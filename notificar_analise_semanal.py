# -*- coding: utf-8 -*-
"""
Notificar Analise Semanal - AgroFer Trader
=============================================
Script pequeno, chamado pelo workflow .github/workflows/analise-semanal.yml
DEPOIS que o PR do rascunho da semana ja foi aberto (ver
gerar_analise_semanal.py para o script que gera o conteudo em si).

So manda um e-mail avisando que o rascunho esta pronto pra revisar, com
o link do PR - reaproveita monitor_agro_v9.enviar_email() (mesmas
variaveis de ambiente SMTP do resumo diario). Se as variaveis de
e-mail nao estiverem configuradas, enviar_email() so avisa no log e
nao quebra o workflow (mesmo comportamento do resumo diario).

Uso:
    python notificar_analise_semanal.py <url-do-pr> <slug1> [<slug2> ...]
"""

import sys
from datetime import datetime

import monitor_agro_v9 as monitor


def montar_resumo(url_pr: str, slugs: list) -> str:
    nomes = ", ".join(slugs)
    return (
        f"Rascunho da análise semanal pronto para revisão ({nomes}).\n\n"
        f"Revise o conteúdo, peça ajustes se precisar, e mergeie quando "
        f"estiver de acordo - nada foi publicado ainda.\n\n"
        f"Pull request: {url_pr}\n"
    )


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python notificar_analise_semanal.py <url-do-pr> <slug1> [<slug2> ...]")
        sys.exit(1)

    url_pr = sys.argv[1]
    slugs = sys.argv[2:]

    resumo = montar_resumo(url_pr, slugs)
    print(resumo)

    assunto = f"AgroFer Trader - Análise semanal pronta para revisão ({datetime.now().strftime('%d/%m/%Y')})"
    monitor.enviar_email(resumo, assunto=assunto)
