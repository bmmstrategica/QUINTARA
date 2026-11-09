'use client';

import { useState } from 'react';
import type { StaffMarket } from '@quintara/api-client';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const ZONES = ['Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Cairo', 'Indian/Mauritius', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Lisbon', 'America/New_York'];

/** Cities: which are open to members and guests, and how much has been prepared in each. */
export default function CitiesPage() {
  const { api, setMarket, reloadMarkets } = useAdmin();
  const state = useLoad((client) => client.listMarkets());
  const { run, pending, error } = useRun();
  const [form, setForm] = useState({ name: '', countryCode: 'ZA', countryName: '', timezone: 'Africa/Johannesburg', currency: 'ZAR' });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  const changed = () => { state.reload(); reloadMarkets(); };
  const toggle = (m: StaffMarket) => {
    const question = m.isOpen
      ? `Close ${m.name}? Members, guests and visitors will no longer see it. Nothing is deleted.`
      : `Open ${m.name}? Its published experiences, partners, services and Maison Quintara pieces become visible to members, guests and visitors.`;
    if (window.confirm(question)) void run(() => api.setMarketOpen(m.id, !m.isOpen), changed);
  };
  return (
    <>
      <div>
        <h1>Cities</h1>
        <p className="lede">A city is prepared before it opens: choose it under “Working in”, then add its experiences, partners, services and Maison Quintara pieces. Only staff see a closed city. Opening it shows everything published there to members, guests and visitors.</p>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <Loaded state={state}>
        {(cities) => (
          <div className="scroll"><table>
            <thead><tr><th>City</th><th>Status</th><th>Experiences</th><th>Members</th><th>Partners</th><th>Services</th><th>Maison Quintara</th><th></th></tr></thead>
            <tbody>{cities.map((m) => (
              <tr key={m.id}>
                <td>{m.name}<small>{m.country}. {m.timezone}. {m.currency}</small></td>
                <td><span className={`chip ${m.isOpen ? 'ok' : 'gold'}`}>{m.isOpen ? 'Open' : 'Closed'}</span></td>
                <td>{m.experiences}</td><td>{m.members}</td><td>{m.partners}</td><td>{m.services}</td><td>{m.products}</td>
                <td className="row">
                  <button className="btn ghost" onClick={() => setMarket(m.slug)}>Work in {m.name}</button>
                  <button className={m.isOpen ? 'btn ghost' : 'btn'} disabled={pending} onClick={() => toggle(m)}>{m.isOpen ? 'Close' : 'Open'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Loaded>
      <h2>Add a city</h2>
      <form className="panel" onSubmit={(event) => { event.preventDefault(); void run(() => api.createMarket(form), () => { setForm({ ...form, name: '', countryName: '' }); changed(); }); }}>
        <div className="form">
          <label>City<input value={form.name} onChange={set('name')} required minLength={2} placeholder="Durban" /></label>
          <label>Country code<input value={form.countryCode} onChange={set('countryCode')} required maxLength={2} placeholder="ZA" /></label>
          <label>Country name (for a new country)<input value={form.countryName} onChange={set('countryName')} placeholder="Kenya" /></label>
          <label>Time zone<select value={form.timezone} onChange={set('timezone')}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select></label>
          <label>Currency<input value={form.currency} onChange={set('currency')} required maxLength={3} placeholder="ZAR" /></label>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>A new city starts closed, with its own time zone and currency, so it can be prepared first.</p>
        <div><button className="btn" disabled={pending}>{pending ? 'Adding' : 'Add city'}</button></div>
      </form>
    </>
  );
}
