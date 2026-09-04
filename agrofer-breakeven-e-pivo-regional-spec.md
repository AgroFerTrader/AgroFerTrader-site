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

*(Nota de implementação: na prática, foi encontrada fonte pública automatizável de Sul de Minas para as 4 commodities — inclusive milho/soja/boi gordo, que a spec original previa como manual. Ver commits do pivô regional.)*

---

## 6. Onde inserir a calculadora no site

1. Novo item de navegação: "Calculadora de Break-even" (rota própria, ex: `/calculadora`).
2. Bloco contextual em cada página de commodity: calculadora compacta, com `preco_venda` pré-preenchido pelo preço do dia daquela commodity (nacional ou regional, o que estiver disponível), com CTA "Veja se esse preço cobre seu custo".
3. Ambas as instâncias reaproveitam o mesmo componente de cálculo (não duplicar lógica).

---

## 7. Decisões sobre as dúvidas técnicas levantadas na implementação

1. **Persistência (seção 4.1):** o site é estático (GitHub Pages), sem backend. Para o MVP/piloto (volume pequeno: João, irmão, agrônomo, poucos colegas), usar **Google Sheets via Apps Script** como armazenamento — gratuito, sem infraestrutura extra, e os registros ficam legíveis diretamente na planilha para conferência manual. Migrar para **Supabase** (Postgres) quando o volume justificar (ex: acima de ~100 registros, ou quando o benchmark regional da seção 4.1 precisar de consultas agregadas). Não usar Firebase — o modelo de dado (subcategorias, histórico, futuro benchmark agregado) é relacional, encaixa melhor em SQL.
2. **Boi gordo:** fora do escopo da calculadora (modelo hectares × sacas/ha não se aplica a pecuária de corte — usa cabeça/arroba/taxa de lotação). Mantém boi gordo apenas na tabela de preço regional (seção 5). Variante pecuária fica para uma fase futura, fora do escopo atual.
3. **Pessoa física × jurídica:** adicionar toggle explícito no fluxo, antes do resultado final ("Você declara como pessoa física ou jurídica?"), com **pessoa física pré-selecionada como padrão** — não deixar implícito sem pergunta, pois muda a alíquota de Funrural aplicada.
4. **Produtividade média regional — valores de referência (cadastrar como constante, mesmo padrão de `unidades` já existente):**

   | Cultura | Produtividade média MG (safra 2025/26, fonte CONAB 10º Levantamento) | Em sacas/ha |
   |---|---|---|
   | Soja | 3,8 t/ha | ≈ 63 sacas/ha |
   | Milho (1ª safra) | 6,7 t/ha | ≈ 112 sacas/ha |
   | Café (safra 2026, estimativa) | — | 28,6 sacas/ha (MG) |

   Marcar no código a fonte e a safra de referência (CONAB 2025/26) para saber quando revisar — atualizar uma vez por safra, não deixar fixo indefinidamente.
5. **Sequência de trabalho confirmada:** Parte 1 (pivô regional) primeiro, item por item, com preview antes de cada commit — só iniciar a Parte 2 (calculadora) depois da Parte 1 estável.

---

## 8. Persistência — endpoint em produção

Google Apps Script implantado como Web App (`doPost`/`doGet` num Google Sheet), URL configurada em `gerar_calculadora.py` (`URL_PERSISTENCIA_CALCULADORA`). Contrato:

- **POST** (corpo JSON): `email`, `cultura`, `hectares`, `produtividade_ha`, `custo_fixo_total`, `custo_variavel_total`, `subcategorias_fixas` (lista `{nome, valor}`), `subcategorias_variaveis` (idem), `preco_venda`, `meses_ate_venda`, `pessoa_juridica`, `break_even`, `margem_contribuicao`, `margem_bruta`, `lucro_liquido_saca`, `lucro_liquido_total`. Cria a aba "Registros" na primeira chamada.
- **GET** `?email=X`: devolve a lista de registros salvos daquele e-mail (array de objetos, um por cálculo salvo). E-mail ausente ou aba ainda inexistente devolvem erro/lista vazia sem quebrar.

Front-end (`assets/calculadora.js`) lembra o e-mail em `localStorage`, carrega o histórico automaticamente na volta, e mostra a "Evolução frente à safra anterior" (break-even + subcategorias por nome) a partir do 2º registro salvo da mesma cultura — só o fato e o percentual, nunca a causa (regra editorial da seção 4.1).

---

## 9. Resumo, diagnóstico e detalhamento (correção — obrigatório, feedback do piloto real)

**Problema identificado no primeiro teste real (produção do irmão, milho, 4ha):** os números batem matematicamente (verificado célula por célula), mas exibir só os 4 cartões técnicos (break-even, ganho marginal, ganho real bruto, ganho real líquido) sem narrativa deixou o produtor confuso — em especial porque "ganho marginal" (margem de contribuição) é numericamente maior que "ganho real bruto" (margem após rateio do custo fixo), o que parece contraditório sem explicação. Feedback de segunda rodada: falta uma camada de **diagnóstico analítico** (não confundir com recomendação — recomendação é o texto de alerta que já existe; diagnóstico é leitura crítica/comparativa em cima dos números).

**Ordem final de exibição do resultado:**
1. **Resumo narrativo** (9.1) — parágrafo gerado dinamicamente, texto fixo e sempre visível.
2. **Diagnóstico** (9.2) — tópicos curtos, cada um uma comparação aritmética, nunca causal; texto fixo e sempre visível, no mesmo nível de destaque do resumo (não fica escondido atrás de clique/hover).
3. **Detalhamento técnico** (cartões da seção 4) — explicações de conceito (ex: "ganho marginal") viram ícone ⓘ discreto ao lado do rótulo, expandido só sob clique/hover — não mais parágrafo fixo ocupando espaço da tela.

### 9.1. Resumo narrativo

**Template do parágrafo-resumo (preencher com os valores calculados):**

Caso `preco_venda >= break_even` (situação positiva):
```
"Você plantou {hectares} hectares de {cultura}, com produtividade esperada de {produtividade} sacas/ha —
cerca de {sacas_totais} sacas nesta safra. Seus custos somam R${custo_total_total} (R${custo_fixo_total} fixos +
R${custo_variavel_total} variáveis). Para não ter prejuízo, você precisa vender a pelo menos R${break_even} por saca.
Ao preço informado de R${preco_venda}/saca, sua receita bruta seria R${receita_bruta_total}; depois do Funrural,
sobra R${receita_liquida_total} líquidos — dos quais R${custo_total_total} cobrem seu custo, restando
R${lucro_liquido_total} de lucro líquido nesta safra (R${lucro_liquido_saca} por saca). Esse preço está
R${margem_bruta} acima do seu break-even: uma margem {qualificar: apertada se margem_bruta/break_even < 10%,
confortável se >= 10%}."
```

Caso `preco_venda < break_even` (situação de alerta — usar cor vermelha no bloco):
```
"Atenção: ao preço de R${preco_venda}/saca, você venderia abaixo do seu break-even de R${break_even} —
isso resultaria em prejuízo de R${prejuizo_total} nesta safra (R${prejuizo_saca} por saca). Considere renegociar
o preço, reduzir custo ou aguardar uma janela melhor antes de vender."
```

*(Implementado — ver `montarResumo()` em `assets/calculadora.js` e `.calc-resumo` em `calculadora/_template.html`. Testado com o cenário exato do piloto (milho, 4ha) e com um cenário de prejuízo; matemática conferida célula por célula nos dois casos.)*

### 9.2. Diagnóstico (tópicos curtos, cada um uma fórmula, nunca causa especulada)

**Diagnóstico 1 — produtividade necessária ao preço informado (inverso do break-even):**
```
produtividade_minima = custo_total_ha / preco_venda
```
Exibir sempre. Texto:
```
Se preco_venda < break_even (ou seja, produtividade_minima > produtividade informada):
"Para não ter prejuízo ao preço de R${preco_venda}/saca, você precisaria produzir pelo menos
{produtividade_minima} sacas/ha — {diferenca} sacas/ha a mais do que você informou ({produtividade})."

Se preco_venda >= break_even:
"Sua produtividade de {produtividade} sacas/ha está {diferenca} sacas/ha acima do mínimo necessário
({produtividade_minima} sacas/ha) para não ter prejuízo a este preço."
```

**Diagnóstico 2 — comparação com o preço futuro de mercado (só exibir se o produtor alterou o preço pré-preenchido pelo feed B3; se manteve o valor de mercado, omitir por redundância):**
```
diferenca_mercado_valor = preco_venda_informado - preco_futuro_mercado
diferenca_mercado_pct = diferenca_mercado_valor / preco_futuro_mercado
```
Texto:
```
"O mercado (B3) projeta R${preco_futuro_mercado}/saca para entrega em {vencimento}, enquanto você projetou
vender a R${preco_venda_informado} — uma diferença de R${diferenca_mercado_valor} ({diferenca_mercado_pct}%)
{acima/abaixo} do que o mercado sinaliza para essa data."
```

**Diagnóstico 3 — Fase 2, só ativar quando houver volume mínimo de dados regionais (ver seção 4.1, regra dos 15-20 produtores):** comparação de produtividade e composição de custo com a média de outros produtores da mesma cultura/região. Não implementado ainda — fica preparado no componente para receber esse terceiro bloco depois.

**Regra editorial (reforçando o que já vale para toda a ferramenta):** cada item do diagnóstico é comparação aritmética entre dois números (o que o produtor informou vs. um referencial — mínimo necessário, preço de mercado, ou futuramente média regional). Nunca inferir causa ("sua produtividade está baixa porque...") — só o quê e o quanto.

*(Implementado — ver `montarDiagnostico()` em `assets/calculadora.js` e `#calc-diagnostico` em `calculadora/_template.html`. Diagnóstico 3 deixado para a Fase 2, conforme decisão da seção 4.1.)*

### 9.3. Explicações de conceito — de parágrafo fixo para ícone ⓘ discreto

Removido o texto de explicação fixo abaixo do cartão "Ganho marginal/saca". Substituído por um ícone pequeno (ⓘ) ao lado do rótulo do cartão, que exibe a explicação em popover só ao clicar/tocar (elemento `<details>` nativo do HTML, acessível e sem JS extra) — mantém a tela limpa e a explicação disponível sob demanda.

**Nota para o Claude Code:** o resumo narrativo (9.1) e o diagnóstico (9.2) juntos são o elemento mais importante da tela de resultado — devem vir com destaque visual, no topo, antes dos cartões técnicos (seção 4), que passam a ser "detalhamento" secundário.

*(Implementado — ver `.calc-info`/`.calc-info-popover` em `calculadora/_template.html`.)*

---

## 10. Notas para o Claude Code

- Não implementar cálculo de Funrural como constante fixa sem comentário — deixar claro no código que a alíquota pode mudar (já mudou em abril/2026 pela LC 224/2025) e deve ser fácil de atualizar em um único lugar.
- Os campos de preço regional manual (milho/soja/boi) precisam de UI de edição simples para João/irmão atualizarem sem mexer em código (JSON simples ou campo de admin, dependendo do que o gerador de site já usa).
- As subcategorias de custo (seção 2) devem persistir como lista de objetos `{nome, valor}` por categoria, não como campos fixos — isso é o que permite ao produtor adicionar subcategorias personalizadas sem alteração de schema.
- Cada uso completo da calculadora (hectares, região, cultura, produtividade informada vs. sugerida, custos por subcategoria) deve ser salvo de forma anonimizada — é a base do banco de dados regional de custo/margem discutido como ativo de longo prazo do negócio.
