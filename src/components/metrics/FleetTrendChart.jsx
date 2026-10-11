import { useId, useRef, useState, useEffect } from 'react';
import './FleetTrendChart.css';
import { movingAverages } from './movingAverages.mjs';

const dateLabel = value => {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(+date) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
export default function FleetTrendChart({ title, subtitle, definition, points = [], series, fixedMax, detail, footer, monthly = false }) {
  const uid = useId();
  const [showAverage, setShowAverage] = useState(true);
  const averageLabel = monthly ? '3-month average' : '7-day average';
  const averages = series.map(s => movingAverages(points, s.key, monthly));
  const root = useRef(null);
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState(null);
  const [info, setInfo] = useState(false);
  const infoButton = useRef(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setActive(null); }, [points]);
  const height = 220, left = 44, right = width - 12, top = 20, bottom = 188;
  const max = fixedMax ?? Math.max(1, ...points.flatMap(p => series.map(s => Number(p[s.key] ?? 0))));
  const x = i => points.length === 1 ? (left + right) / 2 : left + i / Math.max(1, points.length - 1) * (right - left);
  const y = n => bottom - Math.max(0, Number(n)) / max * (bottom - top);
  const selected = points[active];
  const latest = points.at(-1);
  const ticks = [];
  points.forEach((p, i) => {
    if (i === 0 || String(p.label).slice(0, 7) !== String(points[i - 1].label).slice(0, 7)) {
      if (!ticks.length || x(i) - x(ticks.at(-1)) > 65) ticks.push(i);
    }
  });
  if (points.length > 1 && (!ticks.length || x(points.length - 1) - x(ticks.at(-1)) > 65)) ticks.push(points.length - 1);
  const describe = p => `${dateLabel(p.label)}. ${series.map(s => `${s.label}: ${p[s.key] == null ? 'No data' : s.format(p[s.key])}`).join('. ')}${detail ? `. ${detail(p)}` : ''}`;
  return <section className="fleet-trend" ref={root} aria-label={title} onKeyDown={e => { if (e.key === 'Escape' && info) { setInfo(false); infoButton.current.focus(); } }}>
    <header className="fleet-trend__header">
      <div><div className="fleet-trend__title-row"><h3>{title}</h3>
        <button ref={infoButton} type="button" className="fleet-trend__info-button" aria-label={`About ${title}`} aria-expanded={info} aria-controls={`${uid}-info`} onClick={() => setInfo(!info)}>i</button>
      </div><p>{subtitle}</p></div>
      {latest && <div className="fleet-trend__latest"><span>Latest &middot; {dateLabel(latest.label)}</span>
        <div>{series.map(s => <strong key={s.key} style={{ color: s.color }}>{series.length > 1 && <small>{s.label} </small>}{latest[s.key] == null ? 'No data' : s.format(latest[s.key])}</strong>)}</div>
      </div>}
    </header>
    {info && <div id={`${uid}-info`} className="fleet-trend__info" role="region" aria-label={`${title} definition`} onKeyDown={e => { if (e.key === 'Escape') { setInfo(false); infoButton.current.focus(); } }}>
      <p>{definition}</p><p>The dashed line is a trailing {averageLabel.toLowerCase()} of recorded values, including the selected date. Early windows use available readings; missing values are excluded. Daily percentages are averaged equally.</p><button type="button" onClick={() => { setInfo(false); infoButton.current.focus(); }}>Close</button>
    </div>}
    {!points.length ? <p className="fleet-trend__empty">No data for this range.</p> : <>
      <label className="fleet-trend__average-toggle"><input type="checkbox" checked={showAverage} onChange={e => setShowAverage(e.target.checked)} /> Dashed line: {averageLabel}</label>
      <div className="fleet-trend__plot" tabIndex={0} role="group" aria-label={`${title}. Use left and right arrows to inspect dates; Home and End for first and last.`}
        onFocus={() => setActive(points.length - 1)} onBlur={() => setActive(null)}
        onPointerMove={e => { const box = e.currentTarget.getBoundingClientRect(); setActive(Math.max(0, Math.min(points.length - 1, Math.round((e.clientX - box.left - left) / (right - left) * (points.length - 1))))); }}
        onPointerLeave={() => { if (document.activeElement !== root.current?.querySelector('.fleet-trend__plot')) setActive(null); }}
        onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) { e.preventDefault(); setActive(i => e.key === 'Escape' ? null : e.key === 'Home' ? 0 : e.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (i ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }}>
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1={left} x2={right} y1={y(t * max)} y2={y(t * max)} className="fleet-trend__grid"/><text x={left - 9} y={y(t * max) + 4} textAnchor="end">{fixedMax === 1 ? `${t * 100}%` : new Intl.NumberFormat('en', { notation: 'compact' }).format(t * max)}</text></g>)}
          {series.map((s, si) => {
            const segments = []; let segment = [];
            points.forEach((p, i) => { if (p[s.key] == null) { if (segment.length) segments.push(segment); segment = []; } else segment.push([x(i), y(p[s.key])]); });
            if (segment.length) segments.push(segment);
            return <g key={s.key}><defs><linearGradient id={`${uid}-${si}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={s.color} stopOpacity=".15"/><stop offset="1" stopColor={s.color} stopOpacity=".01"/></linearGradient></defs>
              {segments.map((seg, j) => { const path = seg.map(([a,b], k) => `${k ? 'L' : 'M'} ${a} ${b}`).join(' '); return <g key={j}><path d={`${path} L ${seg.at(-1)[0]} ${bottom} L ${seg[0][0]} ${bottom} Z`} fill={`url(#${uid}-${si})`}/><path d={seg.length === 1 ? `${path} h .1` : path} fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/></g>; })}
            </g>;
          })}
          {showAverage && series.map((s, si) => {
            let connected = false;
            const path = averages[si].map((value, i) => {
              if (value == null) { connected = false; return ''; }
              const command = connected ? 'L' : 'M'; connected = true;
              return `${command} ${x(i)} ${y(value)}`;
            }).join(' ');
            return <path key={s.key} d={path} fill="none" stroke={series.length === 1 ? '#c6b7f4' : s.color} strokeWidth="2.3" strokeDasharray="6 4" />;
          })}
          {ticks.map(i => <text key={i} x={x(i)} y={214} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>{new Date(`${String(points[i].label).slice(0,10)}T12:00:00`).toLocaleDateString('en', { month: 'short', ...(points.length < 60 || i === points.length - 1 ? { day: 'numeric' } : {}) })}</text>)}
          {selected && <g><line x1={x(active)} x2={x(active)} y1={top} y2={bottom} className="fleet-trend__cursor"/>{series.map(s => selected[s.key] == null ? null : <circle key={s.key} cx={x(active)} cy={y(selected[s.key])} r="3.5" fill={s.color} stroke="#111d32" strokeWidth="2"/>)}</g>}
        </svg>
        {selected && <div className="fleet-trend__tooltip" role="tooltip" style={{ left: Math.max(0, Math.min(width - Math.min(240, width), x(active) - 120)) }}>
          <span>{dateLabel(selected.label)}</span>{series.map(s => <strong key={s.key} style={{ color: s.color }}>{s.label} <b>{selected[s.key] == null ? 'No data' : s.format(selected[s.key])}</b></strong>)}{showAverage && series.map((s, si) => <small key={s.key}>{series.length > 1 ? s.label + ' ' : ''}{averageLabel}: {averages[si][active] == null ? 'No data' : s.format(averages[si][active])}</small>)}{detail && <small>{detail(selected)}</small>}
        </div>}
      </div>
      <div className="fleet-trend__footer"><span>{footer}</span><span>Hover or focus &middot; Arrow keys to explore</span></div>
      <span className="fleet-trend__sr" aria-live="polite">{selected ? describe(selected) + (showAverage ? '. ' + series.map((s, si) => `${s.label} ${averageLabel}: ${averages[si][active] == null ? 'No data' : s.format(averages[si][active])}`).join('. ') : '') : ''}</span>
    </>}
  </section>;
}
