import React from 'react';
import { computeCurl, polygonCss, type Pt } from './pageCurl';

interface PageCurlProps {
  side: 'left' | 'right';
  w: number;
  h: number;
  g: Pt;
  m: Pt;
  /** 넘어가는 페이지의 앞면 이미지 스타일 */
  front: React.CSSProperties;
  /** 넘어간 뒤 보이는 뒷면 이미지 스타일 */
  back: React.CSSProperties;
  rounded?: boolean;
}

const PAPER = '#f8f8f5';
const SHADE_LEN = 150;
const REVEAL_SHADE_LEN = 110;

/**
 * 포인터를 따라 접히는 페이지.
 * 한쪽 페이지 크기(w x h)의 영역에 그리며, 왼쪽 페이지는 좌우를 뒤집은 좌표계로 계산한다.
 */
export default function PageCurl({ side, w, h, g, m, front, back, rounded = true }: PageCurlProps) {
  const mirrored = side === 'left';
  const geo = computeCurl(g, m, w, h);

  const fill: React.CSSProperties = { position: 'absolute', inset: 0 };
  const frontLayer = (
    <div
      style={{
        ...fill,
        backgroundColor: PAPER,
        borderRadius: !rounded ? 0 : mirrored ? '10px 0 0 10px' : '0 10px 10px 0',
        transform: mirrored ? 'scaleX(-1)' : undefined
      }}
    >
      <div className="w-full h-full bg-no-repeat" style={front} />
    </div>
  );

  const strip = (len: number, below: boolean, background: string): React.CSSProperties => ({
    position: 'absolute',
    left: 0,
    top: 0,
    width: (w + h) * 2,
    height: len,
    transformOrigin: '0 0',
    transform: geo
      ? `translate(${geo.q.x}px, ${geo.q.y}px) rotate(${geo.angle}rad) translate(${-(w + h)}px, ${
          below ? 0 : -len
        }px)`
      : undefined,
    background,
    pointerEvents: 'none'
  });

  return (
    <div
      className="curl-root"
      style={{
        position: 'absolute',
        top: 0,
        left: mirrored ? 0 : w,
        width: w,
        height: h,
        zIndex: 30,
        pointerEvents: 'none',
        transform: mirrored ? 'scaleX(-1)' : undefined
      }}
    >
      {!geo ? (
        frontLayer
      ) : (
        <>
          {/* 접히면서 드러난 아래쪽 페이지에 드리우는 그림자 */}
          <div style={{ ...fill, clipPath: polygonCss(geo.flap) }}>
            <div
              style={strip(
                REVEAL_SHADE_LEN,
                false,
                'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.12) 55%, rgba(0,0,0,0.42) 100%)'
              )}
            />
          </div>

          {/* 접히지 않은 앞면 */}
          <div style={{ ...fill, clipPath: polygonCss(geo.flat) }}>{frontLayer}</div>

          {/* 접혀 올라온 뒷면 */}
          <div
            style={{
              ...fill,
              filter: 'drop-shadow(0px 6px 9px rgba(0,0,0,0.5))'
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: w,
                height: h,
                transformOrigin: '0 0',
                transform: geo.matrix,
                clipPath: polygonCss(geo.flap),
                backgroundColor: PAPER
              }}
            >
              <div
                style={{
                  ...fill,
                  transform: mirrored ? undefined : 'scaleX(-1)'
                }}
              >
                <div className="w-full h-full bg-no-repeat" style={back} />
              </div>
              {/* 종이가 말려 올라가는 느낌의 음영 */}
              <div
                style={strip(
                  SHADE_LEN,
                  false,
                  'linear-gradient(to top, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.14) 30%, rgba(255,255,255,0.10) 62%, rgba(0,0,0,0) 100%)'
                )}
              />
              <div style={{ ...fill, background: 'rgba(0,0,0,0.05)' }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
