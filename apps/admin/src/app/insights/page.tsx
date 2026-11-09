'use client';

/**
 * Insights for management: counts and totals for the city being viewed, over a chosen period and compared with the
 * period before. No individual member is shown. The figures export as CSV, and a weekly summary can be emailed.
 */
import { useEffect, useState } from 'react';
import type { InsightPeriod, InsightQuery, StaffInsights } from '@quintara/api-client';
import { toApiError } from '@quintara/api-client';
import { fmtMoney, useAdmin, useLoad, useRun } from '@/lib/admin';

const PERIODS: [InsightPeriod, string][] = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['12m', '12 months'], ['ytd', 'This year']];
const SOURCES: [key: string, label: string][] = [['membership', 'New memberships'], ['membership_renewal', 'Renewals'], ['experience', 'Experiences'], ['boutique', 'Maison Quintara'], ['other', 'Other']];
const label = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const pct = (x: number | null) => (x === null ? 'Not yet' : `${Math.round(x * 100)}%`);
const compact = (minor: number, currency: string) => {
  const v = minor / 100, sym = currency === 'ZAR' ? 'R' : `${currency} `;
  return v >= 1_000_000 ? `${sym}${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}m` : v >= 1000 ? `${sym}${Math.round(v / 1000)}k` : `${sym}${Math.round(v)}`;
};
function change(now: number, before: number) {
  if (!before) return now ? 'New in this period' : 'No change';
  const p = Math.round(((now - before) / before) * 100);
  return `${p >= 0 ? 'Up' : 'Down'} ${Math.abs(p)}% on the period before`;
}

export default function InsightsPage() {
  const { api, market } = useAdmin();
  const [query, setQuery] = useState<InsightQuery>({ period: '30d' });
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [data, setData] = useState<StaffInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.getInsights(query).then((d) => { if (live) { setData(d); setError(null); } }, (e: unknown) => { if (live) setError(toApiError(e).code === 'forbidden' ? 'Your staff role does not include this.' : toApiError(e).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, query, market?.id]);

  return (
    <>
      <div>
        <h1>Insights</h1>
        <p className="lede">Counts and totals for {data?.market.name ?? 'this city'} only. No individual member&rsquo;s activity is shown here.</p>
      </div>
      <div className="periods" role="group" aria-label="Period">
        <div className="seg">
          {PERIODS.map(([p, l]) => <button key={p} aria-pressed={!query.from && query.period === p} onClick={() => setQuery({ period: p })}>{l}</button>)}
        </div>
        <form className="row" onSubmit={(event) => { event.preventDefault(); if (custom.from && custom.to) setQuery({ period: '30d', from: custom.from, to: custom.to }); }}>
          <label style={{ fontSize: 12.5 }}>From<input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label style={{ fontSize: 12.5 }}>To<input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          <button className="btn ghost" disabled={!custom.from || !custom.to}>Show</button>
        </form>
        <a className="btn ghost" href={api.insightsExportUrl(query)}>Export as CSV</a>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!data ? (loading ? <p className="muted" role="status">Loading</p> : null) : (
        <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 120ms', display: 'grid', gap: 26 }} aria-busy={loading}>
          <p className="muted" style={{ margin: 0 }}>{data.period.label}: {data.period.from} to {data.period.to}. Compared with {data.previous.from} to {data.previous.to}.</p>
          <Headline d={data} />
          <section>
            <h2>Revenue</h2>
            <Revenue d={data} />
          </section>
          <section className="two">
            <div>
              <h2>Members joining and lapsing</h2>
              <Flow d={data} />
            </div>
            <div>
              <h2>Renewals</h2>
              <Renewals d={data} />
            </div>
          </section>
          <section className="two">
            <div><h2>Members by plan</h2><Bars rows={data.membership.byTier.map((t) => [t.tier, t.count])} /></div>
            <div>
              <h2>Applications received</h2>
              <Bars rows={[['Received', data.membership.applications.submitted], ['Approved, awaiting payment', data.membership.applications.approved], ['Now members', data.membership.applications.activated], ['On the waiting list', data.membership.applications.waitlisted], ['Declined', data.membership.applications.declined]]} />
            </div>
          </section>
          <section>
            <h2>Experiences</h2>
            <Bars rows={data.experiences.map((e) => [e.title, e.capacity ? e.seatsTaken / e.capacity : 0, `${e.seatsTaken} of ${e.capacity} seats${e.bookings ? `, ${e.bookings} booked in the period` : ''}${e.revenueMinor ? `, ${fmtMoney(e.revenueMinor, data.market.currency)}` : ''}`])} empty="No experiences in this period." />
          </section>
          <section className="two">
            <div><h2>Most requested services</h2><Bars rows={data.services.map((s) => [s.name, s.requests])} empty="No service requests in this period." /></div>
            <div><h2>Partners</h2><Bars rows={data.partners.map((p) => [p.name, p.bookings + p.redemptions, `${p.bookings} booking${p.bookings === 1 ? '' : 's'}, ${p.redemptions} privilege${p.redemptions === 1 ? '' : 's'} used`])} empty="No partner bookings or privileges used in this period." /></div>
          </section>
          <section className="two">
            <div>
              <h2>Maison Quintara</h2>
              <div className="tiles" style={{ marginBottom: 12 }}>
                <Tile k="Orders" v={String(data.maison.orders)} d={change(data.headline.orders, data.headline.ordersPrev)} />
                <Tile k="Sales" v={fmtMoney(data.maison.revenueMinor, data.market.currency)} d={`Average ${fmtMoney(data.maison.averageMinor, data.market.currency)}${data.maison.cancelled ? `. ${data.maison.cancelled} cancelled` : ''}`} />
              </div>
              <Bars rows={data.maison.topProducts.map((p) => [p.title, p.units, `${p.units} sold, ${fmtMoney(p.revenueMinor, data.market.currency)}`])} empty="Nothing sold in this period." />
            </div>
            <div>
              <h2>Concierge requests</h2>
              <Bars rows={data.concierge.map((c) => [label(c.kind), c.count])} empty="No concierge requests in this period." />
              <h2>Engagement</h2>
              <Bars rows={[['Messages to QÉRA', data.engagement.qeraMessages], ['Actions confirmed with QÉRA', data.engagement.qeraActionsConfirmed], ['Members with push notifications on', data.engagement.membersWithPush, `${data.engagement.membersWithPush} (${pct(data.engagement.pushShare)} of members)`]]} />
              <h2>Club</h2>
              <Bars rows={[['Connections made', data.club.connections], ['Conversations', data.club.conversations], ['Blocks', data.club.blocks], ['Open reports', data.club.openReports]]} />
            </div>
          </section>
          <WeeklyReport />
        </div>
      )}
    </>
  );
}

function Tile({ k, v, d }: { k: string; v: string; d?: string }) {
  return <div className="tile"><span className="k">{k}</span><span className="v">{v}</span>{d ? <span className="d">{d}</span> : null}</div>;
}

function Headline({ d }: { d: StaffInsights }) {
  const h = d.headline, cur = d.market.currency;
  return (
    <div className="tiles" aria-label="Headline figures">
      <Tile k="Revenue" v={fmtMoney(h.revenueMinor, cur).replace('Complimentary', `${cur === 'ZAR' ? 'R' : cur} 0`)} d={change(h.revenueMinor, h.revenuePrevMinor)} />
      <Tile k="Active members" v={String(h.activeMembers)} d={`${h.newMembers} joined, ${h.lapsedMembers} lapsed`} />
      <Tile k="Renewal rate" v={pct(h.renewalRate)} d="Renewed, of those whose term ended" />
      <Tile k="Automatic renewal" v={pct(h.autoRenewShare)} d="Of members with a term" />
      <Tile k="Experience bookings" v={String(h.bookings)} d={change(h.bookings, h.bookingsPrev)} />
      <Tile k="Maison orders" v={String(h.orders)} d={change(h.orders, h.ordersPrev)} />
    </div>
  );
}

/* ---------- Charts ---------- */

interface Series { key: string; label: string; color: string }
interface ColumnsProps {
  buckets: { label: string; values: Record<string, number> }[];
  series: Series[];
  /** Stacked (parts of a total) or side by side (two things compared). */
  stacked: boolean;
  format: (n: number) => string;
  axis: (n: number) => string;
  title: string;
}

const roundedTop = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};
const niceMax = (v: number) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };

/** Columns over time with a hover (and keyboard) tooltip, a legend with totals, and a table view. */
function Columns({ buckets, series, stacked, format, axis, title }: ColumnsProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 760, H = 240, L = 54, B = 26, T = 8, plotW = W - L - 8, plotH = H - B - T;
  const totals = buckets.map((b) => series.reduce((s, x) => s + (b.values[x.key] ?? 0), 0));
  const max = niceMax(stacked ? Math.max(0, ...totals) : Math.max(0, ...buckets.flatMap((b) => series.map((x) => b.values[x.key] ?? 0))));
  const slot = plotW / Math.max(1, buckets.length), barW = Math.max(2, Math.min(36, slot * 0.68)), y = (v: number) => T + plotH - (v / max) * plotH;
  const every = Math.ceil(buckets.length / 8);
  const sums = series.map((x) => buckets.reduce((s, b) => s + (b.values[x.key] ?? 0), 0));
  const shown = series.filter((_, k) => (sums[k] ?? 0) > 0 || !stacked);
  return (
    <div className="panel viz">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <ul className="legend" aria-label="Legend">{(shown.length ? shown : series).map((x) => <li key={x.key}><i style={{ background: x.color }} />{x.label}<b>{format(sums[series.indexOf(x)]!)}</b></li>)}</ul>
        <button type="button" className="link" style={{ fontSize: 13 }} onClick={() => setTable(!table)}>{table ? 'Show the chart' : 'Show as a table'}</button>
      </div>
      {sums.every((v) => !v) && !table ? <p className="muted" style={{ margin: '24px 0' }}>Nothing in this period yet.</p> : table ? (
        <div className="scroll"><table>
          <thead><tr><th>{title}</th>{series.map((x) => <th key={x.key}>{x.label}</th>)}{stacked ? <th>Total</th> : null}</tr></thead>
          <tbody>{buckets.map((b, i) => <tr key={i}><td>{b.label}</td>{series.map((x) => <td key={x.key}>{format(b.values[x.key] ?? 0)}</td>)}{stacked ? <td>{format(totals[i]!)}</td> : null}</tr>)}</tbody>
        </table></div>
      ) : (
        <div className="chart" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${series.map((x, k) => `${x.label} ${format(sums[k]!)}`).join(', ')}`}>
            <g className="grid axis">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={L} x2={W - 8} y1={y(max * f)} y2={y(max * f)} /><text x={L - 8} y={y(max * f) + 4} textAnchor="end">{axis(max * f)}</text></g>)}
            </g>
            {buckets.map((b, i) => {
              const cx = L + slot * i + slot / 2;
              if (stacked) {
                let base = 0;
                const parts = series.map((x) => ({ x, v: b.values[x.key] ?? 0 })).filter((p) => p.v > 0);
                return (
                  <g key={i}>
                    {parts.map((p, k) => {
                      const y0 = y(base), y1 = y(base + p.v); base += p.v;
                      // A 2px gap of surface between stacked parts; the top part has the rounded end.
                      const top = k === parts.length - 1, h = Math.max(1, y0 - y1 - (k > 0 ? 2 : 0));
                      return top ? <path key={p.x.key} d={roundedTop(cx - barW / 2, y1, barW, h, 4)} fill={p.x.color} /> : <rect key={p.x.key} x={cx - barW / 2} y={y1} width={barW} height={h} fill={p.x.color} />;
                    })}
                  </g>
                );
              }
              const w = Math.max(2, (barW - 2) / series.length);
              return <g key={i}>{series.map((x, k) => { const v = b.values[x.key] ?? 0; return v > 0 ? <path key={x.key} d={roundedTop(cx - barW / 2 + k * (w + 2), y(v), w, T + plotH - y(v), 4)} fill={x.color} /> : null; })}</g>;
            })}
            <line x1={L} x2={W - 8} y1={T + plotH} y2={T + plotH} stroke="var(--q-muted)" strokeWidth={1} />
            <g className="axis">{buckets.map((b, i) => (i % every === 0 ? <text key={i} x={L + slot * i + slot / 2} y={H - 8} textAnchor="middle">{b.label}</text> : null))}</g>
            {buckets.map((b, i) => (
              <rect key={i} className="hit" x={L + slot * i} y={T} width={slot} height={plotH} tabIndex={0} aria-label={`${b.label}: ${series.map((x) => `${x.label} ${format(b.values[x.key] ?? 0)}`).join(', ')}`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} style={{ opacity: hover === i ? 0.35 : undefined }} />
            ))}
          </svg>
          {hover !== null ? (
            <div className="tip" style={{ left: `clamp(0px, calc(${((L + slot * hover + slot / 2) / W) * 100}% - 90px), calc(100% - 200px))`, top: 0 }}>
              <div className="t">{buckets[hover]!.label}</div>
              {series.map((x) => <div key={x.key}><span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: x.color, marginRight: 6 }} />{x.label}</span><span>{format(buckets[hover]!.values[x.key] ?? 0)}</span></div>)}
              {stacked ? <div style={{ borderTop: '1px solid var(--q-line)', marginTop: 4, paddingTop: 4 }}><span>Total</span><span>{format(totals[hover]!)}</span></div> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

function Revenue({ d }: { d: StaffInsights }) {
  const cur = d.market.currency;
  const series = SOURCES.map(([key, l], k) => ({ key, label: l, color: COLORS[k]! }));
  return (
    <Columns title={d.bucket === 'month' ? 'Month' : d.bucket === 'week' ? 'Week of' : 'Day'} stacked series={series}
      buckets={d.revenueSeries.map((r) => ({ label: r.label, values: r.bySource }))}
      format={(n) => fmtMoney(n, cur).replace('Complimentary', `${cur === 'ZAR' ? 'R' : cur} 0`)} axis={(n) => compact(n, cur)} />
  );
}

function Flow({ d }: { d: StaffInsights }) {
  const series = [{ key: 'joined', label: 'Joined', color: COLORS[0]! }, { key: 'lapsed', label: 'Lapsed', color: COLORS[1]! }];
  return (
    <Columns title={d.bucket === 'month' ? 'Month' : d.bucket === 'week' ? 'Week of' : 'Day'} stacked={false} series={series}
      buckets={d.membership.flow.map((f) => ({ label: f.label, values: { joined: f.joined, lapsed: f.lapsed } }))}
      format={(n) => String(n)} axis={(n) => (Number.isInteger(n) ? String(n) : '')} />
  );
}

function Renewals({ d }: { d: StaffInsights }) {
  const r = d.membership.renewals;
  return (
    <>
      <div className="tiles">
        <Tile k="Due in 30 days" v={String(r.due30)} d={`${r.due60} in 60 days`} />
        <Tile k="Need attention" v={String(r.failing)} d="Declined or past their end date" />
        <Tile k="Renewed" v={String(r.renewed)} d={`${r.lapsed} lapsed in the period`} />
      </div>
      <Bars rows={[['Automatic renewal on', r.autoRenewOn], ['Automatic renewal off', r.autoRenewOff]]} />
      <p><a href="/renewals">Renewals coming up and failing</a></p>
    </>
  );
}

/** One labelled bar per row, scaled to the largest value in the group. Single series: one colour, labels in ink. */
function Bars({ rows, empty = 'Nothing to show yet.' }: { rows: [name: string, value: number, text?: string][]; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  const top = Math.max(1, ...rows.map((row) => row[1]));
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      {rows.map(([name, value, text]) => (
        <div key={name} title={`${name}: ${text ?? value}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}><span>{name}</span><span className="muted" style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{text ?? value}</span></div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--q-track)', marginTop: 6 }}><div style={{ height: 6, borderRadius: 3, background: 'var(--q-accent)', width: `${Math.round((value / top) * 100)}%`, minWidth: value > 0 ? 4 : 0 }} /></div>
        </div>
      ))}
    </div>
  );
}

/** The weekly report: on or off for this member of staff, and sent now on request. */
function WeeklyReport() {
  const { api } = useAdmin();
  const setting = useLoad((client) => client.getReportSetting());
  const { run, pending, error } = useRun();
  const [sent, setSent] = useState(false);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const on = chosen ?? setting.data?.weeklyReport ?? false;
  return (
    <section className="panel" style={{ maxWidth: 680 }}>
      <h2 style={{ margin: 0 }}>Weekly report</h2>
      <p className="muted" style={{ margin: 0 }}>Every Monday morning, the last seven days for each city by email: revenue, members, renewals, bookings, Maison Quintara and applications. Counts and totals only.</p>
      <label className="check"><input type="checkbox" checked={on} disabled={pending || setting.loading} onChange={(event) => { const next = event.target.checked; setChosen(next); void run(async () => { try { await api.setReportSetting(next); } catch (e) { setChosen(!next); throw e; } }); }} /> Email me the weekly report</label>
      <div className="row"><button className="btn ghost" disabled={pending} onClick={() => run(async () => { await api.sendReportToMe(); setSent(true); })}>{sent ? 'Sent to your email' : 'Email me this week’s report now'}</button></div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}
