# 082 - Finance Dashboard Cleanup

## Objetivo

Remover `mockData.ts` do finance dashboard e garantir que todos os dados exibidos vêm exclusivamente do backend (`mod-finance`). Corrigir qualquer fallback silencioso para dados fake.

## Motivacao

- `mockData.ts` existe no frontend finance e pode estar sendo usado como fallback quando o backend nao responde ou retorna vazio.
- Em producao, isso causa confusao: o usuario ve dados que nao existem.

## Entregas

1. **Auditoria de uso do mockData**
   - Mapear todos os imports de `mockData.ts` em `FinanceDashboard.tsx`, `PieChart.tsx`, `CategoryTable.tsx`, `TransactionList.tsx`, `PendingReview.tsx`.
   - Documentar se o mock e usado como fallback, placeholder de loading, ou debug-only.

2. **Remover mockData.ts**
   - Deletar o arquivo.
   - Substituir qualquer uso por estados de loading/empty corretos:
     - Loading: skeleton animado.
     - Empty: mensagem "Nenhuma transacao neste mes" com CTA para adicionar.
     - Erro: retry button com mensagem de offline.

3. **Validar integração com backend**
   - `GET /finance/summary?month=&year=` retorna dados reais.
   - `GET /finance/entries` popula a TransactionList.
   - `GET /finance/balance` alimenta o saldo geral.
   - PendingReview lista apenas entries com status `pending_review`.

4. **Empty states com personalidade**
   - Dashboard vazio no primeiro uso mostra onboarding inline: "Adicione sua primeira transação pelo chat ou importe um extrato PDF".

## Limites

- Nao alterar a API do mod-finance.
- Nao adicionar novos campos ao modelo de finance entry.

## Criterios de aceite

- `mockData.ts` deletado do repositorio.
- Zero imports de mockData em qualquer arquivo.
- Dashboard com 0 entries mostra empty state, nao dados fake.
- Dashboard com entries reais renderiza corretamente.
- Build do frontend passa sem erros.
