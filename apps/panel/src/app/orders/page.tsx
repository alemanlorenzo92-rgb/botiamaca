'use client';

import { Fragment, useState } from 'react';
import { Shell } from '@/components/Shell';
import { api, qs } from '@/lib/api';
import { BUYER_TYPE, ORDER_STATUS, contactName, dateTime, money } from '@/lib/format';
import { useData } from '@/lib/use-data';

interface Order {
  id: string;
  number: number;
  status: string;
  wholesale: boolean;
  totalEstimate: string | null;
  shippingNotes: string | null;
  notes: string | null;
  createdAt: string;
  contact: { id: string; name: string | null; pushName: string | null; phone: string | null; buyerType: string };
  items: { id: string; description: string; quantity: number; unitPrice: string | null }[];
}

function Orders() {
  const [status, setStatus] = useState('PENDING_REVIEW');
  const [open, setOpen] = useState<string | null>(null);
  const { data, reload } = useData<{ orders: Order[]; total: number }>(`/orders${qs({ status, limit: 100 })}`);

  const setOrderStatus = async (id: string, next: string) => {
    await api(`/orders/${id}`, { method: 'PATCH', body: { status: next } });
    await reload();
  };

  return (
    <div className="stack">
      <h1>Pedidos a revisar</h1>
      <p className="muted small">
        Los pedidos del bot no cobran ni confirman pago: el equipo revisa precio, stock y envío y lo confirma con el cliente.
      </p>
      <div className="tabs">
        {[['', 'Todos'], ...Object.entries(ORDER_STATUS)].map(([k, v]) => (
          <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k ?? '')}>
            {v}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Cliente</th>
            <th>Tipo</th>
            <th>Total estimado</th>
            <th>Estado</th>
            <th>Fecha</th>
          </tr>
        </thead>
        <tbody>
          {data?.orders.map((o) => (
            <Fragment key={o.id}>
              <tr className="clickable" onClick={() => setOpen(open === o.id ? null : o.id)}>
                <td>{o.number}</td>
                <td>{contactName(o.contact)}</td>
                <td>{o.wholesale ? 'Mayorista' : BUYER_TYPE[o.contact.buyerType]}</td>
                <td>{money(o.totalEstimate)}</td>
                <td>{ORDER_STATUS[o.status]}</td>
                <td>{dateTime(o.createdAt)}</td>
              </tr>
              {open === o.id && (
                <tr>
                  <td colSpan={6}>
                    <div className="stack">
                      <table>
                        <tbody>
                          {o.items.map((i) => (
                            <tr key={i.id}>
                              <td>{i.description}</td>
                              <td>x{i.quantity}</td>
                              <td>{money(i.unitPrice)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {o.shippingNotes && <div>Envío: {o.shippingNotes}</div>}
                      {o.notes && <div>Notas: {o.notes}</div>}
                      <div className="row">
                        {Object.entries(ORDER_STATUS)
                          .filter(([k]) => k !== o.status)
                          .map(([k, v]) => (
                            <button key={k} onClick={() => setOrderStatus(o.id, k)}>
                              Marcar {v.toLowerCase()}
                            </button>
                          ))}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {data && data.total === 0 && <p className="muted">No hay pedidos.</p>}
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Shell>
      <Orders />
    </Shell>
  );
}
