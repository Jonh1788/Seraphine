export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

/**
 * A URL do "Gasto do mês" do Hoje — a MESMA fonte do hero da tela de
 * Finanças (`fetchSummary`), e por isso o mesmo número.
 *
 * O que havia aqui antes era um `monthExpenses` que somava os lançamentos por
 * PREFIXO DA DATA DA COMPRA, a partir de uma busca sem mês. `/finance/summary`
 * soma por MÊS DE CAIXA — o mês em que o dinheiro sai, que para uma compra no
 * cartão é o do vencimento ou o do pagamento da fatura. Com as duas contas
 * vivas, uma compra de 15/07 numa fatura que vence em 10/08 entrava em julho
 * no Hoje e em agosto nas Finanças: dois números com o mesmo rótulo, no mesmo
 * app. Somar aqui de novo, de qualquer jeito, recria a divergência — quem
 * precisa do gasto do mês pergunta ao servidor.
 *
 * `month` vai em BASE 1 (`getMonth() + 1`), como a rota espera; sem o +1 o
 * bloco mostraria o mês passado parecendo certo.
 */
export function monthSummaryUrl(base: string, now: Date): string {
  const qs = new URLSearchParams({
    month: String(now.getMonth() + 1),
    year: String(now.getFullYear()),
  });
  return `${base}/finance/summary?${qs.toString()}`;
}
