import { CATEGORY_COLORS, CATEGORY_LABELS } from './types';

interface CategoryRow {
  category: string;
  total: number;
  count: number;
  percentage: number;
}

interface CategoryTableProps {
  data: CategoryRow[];
  totalExpenses: number;
}

function fmtBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function CategoryTable({ data }: CategoryTableProps): JSX.Element {
  const sorted = [...data].sort((a, b) => b.total - a.total);

  return (
    <div className="finance-table-wrap">
      <table className="finance-table">
        <thead>
          <tr>
            <th>Categoria</th>
            <th>Total</th>
            <th>Qtd</th>
            <th>%</th>
            <th>Barra</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const color = CATEGORY_COLORS[row.category] ?? CATEGORY_COLORS.outros;
            const label = CATEGORY_LABELS[row.category] ?? row.category;
            return (
              <tr key={row.category}>
                <td>{label}</td>
                <td className="finance-table__amount">{fmtBRL(row.total)}</td>
                <td className="finance-table__count">{row.count}</td>
                <td className="finance-table__pct">{row.percentage.toFixed(1)}%</td>
                <td className="finance-table__bar-cell">
                  <div className="finance-bar">
                    <div
                      className="finance-bar__fill"
                      style={{ width: `${row.percentage}%`, background: color }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
