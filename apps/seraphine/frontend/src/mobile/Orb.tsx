import './obsidian.css';

export function Orb({ size, float = false, halo = false }:
  { size: number; float?: boolean; halo?: boolean }) {
  return (
    <span className={`morb-wrap${halo ? ' morb-wrap--halo' : ''}`} style={{ width: size, height: size }}>
      {halo && <span className="morb__halo" aria-hidden="true" />}
      <span className={`morb${float ? ' morb--float' : ''}`}
        style={{ width: size, height: size }} aria-hidden="true">
        <span className="morb__spec" />
      </span>
    </span>
  );
}
