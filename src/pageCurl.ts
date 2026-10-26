/**
 * 페이지 컬(접힘) 기하 계산.
 *
 * 좌표계: 한쪽 페이지(w x h) 기준, 제본선(spine)이 x=0, 바깥쪽 모서리가 x=w.
 * - g: 사용자가 잡은 지점(원래 위치)
 * - m: 그 지점이 현재 끌려온 위치
 * 접히는 선은 g 와 m 의 수직이등분선이고, g 쪽 영역이 선을 기준으로 반사되어 뒷면으로 보인다.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface CurlGeometry {
  /** 접히지 않고 앞면이 그대로 보이는 영역 */
  flat: Pt[];
  /** 접혀서 들려 올라가는 영역(반사 전, 페이지 좌표) */
  flap: Pt[];
  /** 접힘선 위의 한 점 */
  q: Pt;
  /** g 에서 m 쪽을 향하는 반대 방향 단위벡터 (g 쪽을 가리킴) */
  n: Pt;
  /** 반사 행렬 matrix(a,b,c,d,e,f) */
  matrix: string;
  /** 접힘선 방향 각도(rad) */
  angle: number;
}

/** 접힘 정도(0~1). 1이면 완전히 넘어간 상태 */
export function curlProgress(m: Pt, w: number): number {
  return Math.max(0, Math.min(1, (w - m.x) / (2 * w)));
}

/** 페이지가 종이처럼 늘어나지 않도록, 끌려온 점을 제본선 양 끝점으로부터의 거리 안으로 제한 */
export function clampCurlPoint(m: Pt, g: Pt, w: number, h: number): Pt {
  const spine: Pt[] = [
    { x: 0, y: 0 },
    { x: 0, y: h }
  ];
  const radii = spine.map((s) => Math.hypot(g.x - s.x, g.y - s.y));
  let p: Pt = { x: m.x, y: Math.max(-h * 0.12, Math.min(h * 1.12, m.y)) };
  for (let i = 0; i < 8; i++) {
    for (let k = 0; k < 2; k++) {
      const dx = p.x - spine[k].x;
      const dy = p.y - spine[k].y;
      const d = Math.hypot(dx, dy);
      const r = radii[k] * 0.9995;
      if (d > r) p = { x: spine[k].x + (dx / d) * r, y: spine[k].y + (dy / d) * r };
    }
  }
  return { x: Math.min(p.x, w), y: p.y };
}

function clipHalfPlane(poly: Pt[], q: Pt, n: Pt, sign: 1 | -1): Pt[] {
  const f = (p: Pt) => sign * ((p.x - q.x) * n.x + (p.y - q.y) * n.y);
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0 && fb < 0) || (fa < 0 && fb >= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export function computeCurl(g: Pt, m: Pt, w: number, h: number): CurlGeometry | null {
  const dx = g.x - m.x;
  const dy = g.y - m.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.75) return null;

  const n: Pt = { x: dx / dist, y: dy / dist };
  const q: Pt = { x: (g.x + m.x) / 2, y: (g.y + m.y) / 2 };
  const rect: Pt[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ];

  const flat = clipHalfPlane(rect, q, n, -1);
  const flap = clipHalfPlane(rect, q, n, 1);

  const qn = q.x * n.x + q.y * n.y;
  const a = 1 - 2 * n.x * n.x;
  const b = -2 * n.x * n.y;
  const d = 1 - 2 * n.y * n.y;
  const e = 2 * qn * n.x;
  const f = 2 * qn * n.y;

  return {
    flat,
    flap,
    q,
    n,
    matrix: `matrix(${a}, ${b}, ${b}, ${d}, ${e}, ${f})`,
    angle: Math.atan2(n.x, -n.y)
  };
}

export function polygonCss(poly: Pt[]): string {
  if (poly.length < 3) return 'polygon(0px 0px, 0px 0px, 0px 0px)';
  return `polygon(${poly.map((p) => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`).join(', ')})`;
}
