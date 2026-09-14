# -*- coding: utf-8 -*-
"""
Gerar Ícones PWA - AgroFer Trader
====================================
Ferramenta manual (não roda via GitHub Actions, igual gerar_analise_semanal.py)
para gerar, a partir do mesmo logo mestre já usado nos favicons existentes
(assets/logo.png), os ícones "maskable" exigidos pelo manifest.json do PWA.

Ícones normais (purpose "any") já existem em assets/ (android-chrome-192x192.png
e android-chrome-512x512.png) e são reaproveitados como estão - só os
maskable são novos, porque precisam de uma margem de segurança extra: o
Android pode recortar o ícone em círculo, "squircle" etc, e qualquer
conteúdo fora da zona segura central é cortado. Por isso o logo aqui é
desenhado bem menor dentro do quadrado (~60% do canvas), centralizado
sobre um fundo sólido na cor de fundo do site (site.webmanifest /
manifest.json), em vez de aproveitar o quadro branco original do logo.

Uso (só quando o logo mestre mudar):
    python gerar_icones_pwa.py
"""

import os

from PIL import Image, ImageDraw

PASTA_SITE = os.path.dirname(os.path.abspath(__file__))
PASTA_ASSETS = os.path.join(PASTA_SITE, "assets")
CAMINHO_LOGO = os.path.join(PASTA_ASSETS, "logo.png")

# Mesma cor de background_color/theme_color do manifest.json.
COR_FUNDO_MASKABLE = (23, 51, 33, 255)  # #173321

# Fração do canvas ocupada pelo logo dentro do ícone maskable. O Android
# garante como "zona segura" um círculo central de 80% do canvas (raio
# 40%) - 60% deixa uma folga generosa para o logo (que já tem texto fino)
# sobreviver a qualquer formato de recorte (círculo, squircle, etc.).
FRACAO_LOGO_MASKABLE = 0.60

TAMANHOS_MASKABLE = [192, 512]


def gerar_icone_maskable(tamanho: int) -> str:
    logo = Image.open(CAMINHO_LOGO).convert("RGBA")

    canvas = Image.new("RGBA", (tamanho, tamanho), COR_FUNDO_MASKABLE)

    tamanho_logo = round(tamanho * FRACAO_LOGO_MASKABLE)
    logo_redimensionado = logo.resize((tamanho_logo, tamanho_logo), Image.LANCZOS)

    # Cantos arredondados no "cartão" branco do logo, em vez de um quadrado
    # com quinas retas - fica melhor quando o Android recorta o ícone em
    # círculo/squircle, sem mudar a zona segura calculada acima.
    raio = round(tamanho_logo * 0.12)
    mascara_cantos = Image.new("L", (tamanho_logo, tamanho_logo), 0)
    ImageDraw.Draw(mascara_cantos).rounded_rectangle(
        [(0, 0), (tamanho_logo - 1, tamanho_logo - 1)], radius=raio, fill=255
    )
    alpha_original = logo_redimensionado.split()[3]
    logo_redimensionado.putalpha(Image.composite(
        alpha_original, Image.new("L", (tamanho_logo, tamanho_logo), 0), mascara_cantos
    ))

    offset = ((tamanho - tamanho_logo) // 2, (tamanho - tamanho_logo) // 2)
    canvas.paste(logo_redimensionado, offset, logo_redimensionado)

    caminho_saida = os.path.join(PASTA_ASSETS, f"icon-maskable-{tamanho}x{tamanho}.png")
    canvas.convert("RGB").save(caminho_saida, "PNG")
    return caminho_saida


def gerar_icones_pwa() -> None:
    for tamanho in TAMANHOS_MASKABLE:
        caminho = gerar_icone_maskable(tamanho)
        print(f"Ícone maskable gerado: {caminho}")


if __name__ == "__main__":
    gerar_icones_pwa()
