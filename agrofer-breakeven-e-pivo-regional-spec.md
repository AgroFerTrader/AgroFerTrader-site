# Especificação — Calculadora de Break-even/Margem + Pivô Regional (Sul de Minas)

Repo: https://github.com/AgroFerTrader/AgroFerTrader-site
Gerado a partir de conversa entre João e Claude — repassar este documento ao Claude Code como briefing.
Versão 2 — inclui subcategorias de custo, fluxo por hectare→produtividade, e preço futuro por data de venda.

---

## 1. Fluxo de preenchimento (ordem exata das telas/passos)

1. **Hectares plantados** (input numérico simples)
2. **Produtividade esperada (sacas/ha)** — pré-preenchido com média regional (fonte: CONAB/IBGE por cultura), editável. Texto de apoio: "Média regional de X sacas/ha — se você já sabe sua média das últimas safras, use ela, é mais precisa."
3. **Custos fixos** — ver seção 2 (subcategorias)
4. **Custos variáveis** — ver seção 2 (subcategorias)
5. **Quando pretende vender/colher** — input em meses a partir de hoje (ex: "daqui a 5 meses")
6. **Preço de venda** — pré-preenchido com o preço futuro do vencimento B3 mais próximo da data calculada no passo 5 (ver seção 3); editável caso o produtor prefira usar outro número
7. **Resultado** — ver seção 4

---

## 2. Custos fixos e variáveis — por subcategoria, não valor único

Cada categoria (fixo e variável) é uma lista de subcategorias com nome + valor em **R$ total gasto na área inteira** (não R$/ha — é mais natural para o produtor responder "gastei R$8.000 de adubo" do que fazer a conta por hectare sozinho; o sistema normaliza depois).

**Subcategorias pré-cadastradas de Custo Fixo** (cada uma com campo de valor, todas opcionais/zeráveis):
- Arrendamento/aluguel da terra
- Depreciação de máquinas e equipamentos
- Mão de obra fixa (salários + encargos)
- Seguro rural
- Manutenção de benfeitorias/infraestrutura
- ITR e outros impostos fixos

**Subcategorias pré-cadastradas de Custo Variável:**
- Sementes
- Fertilizantes/adubos
- Defensivos (herbicida, inseticida, fungicida)
- Combustível/diesel
- Mão de obra temporária/diarista
- Colheita (frete de colheitadeira terceirizada, se aplicável)
- Frete/transporte da produção
- Secagem e armazenagem

**Funcionalidade obrigatória:** botão "+ Adicionar subcategoria" em ambas as listas, permitindo nome livre + valor. Cada linha tem opção de remover. Mostrar subtotal da categoria em tempo real conforme o produtor preenche.

**Tooltip/texto de apoio em cada categoria (não em cada subcategoria individual, para não poluir):**
- Custo fixo: "O que você paga independente de quanto colher."
- Custo variável: "O que você gasta proporcional ao tamanho da lavoura."

**Normalização para cálculo (automática, não exibida como etapa separada):**
```
custo_fixo_ha = soma(subcategorias_fixas) / hectares
custo_variavel_ha = soma(subcategorias_variaveis) / hectares
```

---

## 3. Preço futuro por data de venda

Input: "daqui a quantos meses pretende vender" → calcular data-alvo (hoje + N meses).

Lógica:
1. Identificar o vencimento de contrato futuro na B3 mais próximo (igual ou posterior) à data-alvo, para a commodity em questão (cada commodity tem seu próprio calendário de vencimentos — não são os mesmos meses para milho, soja, café, boi gordo).
2. Buscar o preço desse vencimento (mesma fonte/feed já usado pelo monitor_agro_v9.py para preço futuro).
3. Exibir com o texto: **"Preço de referência para o vencimento de [mês/ano] — o que você poderia travar hoje via contrato futuro ou a termo. Não é uma previsão do preço nessa data, é o valor negociável agora para entrega futura."**

Isso é crítico: nunca apresentar esse número como "previsão" — é preço de trava disponível hoje, não estimativa do futuro.

Produtor pode sobrescrever esse valor manualmente se quiser simular outro cenário de preço.

---

## 4. Fórmulas de cálculo (usar os valores já normalizados por hectare da seção 2)

```
custo_total_ha = custo_fixo_ha + custo_variavel_ha
break_even = custo_total_ha / produtividade                         # R$/saca

custo_variavel_unitario = custo_variavel_ha / produtividade          # R$/saca
margem_contribuicao = preco_venda - custo_variavel_unitario          # R$/saca — "ganho marginal por saca"
margem_bruta = preco_venda - break_even                              # R$/saca — "ganho real bruto por saca"

sacas_totais = hectares * produtividade
lucro_bruto_total = margem_bruta * sacas_totais                      # checagem cruzada: deve bater com (margem_contribuicao*sacas_totais - custo_fixo_ha*hectares)

# Funrural — confirmar alíquota vigente com contador antes de fixar em produção
aliquota_funrural = 0.0163 if not pessoa_juridica else 0.0223

receita_bruta_total = preco_venda * sacas_totais
funrural_total = receita_bruta_total * aliquota_funrural
receita_liquida_total = receita_bruta_total - funrural_total
lucro_liquido_total = receita_liquida_total - (custo_total_ha * hectares)
lucro_liquido_saca = lucro_liquido_total / sacas_totais
```

Outputs a exibir (rótulos exatos, em sacas totais da propriedade E por saca):
- **Break-even (preço mínimo por saca):** `break_even`
- **Ganho marginal por saca (margem de contribuição):** `margem_contribuicao`
- **Ganho real bruto por saca:** `margem_bruta`
- **Ganho real líquido por saca (após Funrural):** `lucro_liquido_saca`
- **Resultado total da safra (líquido):** `lucro_liquido_total`

Alerta visual (vermelho) obrigatório se `preco_venda < break_even`: "Preço abaixo do break-even — prejuízo projetado."

---

## 4.1. Persistência e comparação histórica (Fase 2 — depende de volume mínimo para o benchmark regional, mas a captura de dado começa já no MVP)

**Identificação leve, não conta completa:** ao final de cada cálculo, oferecer:
- Botão "Baixar planilha/PDF do resultado" — sempre disponível, sem exigir nenhum dado do produtor.
- Campo opcional "Salvar meu histórico" pedindo apenas e-mail (ou telefone) — sem senha. Retornando com o mesmo identificador, o sistema carrega automaticamente os cálculos anteriores daquele produtor para comparação, sem exigir reenvio de planilha.
- Checkbox de consentimento obrigatório junto a esse campo: "Seus dados ficam salvos para comparação nas próximas safras; não serão compartilhados com terceiros sem sua autorização" (linguagem final a validar com LGPD antes de produção).

**Produtor com histórico próprio, no primeiro uso:** logo após o resultado do cálculo atual, seção opcional "Já tem os números da safra passada? Compare agora" — permite inserir manualmente uma safra anterior mesmo sem uso prévio da ferramenta, liberando a comparação de evolução na hora.

**Leitura gerencial a exibir (com o cuidado editorial abaixo):**
- Composição do custo (sempre disponível): ranking das subcategorias por % do custo total — "sua maior despesa foi X, com Y% do custo."
- Evolução própria (a partir da 2ª safra registrada, via e-mail salvo ou inserção manual): variação de cada subcategoria e do break-even frente à safra anterior do mesmo produtor.
- Benchmark regional (só exibir com mínimo de 15-20 produtores da mesma cultura/região cadastrados; abaixo disso, omitir a comparação, não aproximar com amostra pequena): posição de cada subcategoria frente à média regional, sempre informando quantos produtores compõem a amostra.

**Regra editorial:** a leitura automatizada pode descrever o quê e o quanto mudou (fato, aritmética) — nunca o porquê (causa), a menos que o próprio produtor tenha informado o motivo. Nunca inferir causa de mercado ou de manejo a partir da variação de custo isolada.

---

## 5. Pivô regional — o que muda em cada commodity

| Commodity | Fonte da praça regional | Observação |
|---|---|---|
| Café | CEPEA já publica "Sul de Minas" como praça oficial (junto com Mogiana, Cerrado) | Automatizável — mesmo processo que já existe para praças nacionais em `monitor_agro_v9.py`, só trocar o parâmetro de região |
| Milho | Sem indicador público granular para Sul de Minas | Não automatizável via scraping — exige input manual (campo de preço coletado por telefone/visita, com data de coleta) |
| Soja | Mesmo caso do milho | Idem — input manual |
| Boi gordo | Mesmo caso do milho | Idem — input manual |

Ação no código:
- Manter na página principal: preço nacional das 4 commodities + notícias nacionais principais (não mexer).
- Nas páginas individuais de commodity: substituir o bloco de "praças de fora" (PR, MS, BA etc.) por:
  - Café: nova chamada ao CEPEA filtrando região "Sul de Minas" (mesma função scraper existente, novo parâmetro).
  - Milho/Soja/Boi gordo: novo campo de dado manual no CMS/JSON de conteúdo (`preco_regional_manual`, `fonte_regional`, `data_coleta_regional`), exibido com rótulo claro "Preço coletado em [fonte], atualizado em [data]" — não disfarçar como feed automático.

---

## 6. Onde inserir a calculadora no site

1. Novo item de navegação: "Calculadora de Break-even" (rota própria, ex: `/calculadora`).
2. Bloco contextual em cada página de commodity: calculadora compacta, com `preco_venda` pré-preenchido pelo preço do dia daquela commodity (nacional ou regional, o que estiver disponível), com CTA "Veja se esse preço cobre seu custo".
3. Ambas as instâncias reaproveitam o mesmo componente de cálculo (não duplicar lógica).

---

## 7. Notas para o Claude Code

- Não implementar cálculo de Funrural como constante fixa sem comentário — deixar claro no código que a alíquota pode mudar (já mudou em abril/2026 pela LC 224/2025) e deve ser fácil de atualizar em um único lugar.
- Os campos de preço regional manual (milho/soja/boi) precisam de UI de edição simples para João/irmão atualizarem sem mexer em código (JSON simples ou campo de admin, dependendo do que o gerador de site já usa).
- As subcategorias de custo (seção 2) devem persistir como lista de objetos `{nome, valor}` por categoria, não como campos fixos — isso é o que permite ao produtor adicionar subcategorias personalizadas sem alteração de schema.
- Cada uso completo da calculadora (hectares, região, cultura, produtividade informada vs. sugerida, custos por subcategoria) deve ser salvo de forma anonimizada — é a base do banco de dados regional de custo/margem discutido como ativo de longo prazo do negócio.
