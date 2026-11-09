'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { StaffDeliveryOption, StaffProduct, UploadedPhoto } from '@quintara/api-client';
import type { PublishStatus } from '@quintara/domain';
import { PhotoUpload, thumb } from '@/components/photo-upload';
import { Loaded, useAdmin, useLoad, useRun } from '@/lib/admin';

const STATUS: Record<PublishStatus, string> = { draft: 'Draft', published: 'On sale', archived: 'Archived' };
const rand = (value: FormDataEntryValue | null) => Math.round(Number(value) * 100);

export default function BoutiquePage() {
  const { api } = useAdmin();
  const orders = useLoad((client) => client.listOrders());
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const products = useLoad((client) => client.listProducts());
  const delivery = useLoad((client) => client.listDeliveryOptions());
  const { run, pending, error } = useRun();

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim();
    const stock = text('stock'), memberPrice = text('memberPrice');
    void run(async () => {
      await api.createProduct({
        title: text('title'), maker: text('maker'), category: text('category'), description: text('description'), priceMinor: rand(f.get('price')), currency: 'ZAR',
        memberPriceMinor: memberPrice === '' ? null : rand(memberPrice), membersOnly: f.get('membersOnly') === 'on', imageId: photo?.id ?? null,
        options: text('options').split(',').map((o) => o.trim()).filter(Boolean), stock: stock === '' ? null : Number(stock),
      });
    }, () => { form.reset(); setPhoto(null); products.reload(); });
  }

  return (
    <>
      <div><h1>Maison Quintara</h1><p className="lede">Pieces, prices, stock and photographs set here show in the apps and on the Maison Quintara shop at once.</p><p><a href={process.env.NEXT_PUBLIC_MAISON_URL ?? 'http://localhost:3002'} target="_blank" rel="noopener noreferrer">Open the Maison Quintara shop</a></p></div>
      <Loaded state={orders}>
        {(list) => {
          const open = list.filter((o) => ['paid', 'preparing', 'dispatched'].includes(o.status)).length, toProcess = list.filter((o) => o.status === 'paid').length;
          return (
            <div className="panel" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
              <p>{open === 0 ? 'No orders in progress.' : `${open} order${open === 1 ? '' : 's'} in progress${toProcess ? `, ${toProcess} paid and waiting to be processed` : ''}.`}</p>
              <Link className="btn" href="/orders">Track orders</Link>
            </div>
          );
        }}
      </Loaded>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>Products</h2><a className="btn" href="#new-product">Add product</a></div>
      <Loaded state={products}>
        {(list) => (
          <div className="scroll"><table>
            <thead><tr><th></th><th>Product</th><th>Public price (rand)</th><th>Member price</th><th>In stock</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((p) => <ProductRow key={p.id} product={p} onChanged={products.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <h2>Delivery methods</h2>
      <Loaded state={delivery}>
        {(list) => (
          <div className="scroll"><table>
            <thead><tr><th>Method</th><th>Fee (rand)</th><th>Free over (rand)</th><th>Status</th><th></th></tr></thead>
            <tbody>{list.map((d) => <DeliveryRow key={d.id} option={d} onChanged={delivery.reload} />)}</tbody>
          </table></div>
        )}
      </Loaded>
      <NewDelivery onCreated={delivery.reload} />
      <h2 id="new-product">New product</h2>
      <form className="panel" onSubmit={create}>
        <div className="form">
          <label>Title<input name="title" required minLength={2} maxLength={120} /></label>
          <label>Made by<input name="maker" maxLength={120} /></label>
          <label>Category<input name="category" required minLength={2} maxLength={60} placeholder="Accessories, Home" /></label>
          <label>Public price, in rand<input name="price" type="number" min={1} step="1" required /></label>
          <label>Member price, in rand (optional)<input name="memberPrice" type="number" min={1} step="1" /></label>
          <label>In stock (leave empty if made to order)<input name="stock" type="number" min={0} /></label>
          <label>Options, separated by commas<input name="options" placeholder="Tan, Black" /></label>
        </div>
        <label>Description<input name="description" maxLength={2000} /></label>
        <label className="check"><input name="membersOnly" type="checkbox" /> For members only: hidden from visitors</label>
        {photo ? (
          <div className="row"><img src={thumb(photo.path, 96)} alt="" style={{ width: 96, height: 120, objectFit: 'cover', borderRadius: 4 }} /><span className="muted">Photograph ready, {photo.width.toLocaleString('en-ZA')} × {photo.height.toLocaleString('en-ZA')} px.</span><button type="button" className="link" onClick={() => setPhoto(null)}>Remove</button></div>
        ) : <PhotoUpload frame="portrait" hint="Shown in an arched frame on the shop: portrait framing works best" onUploaded={setPhoto} actionLabel="Use this photograph" />}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div><button className="btn" disabled={pending}>{pending ? 'Saving' : 'Create draft'}</button></div>
      </form>
    </>
  );
}

function DeliveryRow({ option: d, onChanged }: { option: StaffDeliveryOption; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [fee, setFee] = useState(d.feeMinor / 100);
  const [freeOver, setFreeOver] = useState(d.freeOverMinor === null ? '' : String(d.freeOverMinor / 100));
  const nextFree = freeOver === '' ? null : Math.round(Number(freeOver) * 100);
  const changed = Math.round(fee * 100) !== d.feeMinor || nextFree !== d.freeOverMinor;
  return (
    <tr>
      <td>{d.name}<small>{d.description}</small>{error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td><input type="number" min={0} step="1" aria-label={`Fee for ${d.name}`} value={fee} onChange={(event) => setFee(Number(event.target.value))} style={{ width: 110 }} /></td>
      <td><input type="number" min={1} step="1" aria-label={`Free threshold for ${d.name}`} placeholder="Never" value={freeOver} onChange={(event) => setFreeOver(event.target.value)} style={{ width: 120 }} /></td>
      <td><span className={`chip ${d.isActive ? 'ok' : ''}`}>{d.isActive ? 'Offered' : 'Retired'}</span></td>
      <td className="row">
        <button className="btn" disabled={pending || !changed || fee < 0} onClick={() => run(() => api.updateDeliveryOption(d.id, { feeMinor: Math.round(fee * 100), freeOverMinor: nextFree }), onChanged)}>Save</button>
        <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateDeliveryOption(d.id, { isActive: !d.isActive }), onChanged)}>{d.isActive ? 'Retire' : 'Offer again'}</button>
      </td>
    </tr>
  );
}

function NewDelivery({ onCreated }: { onCreated: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  return (
    <form className="panel" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget, f = new FormData(form), text = (key: string) => String(f.get(key) ?? '').trim(), free = text('freeOver');
      void run(() => api.createDeliveryOption({ name: text('name'), description: text('description'), feeMinor: rand(f.get('fee')), freeOverMinor: free === '' ? null : rand(free), currency: 'ZAR' }), () => { form.reset(); onCreated(); });
    }}>
      <div className="form">
        <label>New delivery method<input name="name" required minLength={2} maxLength={80} placeholder="Courier, Cape Town" /></label>
        <label>Fee, in rand<input name="fee" type="number" min={0} step="1" required defaultValue={0} /></label>
        <label>Free for orders over, in rand (optional)<input name="freeOver" type="number" min={1} step="1" /></label>
        <label>What the member is told<input name="description" maxLength={240} /></label>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div><button className="btn ghost" disabled={pending}>Add method</button></div>
    </form>
  );
}

function ProductRow({ product: p, onChanged }: { product: StaffProduct; onChanged: () => void }) {
  const { api } = useAdmin();
  const { run, pending, error } = useRun();
  const [price, setPrice] = useState(p.priceMinor / 100);
  const [member, setMember] = useState(p.memberPriceMinor === null ? '' : String(p.memberPriceMinor / 100));
  const [stock, setStock] = useState(p.stock === null ? '' : String(p.stock));
  const nextStock = stock === '' ? null : Number(stock), nextMember = member === '' ? null : Math.round(Number(member) * 100);
  const changed = Math.round(price * 100) !== p.priceMinor || nextStock !== p.stock || nextMember !== p.memberPriceMinor;
  const [editing, setEditing] = useState(false);
  const [photoOpen, setPhotoOpen] = useState<false | 'replace' | 'crop'>(false);
  return (
    <>
    <tr>
      <td>{p.imagePath ? <img src={thumb(p.imagePath, 56)} alt="" style={{ width: 56, height: 70, objectFit: 'cover', borderRadius: 4 }} /> : <span className="muted">No photo</span>}</td>
      <td>{p.title}<small>{p.category}{p.maker ? `. ${p.maker}` : ''}{p.options.length ? `. ${p.options.join(', ')}` : ''}</small>
        <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={p.membersOnly} disabled={pending} onChange={(event) => run(() => api.updateProduct(p.id, { membersOnly: event.target.checked }), onChanged)} /> Members only</label>
        <span className="row" style={{ gap: 10, marginTop: 4 }}>
          <button type="button" className="link" style={{ fontSize: 13 }} aria-expanded={photoOpen === 'replace'} onClick={() => setPhotoOpen(photoOpen === 'replace' ? false : 'replace')}>{photoOpen === 'replace' ? 'Close' : p.imagePath ? 'Replace photograph' : 'Add photograph'}</button>
          {p.imagePath ? <button type="button" className="link" style={{ fontSize: 13 }} aria-expanded={photoOpen === 'crop'} onClick={() => setPhotoOpen(photoOpen === 'crop' ? false : 'crop')}>{photoOpen === 'crop' ? 'Close' : 'Crop photograph'}</button> : null}
        </span>
        {error ? <small className="error" role="alert">{error}</small> : null}</td>
      <td><input type="number" min={1} step="1" aria-label={`Public price of ${p.title}`} value={price} onChange={(event) => setPrice(Number(event.target.value))} style={{ width: 110 }} /></td>
      <td><input type="number" min={1} step="1" aria-label={`Member price of ${p.title}`} placeholder="Same" value={member} onChange={(event) => setMember(event.target.value)} style={{ width: 110 }} /></td>
      <td><input type="number" min={0} aria-label={`Stock of ${p.title}`} placeholder="To order" value={stock} onChange={(event) => setStock(event.target.value)} style={{ width: 100 }} /></td>
      <td><span className={`chip ${p.status === 'published' ? 'ok' : p.status === 'draft' ? 'gold' : ''}`}>{STATUS[p.status]}</span></td>
      <td className="row">
        <button className="btn ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
        <button className="btn" disabled={pending || !changed || price <= 0} onClick={() => run(() => api.updateProduct(p.id, { priceMinor: Math.round(price * 100), memberPriceMinor: nextMember, stock: nextStock }), onChanged)}>Save</button>
        {p.status !== 'published' ? <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateProduct(p.id, { status: 'published' }), onChanged)}>Put on sale</button> : <button className="btn ghost" disabled={pending} onClick={() => run(() => api.updateProduct(p.id, { status: 'archived' }), onChanged)}>Take off sale</button>}
      </td>
    </tr>
    {photoOpen ? (
      <tr>
        <td colSpan={7}>
          <PhotoUpload key={photoOpen} frame="portrait" source={photoOpen === 'crop' ? p.imagePath ?? undefined : undefined} actionLabel={photoOpen === 'crop' ? 'Save the crop' : p.imagePath ? 'Replace photograph' : 'Add photograph'}
            hint={photoOpen === 'crop' ? 'Cropping starts from the photograph now in use. To bring back a part already cut away, upload the original again' : undefined}
            onUploaded={async (photo) => { await api.updateProduct(p.id, { imageId: photo.id }); setPhotoOpen(false); onChanged(); }} />
        </td>
      </tr>
    ) : null}
    {editing ? (
      <tr>
        <td colSpan={7}>
          <form aria-label={`Edit ${p.title}`} style={{ display: 'grid', gap: 12 }} onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget), text = (key: string) => String(f.get(key) ?? '').trim();
            void run(() => api.updateProduct(p.id, { title: text('title'), maker: text('maker'), category: text('category'), description: text('description'), options: text('options').split(',').map((o) => o.trim()).filter(Boolean) }), () => { setEditing(false); onChanged(); });
          }}>
            <div className="form">
              <label>Title<input name="title" required minLength={2} maxLength={120} defaultValue={p.title} /></label>
              <label>Made by<input name="maker" maxLength={120} defaultValue={p.maker} /></label>
              <label>Category<input name="category" required minLength={2} maxLength={60} defaultValue={p.category} /></label>
              <label>Options, separated by commas<input name="options" defaultValue={p.options.join(', ')} /></label>
            </div>
            <label>Description<textarea name="description" maxLength={2000} rows={3} defaultValue={p.description} /></label>
            <div className="row">
              <button className="btn" disabled={pending}>{pending ? 'Saving' : 'Save changes'}</button>
              {p.imagePath ? <button type="button" className="btn ghost" disabled={pending} onClick={() => run(() => api.updateProduct(p.id, { imageId: null }), onChanged)}>Remove photograph</button> : null}
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    ) : null}
    </>
  );
}
