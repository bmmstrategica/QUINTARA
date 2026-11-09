import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="state">
      <h2>That page does not exist</h2>
      <p className="lede">It may have moved, or the link may be incomplete.</p>
      <Link className="btn" href="/">Back to home</Link>
    </div>
  );
}
