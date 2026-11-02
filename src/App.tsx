
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Columns,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Maximize2,
  Minimize2,
  ArrowLeftRight,
  FileArchive,
  Menu,
  X,
  Volume2,
  VolumeX,
} from 'lucide-react';
import * as fflate from 'fflate';
import PageCurl from './PageCurlComponent';
import { clampCurlPoint, curlProgress, type Pt } from './pageCurl';
import {
  supportsDirPicker,
  pickLibraryDir,
  listArchives,
  getArchiveFile,
  type LibraryDirHandle,
} from './library';

// --- 타입 정의 ---
export interface RawImageFile {
  name: string;
  url: string;
  w?: number;
  h?: number;
  aspect?: number;
}

export type SliceType = 'left-half' | 'right-half' | 'full';

export interface HalfDescriptor {
  url: string;
  slice: SliceType;
  label: string;
}

export interface SpreadPage {
  title: string;
  left: HalfDescriptor;
  right: HalfDescriptor;
  thumbUrl: string;
  aspect: number;
  isSingle?: boolean;
  rawIndex: number;
  sliceIndex?: number;
}

export type ReadingDirection = 'rtl' | 'ltr';
export type ViewMode = 'spread' | 'split' | 'pair';
export type TapAction = 'page' | 'menu';

export interface ShelfSeries {
  id: string;
  title: string;
  volumes: string[];
  lastVolume?: string;
  hasDirHandle?: boolean;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  vx: number;
  scale: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  gy: number;
  moved: boolean;
  atEndNext?: boolean;
}

interface CurlState {
  side: 'left' | 'right';
  nextIdx: number;
  w: number;
  h: number;
  g: Pt;
  m: Pt;
}

// --- 이미지 바이너리 헤더 파서 (PNG, JPEG, WebP, GIF 실시간 규격 감지) ---
function parseImageSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (!bytes || bytes.length < 24) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const h = view.getUint16(offset + 3);
        const w = view.getUint16(offset + 5);
        return { w, h };
      }
      if (offset + 2 > bytes.length) break;
      const len = view.getUint16(offset);
      offset += len;
    }
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: view.getUint16(6, true), h: view.getUint16(8, true) };
  }
  // WebP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      return { w: bytes[26] | (bytes[27] << 8), h: bytes[28] | (bytes[29] << 8) };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23];
      const w = 1 + (((b2 & 0x3f) << 8) | b1);
      const h = 1 + (((bytes[24] & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { w, h };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { w, h };
    }
  }
  return null;
}

const IMAGE_EXT_REGEX = /\.(jpe?g|png|webp|avif|gif)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// --- IndexedDB 영구 저장 유틸리티 (앱 종료 후에도 책 파일 유지) ---
const DB_NAME = 'FoldBookStorage';
const DB_VERSION = 1;
const STORE_NAME = 'saved_book';

function openFoldBookDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistBookArchive(file: Blob, name: string) {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(file, 'current_archive_blob');
    store.put(name, 'current_archive_name');
    store.delete('current_images_list');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
  } catch (err) {
    console.warn('아카이브 IndexedDB 저장 실패:', err);
  }
}

async function persistImagesList(files: { name: string; blob: Blob }[], bookTitle: string) {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(files, 'current_images_list');
    store.put(bookTitle, 'current_archive_name');
    store.delete('current_archive_blob');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
  } catch (err) {
    console.warn('이미지 목록 IndexedDB 저장 실패:', err);
  }
}

async function saveSeriesDirHandle(seriesId: string, handle: any) {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(handle, 'shelf_dir_' + seriesId);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
  } catch (e) {
    console.warn('시리즈 핸들 저장 실패:', e);
  }
}

async function getSeriesDirHandle(seriesId: string): Promise<any> {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get('shelf_dir_' + seriesId);
    await new Promise((res) => { tx.oncomplete = res; });
    return req.result || null;
  } catch {
    return null;
  }
}

async function persistAllZipArchives(files: { name: string; blob: Blob }[]) {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(files, 'all_zip_archives');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
  } catch (err) {
    console.warn('전체 ZIP 목록 IndexedDB 저장 실패:', err);
  }
}

// --- 이미지 종횡비 기반 가변 스마트 스프레드 생성 함수 (모드 전환 시 위치 보존용) ---
function buildSpreadsList(
  rawFiles: RawImageFile[],
  viewMode: ViewMode,
  readingDirection: ReadingDirection
): SpreadPage[] {
  if (rawFiles.length === 0) return [];
  const list: SpreadPage[] = [];
  const isSpreadImage = (f: RawImageFile) => (f.aspect ? f.aspect >= 1.05 : false);

  if (viewMode === 'split') {
    rawFiles.forEach((f, idx) => {
      if (isSpreadImage(f)) {
        const firstSlice: SliceType = readingDirection === 'rtl' ? 'right-half' : 'left-half';
        const secondSlice: SliceType = readingDirection === 'rtl' ? 'left-half' : 'right-half';

        list.push({
          title: f.name + ' (1/2)',
          left: { url: f.url, slice: firstSlice, label: String(idx + 1) + '-1' },
          right: { url: f.url, slice: firstSlice, label: String(idx + 1) + '-1' },
          thumbUrl: f.url,
          aspect: (f.aspect || 1.4) / 2,
          isSingle: true,
          rawIndex: idx,
          sliceIndex: 0,
        });

        list.push({
          title: f.name + ' (2/2)',
          left: { url: f.url, slice: secondSlice, label: String(idx + 1) + '-2' },
          right: { url: f.url, slice: secondSlice, label: String(idx + 1) + '-2' },
          thumbUrl: f.url,
          aspect: (f.aspect || 1.4) / 2,
          isSingle: true,
          rawIndex: idx,
          sliceIndex: 1,
        });
      } else {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'full', label: String(idx + 1) },
          right: { url: f.url, slice: 'full', label: String(idx + 1) },
          thumbUrl: f.url,
          aspect: f.aspect || 0.7,
          isSingle: true,
          rawIndex: idx,
          sliceIndex: 0,
        });
      }
    });
  } else {
    let i = 0;
    while (i < rawFiles.length) {
      const f = rawFiles[i];
      if (isSpreadImage(f)) {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'left-half', label: String(i + 1) + 'L' },
          right: { url: f.url, slice: 'right-half', label: String(i + 1) + 'R' },
          thumbUrl: f.url,
          aspect: f.aspect || 1.414,
          isSingle: false,
          rawIndex: i,
          sliceIndex: 0,
        });
        i++;
      } else {
        const next = rawFiles[i + 1];
        if (i === 0 || !next || isSpreadImage(next)) {
          list.push({
            title: f.name,
            left: { url: f.url, slice: 'full', label: String(i + 1) },
            right: { url: f.url, slice: 'full', label: String(i + 1) },
            thumbUrl: f.url,
            aspect: f.aspect || 0.7,
            isSingle: true,
            rawIndex: i,
            sliceIndex: 0,
          });
          i++;
        } else {
          const f1 = f;
          const f2 = next;
          const leftFile = readingDirection === 'rtl' ? f2 : f1;
          const rightFile = readingDirection === 'rtl' ? f1 : f2;
          list.push({
            title: f1.name + ' + ' + f2.name,
            left: { url: leftFile.url, slice: 'full', label: leftFile.name },
            right: { url: rightFile.url, slice: 'full', label: rightFile.name },
            thumbUrl: f1.url,
            aspect: ((f1.aspect || 0.7) + (f2.aspect || 0.7)),
            isSingle: false,
            rawIndex: i,
            sliceIndex: 0,
          });
          i += 2;
        }
      }
    }
  }

  return list;
}

export default function App() {
  // --- 상태 관리 ---
  const [rawFiles, setRawFiles] = useState<RawImageFile[]>([]);
  // --- 시리즈별 + 권별 2단계 계층형 100% 독립 독서 진행도 (v4 스토리지) ---
  const saveBookProgress = useCallback((seriesId: string, volName: string, rawIdx: number, pageIdx: number) => {
    if (!seriesId || !volName || seriesId === 'FoldBook 뷰어') return;
    try {
      const data = JSON.parse(localStorage.getItem('foldbook_series_progress_v4') || '{}');
      if (!data[seriesId]) data[seriesId] = {};
      data[seriesId][volName] = { rawIndex: rawIdx, pageIndex: pageIdx };
      localStorage.setItem('foldbook_series_progress_v4', JSON.stringify(data));
    } catch {}
  }, []);

  const getBookProgress = useCallback((seriesId: string, volName: string): { rawIndex: number; pageIndex: number } | null => {
    if (!seriesId || !volName) return null;
    try {
      const data = JSON.parse(localStorage.getItem('foldbook_series_progress_v4') || '{}');
      return data[seriesId]?.[volName] || null;
    } catch {
      return null;
    }
  }, []);

  const [bookTitle, setBookTitle] = useState<string>(() => {
    return localStorage.getItem('foldbook_last_book') || 'FoldBook 뷰어';
  });

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('foldbook_view_mode') as ViewMode) || 'spread';
  });

  const [readingDirection, setReadingDirection] = useState<ReadingDirection>(() => {
    return (localStorage.getItem('foldbook_reading_dir') as ReadingDirection) || 'rtl';
  });

  const [currentIndex, setCurrentIndex] = useState<number>(0);

  // 책 전환 시 저장된 독서 위치 적용 (없으면 0번째 첫 페이지, 다른 책 진행도 오염 원천 차단)
  const applyBookProgress = useCallback((seriesId: string, volName: string, spreads: SpreadPage[]) => {
    if (spreads.length === 0) {
      setCurrentIndex(0);
      return;
    }
    const saved = getBookProgress(seriesId, volName);
    if (saved) {
      const matchIdx = spreads.findIndex((s) => s.rawIndex === saved.rawIndex);
      if (matchIdx !== -1) {
        setCurrentIndex(matchIdx);
        return;
      }
      if (saved.pageIndex >= 0 && saved.pageIndex < spreads.length && saved.rawIndex < spreads.length) {
        setCurrentIndex(saved.pageIndex);
        return;
      }
    }
    // 본 적이 없는 새 권/새 시리즈: 무조건 첫 페이지(0p)
    setCurrentIndex(0);
  }, [getBookProgress]);


  const pages = useMemo<SpreadPage[]>(() => {
    return buildSpreadsList(rawFiles, viewMode, readingDirection);
  }, [rawFiles, viewMode, readingDirection]);

  // 페이지 인덱스 안전 범위 보정 (인덱스 초과 방지)
  useEffect(() => {
    if (pages.length > 0 && currentIndex >= pages.length) {
      setCurrentIndex(pages.length - 1);
    }
  }, [pages.length, currentIndex]);


  // 제본선 디폴트 OFF
  const [creaseEnabled, setCreaseEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('foldbook_crease');
    return saved !== null ? saved === 'true' : false;
  });

  // 사운드 토글
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('foldbook_sound');
    return saved !== null ? saved === 'true' : true;
  });

  // 화면 단순 탭 동작 (페이지 넘김 vs 전체화면 메뉴 토글)
  const [tapAction, setTapAction] = useState<TapAction>(() => {
    return (localStorage.getItem('foldbook_tap_action') as TapAction) || 'page';
  });
  const [showImmersiveControls, setShowImmersiveControls] = useState<boolean>(false);

  const [dirHandle, setDirHandle] = useState<LibraryDirHandle | null>(null);
  const zipFilesMapRef = useRef<Map<string, File>>(new Map());
  const subDirsMapRef = useRef<Map<string, File[]>>(new Map());
  const subDirHandlesRef = useRef<Map<string, any>>(new Map());
  const allSeriesSubDirsMapRef = useRef<Map<string, Map<string, File[]>>>(new Map());
  const [seriesList, setSeriesList] = useState<ShelfSeries[]>(() => {
    try {
      const saved = localStorage.getItem('foldbook_series_shelf');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [currentSeriesId, setCurrentSeriesId] = useState<string | null>(() => {
    return localStorage.getItem('foldbook_current_series_id') || null;
  });
  const currentSeriesIdRef = useRef<string | null>(localStorage.getItem('foldbook_current_series_id') || null);
  const isTransitioningRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [archives, setArchives] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('foldbook_archive_list');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [currentArchiveName, setCurrentArchiveName] = useState<string | null>(() => {
    return localStorage.getItem('foldbook_last_archive') || null;
  });
  const [showDrawer, setShowDrawer] = useState<boolean>(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState<boolean>(false);

  const [immersive, setImmersive] = useState<boolean>(false);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const [curl, setCurl] = useState<CurlState | null>(null);

  // Refs
  const chassisRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const animatingRef = useRef<boolean>(false);
  const goNextBookRef = useRef<() => void>(() => {});
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainLastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const activeBookKeyRef = useRef<string | null>(null);

  // --- 상태 변경 시 LocalStorage 자동 저장 ---
  useEffect(() => {
    localStorage.setItem('foldbook_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('foldbook_reading_dir', readingDirection);
  }, [readingDirection]);

  useEffect(() => {
    localStorage.setItem('foldbook_crease', String(creaseEnabled));
  }, [creaseEnabled]);

  useEffect(() => {
    localStorage.setItem('foldbook_sound', String(soundEnabled));
  }, [soundEnabled]);

  useEffect(() => {
    localStorage.setItem('foldbook_tap_action', tapAction);
  }, [tapAction]);

  useEffect(() => {
    if (currentSeriesId && currentArchiveName) {
      setSeriesList((prev) => {
        const idx = prev.findIndex((s) => s.id === currentSeriesId);
        if (idx !== -1 && prev[idx].lastVolume !== currentArchiveName) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], lastVolume: currentArchiveName };
          localStorage.setItem('foldbook_series_shelf', JSON.stringify(updated));
          return updated;
        }
        return prev;
      });
    }
  }, [currentSeriesId, currentArchiveName]);

  useEffect(() => {
    // 만화책/시리즈 전환 도중에는 절대 이전 위치를 새 책에 덮어쓰지 않음
    if (isTransitioningRef.current) return;

    const seriesId = currentSeriesIdRef.current || currentSeriesId;
    const volName = currentArchiveName || (bookTitle !== 'FoldBook 뷰어' ? bookTitle : null);
    if (!seriesId || !volName) return;

    if (bookTitle) localStorage.setItem('foldbook_last_book', bookTitle);
    if (currentArchiveName) localStorage.setItem('foldbook_last_archive', currentArchiveName);

    if (pages.length > 0 && pages[currentIndex]) {
      saveBookProgress(seriesId, volName, pages[currentIndex].rawIndex, currentIndex);
    }
  }, [bookTitle, currentArchiveName, currentSeriesId, currentIndex, pages, saveBookProgress]);

  // --- 리얼 책장 넘김 사운드 합성 (Web Audio API) ---
  const playPageSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const duration = 0.22;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
      const data = buffer.getChannelData(0);

      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.0555179;
        b1 = 0.96300 * b1 + white * 0.0750759;
        b2 = 0.57000 * b2 + white * 0.1538520;
        const pink = b0 + b1 + b2 + white * 0.5362;
        const env = Math.sin(t * Math.PI) * Math.pow(1 - t, 0.7);
        data[i] = pink * env * 0.38;
      }

      const noiseNode = ctx.createBufferSource();
      noiseNode.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1450, ctx.currentTime);
      filter.Q.setValueAtTime(1.1, ctx.currentTime);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.55, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

      noiseNode.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      noiseNode.start();
    } catch {
      // AudioContext safe catch
    }
  }, [soundEnabled]);

  // --- 보기 모드 전환 핸들러 (분할 <-> 양면 전환 시 현재 읽던 페이지 위치 정밀 유지) ---
  const handleToggleViewMode = useCallback(() => {
    if (pages.length === 0) {
      setViewMode((m) => (m === 'spread' ? 'split' : 'spread'));
      return;
    }
    const current = pages[currentIndex];
    const currentRawIdx = current?.rawIndex ?? 0;
    const currentSliceIdx = current?.sliceIndex ?? 0;

    const nextMode: ViewMode = viewMode === 'spread' ? 'split' : 'spread';
    const targetSpreads = buildSpreadsList(rawFiles, nextMode, readingDirection);

    let matchIdx = targetSpreads.findIndex((s) => {
      if (nextMode === 'split') {
        return s.rawIndex === currentRawIdx && (s.sliceIndex ?? 0) === currentSliceIdx;
      }
      return s.rawIndex === currentRawIdx;
    });

    if (matchIdx === -1) {
      matchIdx = targetSpreads.findIndex((s) => s.rawIndex >= currentRawIdx);
      if (matchIdx === -1) matchIdx = Math.max(0, targetSpreads.length - 1);
    }

    setViewMode(nextMode);
    setCurrentIndex(matchIdx);
  }, [pages, currentIndex, viewMode, rawFiles, readingDirection]);

  // --- 브라우저 OS 알림바 숨김 & 전체화면 토글 (HTML5 Fullscreen API) ---
  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      try {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } catch (e) {
        console.warn('전체화면 요청 실패:', e);
      }
      setImmersive(true);
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      } catch (e) {
        console.warn('전체화면 해제 실패:', e);
      }
      setImmersive(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      setImmersive(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, []);

  // --- 컨테이너 반응형 리사이즈 감지 ---
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          w: entry.contentRect.width,
          h: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // --- 이미지 해상도 감지 (종횡비 계산용) ---
  useEffect(() => {
    if (rawFiles.length === 0) {
      setImgSize(null);
      return;
    }
    const sampleImg = new Image();
    sampleImg.src = rawFiles[0].url;
    sampleImg.onload = () => {
      setImgSize({ w: sampleImg.naturalWidth, h: sampleImg.naturalHeight });
    };
  }, [rawFiles]);

  // --- 페이지 구성 생성 (useMemo) ---
    // --- 슬라이스 스타일 계산 헬퍼 ---
  const getSliceStyle = useCallback((desc?: HalfDescriptor): React.CSSProperties => {
    if (!desc) return {};
    if (desc.slice === 'left-half') {
      return {
        backgroundImage: 'url(' + desc.url + ')',
        backgroundSize: '200% 100%',
        backgroundPosition: '0% center',
      };
    }
    if (desc.slice === 'right-half') {
      return {
        backgroundImage: 'url(' + desc.url + ')',
        backgroundSize: '200% 100%',
        backgroundPosition: '100% center',
      };
    }
    return {
      backgroundImage: 'url(' + desc.url + ')',
      backgroundSize: 'contain',
      backgroundPosition: 'center center',
    };
  }, []);

  // --- 현재 페이지(스프레드) 종횡비에 실시간 맞춤 가변 섀시 크기 계산 ---
  const currentSpread = pages[currentIndex];
  const isDisplaySingle = viewMode === 'split' || !!currentSpread?.isSingle;

  const { chassisW, chassisH } = useMemo(() => {
    // 현재 보고 있는 페이지 고유 종횡비 사용 (단면 표지면 세로형, 2페이지면 가로형 자동 가변)
    const targetAspect = currentSpread?.aspect || (viewMode === 'split' ? 0.7 : 1.414);

    const availableW = containerSize.w * (immersive ? 1.0 : 0.96);
    const availableH = containerSize.h * (immersive ? 1.0 : 0.94);

    let w = availableW;
    let h = w / targetAspect;

    if (h > availableH) {
      h = availableH;
      w = h * targetAspect;
    }

    return { chassisW: Math.round(w), chassisH: Math.round(h) };
  }, [currentSpread, viewMode, containerSize, immersive]);

  // --- 다음 권 존재 여부 확인 ---
  const hasNextBook = useMemo(() => {
    if (!currentArchiveName || archives.length === 0) return false;
    const currentIdx = archives.indexOf(currentArchiveName);
    return currentIdx !== -1 && currentIdx + 1 < archives.length;
  }, [currentArchiveName, archives]);

  // --- 시리즈(서재) 등록 및 관리 ---
  const registerSeries = useCallback((id: string, title: string, volumes: string[], hasDirHandle = false) => {
    setSeriesList((prev) => {
      const existingIdx = prev.findIndex((s) => s.id === id);
      const item: ShelfSeries = {
        id,
        title,
        volumes,
        hasDirHandle,
        lastVolume: prev[existingIdx]?.lastVolume || volumes[0],
      };
      let updated: ShelfSeries[];
      if (existingIdx !== -1) {
        updated = [...prev];
        updated[existingIdx] = { ...updated[existingIdx], ...item };
      } else {
        updated = [item, ...prev];
      }
      localStorage.setItem('foldbook_series_shelf', JSON.stringify(updated));
      return updated;
    });
    currentSeriesIdRef.current = id;
    setCurrentSeriesId(id);
    localStorage.setItem('foldbook_current_series_id', id);
  }, []);

  // --- ZIP/CBZ 압축 해제 및 이미지 로드 (IndexedDB 영구 저장 연동) ---
  const loadZipFile = async (file: File | Blob, customTitle?: string, targetSeriesId?: string) => {
    const fileName = customTitle || ('name' in file ? file.name : (currentArchiveName || '단행본.zip'));
    const title = fileName.replace(/\.(zip|cbz)$/i, '');
    
    // 영구 저장소(IndexedDB)에 활성 책 보관
    persistBookArchive(file, fileName);

    const arrayBuffer = await file.arrayBuffer();
    const unzipped = await new Promise<{ [key: string]: Uint8Array }>((resolve, reject) => {
      fflate.unzip(new Uint8Array(arrayBuffer), (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const fileEntries = Object.keys(unzipped)
      .filter((name) => IMAGE_EXT_REGEX.test(name) && !name.startsWith('__MACOSX'))
      .sort((a, b) => collator.compare(a, b));

    const loadedFiles: RawImageFile[] = fileEntries.map((name) => {
      const bytes = unzipped[name];
      const ext = name.split('.').pop()?.toLowerCase() || 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = new Blob([bytes], { type: mime });
      const size = parseImageSize(bytes);
      const w = size?.w || 1000;
      const h = size?.h || 700;
      return {
        name,
        url: URL.createObjectURL(blob),
        w,
        h,
        aspect: w / h,
      };
    });

    // 이전 URL 해제
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
    setRawFiles(loadedFiles);

    // 새 도서 상태 및 시리즈::권 고유 키 동기화 (계층형 격리)
    const seriesId = targetSeriesId || currentSeriesIdRef.current || currentSeriesId || title;
    currentSeriesIdRef.current = seriesId;
    activeBookKeyRef.current = fileName;
    setBookTitle(title);
    setCurrentArchiveName(fileName);
    localStorage.setItem('foldbook_last_archive', fileName);

    // 책별 보관된 마지막 독서 위치 조회 및 복원 (시리즈+권 기준, 없으면 0p)
    const targetSpreads = buildSpreadsList(loadedFiles, viewMode, readingDirection);
    applyBookProgress(seriesId, fileName, targetSpreads);
    isTransitioningRef.current = false;
  };

  // 일반 이미지 다중/폴더 고속 로딩 (초경량 헤더 파싱 & 백그라운드 캐시로 즉시 표시)
  const handleMultipleImageFiles = async (
    files: FileList | File[],
    customTitle?: string,
    targetSeriesId?: string
  ) => {
    const valid = Array.from(files)
      .filter((f) => IMAGE_EXT_REGEX.test(f.name))
      .sort((a, b) => {
        const pathA = (a as any).webkitRelativePath || a.name;
        const pathB = (b as any).webkitRelativePath || b.name;
        return collator.compare(pathA, pathB);
      });

    if (valid.length === 0) return;

    const relPath = (valid[0] as any).webkitRelativePath as string | undefined;
    const folderName = relPath && relPath.includes('/') ? relPath.split('/')[0] : undefined;
    const title = customTitle || folderName || valid[0]?.name.split('.')[0] || '만화책 폴더';

    // 이전 URL 해제
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));

    // 초고속 로딩: 첫 6장만 헤더 즉시 파싱 (5ms 완료), 나머지는 기본 세로 비율(0.7)로 즉시 화면 오픈
    const headLimit = Math.min(6, valid.length);
    const parsedHeadSizes = await Promise.all(
      valid.slice(0, headLimit).map(async (f) => {
        try {
          const headerBytes = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
          return parseImageSize(headerBytes);
        } catch {
          return null;
        }
      })
    );

    const loaded: RawImageFile[] = valid.map((f, i) => {
      let w = 1000;
      let h = 1428;
      if (i < headLimit && parsedHeadSizes[i]) {
        w = parsedHeadSizes[i]!.w;
        h = parsedHeadSizes[i]!.h;
      }
      return {
        name: f.name,
        url: URL.createObjectURL(f),
        w,
        h,
        aspect: w / h,
      };
    });

    // 백그라운드 IndexedDB 캐싱 (메인 스레드 렌더링 블로킹 차단)
    setTimeout(() => {
      try {
        const persistItems = valid.map((f) => ({ name: f.name, blob: f }));
        persistImagesList(persistItems, title);
      } catch {}
    }, 1500);

    setRawFiles(loaded);

    // 새 도서 상태 및 시리즈::권 고유 키 동기화 (계층형 격리)
    const seriesId = targetSeriesId || currentSeriesIdRef.current || currentSeriesId || folderName || title;
    currentSeriesIdRef.current = seriesId;
    activeBookKeyRef.current = title;
    setBookTitle(title);
    setCurrentArchiveName(title);
    localStorage.setItem('foldbook_last_archive', title);

    // 시리즈별::권별 보관된 마지막 독서 위치 복원 (시리즈+권 기준, 없으면 0p)
    const targetSpreads = buildSpreadsList(loaded, viewMode, readingDirection);
    applyBookProgress(seriesId, title, targetSpreads);
    isTransitioningRef.current = false;

    // 첫 페이지 이미지 사전 디코딩 (백지 지연 제거)
    if (loaded.length > 0) {
      const preloadImg = new Image();
      preloadImg.src = loaded[0].url;
    }
  };

  // --- 다음 권 불러오기 로직 연결 (DirectoryHandle, 하위 폴더 메모리 맵 및 ZIP 지원) ---
  const loadArchiveByIndex = useCallback(
    async (nextArchiveName: string) => {
      try {
        const seriesId = currentSeriesIdRef.current || currentSeriesId || 'FoldBook 뷰어';

        // A. FileSystemDirectoryHandle 하위 권 폴더가 있는 경우 (온디맨드 0.1초 로드)
        if (subDirHandlesRef.current.has(nextArchiveName)) {
          const targetHandle = subDirHandlesRef.current.get(nextArchiveName)!;
          const volFiles: File[] = [];
          for await (const [subFileName, subFileEntry] of (targetHandle as any).entries()) {
            if (subFileEntry.kind === 'file' && IMAGE_EXT_REGEX.test(subFileName)) {
              volFiles.push(await (subFileEntry as FileSystemFileHandle).getFile());
            }
          }
          volFiles.sort((a, b) => collator.compare(a.name, b.name));
          await handleMultipleImageFiles(volFiles, nextArchiveName, seriesId);
          setCurrentArchiveName(nextArchiveName);
          localStorage.setItem('foldbook_last_archive', nextArchiveName);
          return;
        }

        // B. subDirsMapRef (메모리)에 있는 경우
        if (subDirsMapRef.current.has(nextArchiveName)) {
          const imgs = subDirsMapRef.current.get(nextArchiveName)!;
          await handleMultipleImageFiles(imgs, nextArchiveName, seriesId);
          setCurrentArchiveName(nextArchiveName);
          localStorage.setItem('foldbook_last_archive', nextArchiveName);
          return;
        }

        // C. zipFilesMapRef 또는 dirHandle ZIP 파일인 경우
        let file: File | Blob | null = null;
        if (zipFilesMapRef.current.has(nextArchiveName)) {
          file = zipFilesMapRef.current.get(nextArchiveName)!;
        } else if (dirHandle) {
          file = await getArchiveFile(dirHandle, nextArchiveName);
        }
        if (file) {
          await loadZipFile(file, nextArchiveName, seriesId);
          setCurrentArchiveName(nextArchiveName);
          localStorage.setItem('foldbook_last_archive', nextArchiveName);
          return;
        }

        alert("도서 파일을 찾을 수 없습니다. 서재에서 도서 폴더를 다시 열어주세요.");
        setShowDrawer(true);
      } catch (err) {
        console.error('다음 권 로드 실패:', err);
      }
    },
    [dirHandle, applyBookProgress, viewMode, readingDirection]
  );

  useEffect(() => {
    goNextBookRef.current = () => {
      if (!currentArchiveName || archives.length === 0) return;
      const currentIdx = archives.indexOf(currentArchiveName);
      if (currentIdx !== -1 && currentIdx + 1 < archives.length) {
        const nextName = archives[currentIdx + 1];
        loadArchiveByIndex(nextName);
      }
    };
  }, [currentArchiveName, archives, loadArchiveByIndex]);

  // --- 이미지들이 담긴 폴더 선택 이벤트 핸들러 (웹킷 디렉터리 완벽 지원) ---
  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    // 0. 이전 만화책 상태 완전 클리어 (이전 책 잔여물 완벽 차단)
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
    setRawFiles([]);
    setCurrentIndex(0);
    setCurl(null);
    animatingRef.current = false;

    // 1. 폴더 안에 ZIP/CBZ 압축 파일들이 담겨 있는 경우
    const zips = fileList
      .filter((f) => /\.(zip|cbz)$/i.test(f.name))
      .sort((a, b) => collator.compare(a.name, b.name));

    if (zips.length > 0) {
      const map = new Map<string, File>();
      const persistItems: { name: string; blob: Blob }[] = [];
      zips.forEach((f) => {
        map.set(f.name, f);
        persistItems.push({ name: f.name, blob: f });
      });
      zipFilesMapRef.current = map;
      persistAllZipArchives(persistItems);
      const names = zips.map((f) => f.name);
      setArchives(names);
      localStorage.setItem('foldbook_archive_list', JSON.stringify(names));

      const firstRel = (zips[0] as any).webkitRelativePath as string | undefined;
      const seriesTitle = firstRel && firstRel.includes('/') ? firstRel.split('/')[0] : '압축 도서 모음';
      registerSeries(seriesTitle, seriesTitle, names, false);

      await loadZipFile(zips[0], zips[0].name, seriesTitle);
      setCurrentArchiveName(zips[0].name);
      localStorage.setItem('foldbook_last_archive', zips[0].name);
      if (zips.length > 1) setShowDrawer(true);
      e.target.value = '';
      return;
    }

    // 2. 폴더 안에 이미지 파일들이 담겨 있는 경우
    const images = fileList.filter((f) => IMAGE_EXT_REGEX.test(f.name));
    if (images.length === 0) {
      alert('선택한 폴더 안에 이미지 파일(JPG, PNG, WEBP 등)이나 ZIP 파일이 없습니다.');
      e.target.value = '';
      return;
    }

    // 하위 폴더별(만화책A/1권, 만화책A/2권 등) 분기 감지
    const hasSubfolders = images.some((f) => {
      const p = ((f as any).webkitRelativePath || f.name).split('/');
      return p.length >= 3;
    });

    const subDirMap = new Map<string, File[]>();
    const rootImages: File[] = [];

    for (const f of images) {
      const rel = (f as any).webkitRelativePath as string | undefined;
      if (rel && rel.includes('/')) {
        const parts = rel.split('/');
        if (hasSubfolders) {
          if (parts.length >= 3) {
            const subName = parts[1];
            if (!subDirMap.has(subName)) subDirMap.set(subName, []);
            subDirMap.get(subName)!.push(f);
          } else {
            rootImages.push(f);
          }
        } else {
          if (parts.length === 2) {
            const subName = parts[0];
            if (!subDirMap.has(subName)) subDirMap.set(subName, []);
            subDirMap.get(subName)!.push(f);
          } else {
            rootImages.push(f);
          }
        }
      } else {
        rootImages.push(f);
      }
    }

    // 최상위에 단독 표지 이미지(cover.jpg 등)가 있고 하위 권들이 있는 경우 첫 권 앞에 포함
    if (rootImages.length > 0 && subDirMap.size > 0) {
      const sortedKeys = Array.from(subDirMap.keys()).sort((a, b) => collator.compare(a, b));
      subDirMap.get(sortedKeys[0])!.unshift(...rootImages);
    }

    const firstRel = (images[0] as any).webkitRelativePath as string | undefined;
    const seriesTitle = firstRel && firstRel.includes('/') ? firstRel.split('/')[0] : '만화책 폴더';

    if (subDirMap.size > 0) {
      // 1권 이상의 권별 하위 폴더가 감지된 경우: 도서 목록에 추가
      const subNames = Array.from(subDirMap.keys()).sort((a, b) => collator.compare(a, b));
      subDirsMapRef.current = subDirMap;
      allSeriesSubDirsMapRef.current.set(seriesTitle, subDirMap);
      setArchives(subNames);
      localStorage.setItem('foldbook_archive_list', JSON.stringify(subNames));

      registerSeries(seriesTitle, seriesTitle, subNames, false);

      const firstSub = subNames[0];
      const firstImgs = subDirMap.get(firstSub)!;
      await handleMultipleImageFiles(firstImgs, firstSub, seriesTitle);
      setCurrentArchiveName(firstSub);
      localStorage.setItem('foldbook_last_archive', firstSub);
      if (subNames.length > 1) setShowDrawer(true);
    } else {
      // 단일 이미지 폴더인 경우: 전체 이미지 즉시 로드
      registerSeries(seriesTitle, seriesTitle, [seriesTitle], false);
      await handleMultipleImageFiles(images, seriesTitle, seriesTitle);
      setCurrentArchiveName(seriesTitle);
      localStorage.setItem('foldbook_last_archive', seriesTitle);
    }

    e.target.value = '';
  };

  // --- 앱 시작 시 이전 독서 세션 자동 복원 (IndexedDB + LocalStorage) ---
  useEffect(() => {
    let isCancelled = false;
    async function restorePreviousReadingSession() {
      setIsLoadingSaved(true);
      try {
        const db = await openFoldBookDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const fileReq = store.get('current_archive_blob');
        const nameReq = store.get('current_archive_name');
        const imagesReq = store.get('current_images_list');
        const allZipsReq = store.get('all_zip_archives');

        await new Promise((res) => {
          tx.oncomplete = res;
        });

        if (allZipsReq.result && Array.isArray(allZipsReq.result)) {
          const zipMap = new Map<string, File>();
          (allZipsReq.result as { name: string; blob: Blob }[]).forEach((item) => {
            zipMap.set(item.name, new File([item.blob], item.name));
          });
          zipFilesMapRef.current = zipMap;
        }

        if (isCancelled) return;

        if (fileReq.result) {
          const blob = fileReq.result as Blob;
          const fileName = (nameReq.result as string) || '단행본.zip';
          const file = new File([blob], fileName);
          await loadZipFile(file, fileName, currentSeriesId || fileName);
        } else if (imagesReq.result && Array.isArray(imagesReq.result) && imagesReq.result.length > 0) {
          const imgItems = imagesReq.result as { name: string; blob: Blob }[];
          const title = (nameReq.result as string) || '단행본';
          activeBookKeyRef.current = title;
          setBookTitle(title);
          setCurrentArchiveName(title);
          const loaded: RawImageFile[] = imgItems.map((item) => ({
            name: item.name,
            url: URL.createObjectURL(item.blob),
          }));
          setRawFiles(loaded);
          const targetSpreads = buildSpreadsList(loaded, viewMode, readingDirection);
          applyBookProgress(currentSeriesId || title, title, targetSpreads);
        }
      } catch (err) {
        console.warn('이전 세션 복원 건너뜀:', err);
      } finally {
        if (!isCancelled) setIsLoadingSaved(false);
      }
    }

    restorePreviousReadingSession();
    return () => {
      isCancelled = true;
    };
  }, []);

  // --- 디렉터리 핸들 기반 고속 스캔 및 로드 (45권 이상도 0.1초 만에 로드) ---
  const scanAndLoadFromHandle = useCallback(
    async (handle: any, initialTargetVolume?: string, explicitSeriesId?: string) => {
      isTransitioningRef.current = true;

      // 0. 이전 만화책 상태 완전 클리어
      rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
      setRawFiles([]);
      setCurrentIndex(0);
      setCurl(null);
      animatingRef.current = false;

      const seriesTitle = explicitSeriesId || handle.name;
      currentSeriesIdRef.current = seriesTitle;
      setCurrentSeriesId(seriesTitle);
      localStorage.setItem('foldbook_current_series_id', seriesTitle);
      const subDirHandles = new Map<string, any>();
      let zipList: string[] = [];
      try {
        zipList = await listArchives(handle as any);
      } catch {}

      for await (const [name, entry] of (handle as any).entries()) {
        if (entry.kind === 'directory') {
          subDirHandles.set(name, entry);
        }
      }

      // A. 도라에몽 1~45권처럼 하위 권 폴더가 있는 경우
      if (subDirHandles.size > 0) {
        const subNames = Array.from(subDirHandles.keys()).sort((a, b) => collator.compare(a, b));
        subDirHandlesRef.current = subDirHandles;
        setArchives(subNames);
        localStorage.setItem('foldbook_archive_list', JSON.stringify(subNames));

        registerSeries(seriesTitle, seriesTitle, subNames, true);
        saveSeriesDirHandle(seriesTitle, handle);

        const target = initialTargetVolume && subNames.includes(initialTargetVolume) ? initialTargetVolume : subNames[0];
        const targetHandle = subDirHandles.get(target)!;

        // 첫 권 이미지들만 읽기 (0.1초 완료)
        const volFiles: File[] = [];
        for await (const [subFileName, subFileEntry] of (targetHandle as any).entries()) {
          if (subFileEntry.kind === 'file' && IMAGE_EXT_REGEX.test(subFileName)) {
            volFiles.push(await (subFileEntry as FileSystemFileHandle).getFile());
          }
        }
        volFiles.sort((a, b) => collator.compare(a.name, b.name));

        await handleMultipleImageFiles(volFiles, target, seriesTitle);
        setCurrentArchiveName(target);
        localStorage.setItem('foldbook_last_archive', target);
        if (subNames.length > 1) setShowDrawer(true);
        return;
      }

      // B. ZIP 파일들이 담겨 있는 경우
      if (zipList.length > 0) {
        zipList.sort((a, b) => collator.compare(a, b));
        setArchives(zipList);
        localStorage.setItem('foldbook_archive_list', JSON.stringify(zipList));

        registerSeries(seriesTitle, seriesTitle, zipList, true);
        saveSeriesDirHandle(seriesTitle, handle);

        const target = initialTargetVolume && zipList.includes(initialTargetVolume) ? initialTargetVolume : zipList[0];
        const file = await getArchiveFile(handle as any, target);
        if (file) {
          await loadZipFile(file, target, seriesTitle);
          setCurrentArchiveName(target);
          localStorage.setItem('foldbook_last_archive', target);
        }
        if (zipList.length > 1) setShowDrawer(true);
        return;
      }

      // C. 단일 폴더 이미지인 경우
      const rootFiles: File[] = [];
      for await (const [name, entry] of (handle as any).entries()) {
        if (entry.kind === 'file' && IMAGE_EXT_REGEX.test(name)) {
          rootFiles.push(await (entry as FileSystemFileHandle).getFile());
        }
      }
      if (rootFiles.length > 0) {
        rootFiles.sort((a, b) => collator.compare(a.name, b.name));
        registerSeries(seriesTitle, seriesTitle, [seriesTitle], true);
        saveSeriesDirHandle(seriesTitle, handle);
        await handleMultipleImageFiles(rootFiles, seriesTitle, seriesTitle);
        setCurrentArchiveName(seriesTitle);
        localStorage.setItem('foldbook_last_archive', seriesTitle);
        return;
      }

      alert('선택한 폴더 안에 권별 폴더나 이미지 파일이 없습니다.');
    },
    [rawFiles, registerSeries]
  );

  // 도서관 디렉터리 선택 (ZIP/CBZ 및 만화책A/1권,2권... 하위 이미지 폴더 완벽 지원)
  const handlePickDirectory = useCallback(async () => {
    if (!supportsDirPicker()) {
      alert('현재 브라우저에서는 폴더 선택 API를 지원하지 않습니다.');
      return;
    }
    try {
      const handle = await pickLibraryDir();
      setDirHandle(handle);
      await scanAndLoadFromHandle(handle);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('폴더 읽기 오류:', err);
      }
    }
  }, [scanAndLoadFromHandle]);

  // --- 시리즈 전환 (도라에몽 <-> 원피스 전환) ---
  const switchSeries = useCallback(
    async (seriesId: string) => {
      const targetSeries = seriesList.find((s) => s.id === seriesId);
      if (!targetSeries) return;

      // 이전 만화책 상태 완전 클리어 및 전환 가드 활성화
      isTransitioningRef.current = true;
      rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
      setRawFiles([]);
      setCurrentIndex(0);
      setCurl(null);
      animatingRef.current = false;

      currentSeriesIdRef.current = seriesId;
      setCurrentSeriesId(seriesId);
      localStorage.setItem('foldbook_current_series_id', seriesId);
      setArchives(targetSeries.volumes);
      localStorage.setItem('foldbook_archive_list', JSON.stringify(targetSeries.volumes));

      const targetVol = targetSeries.lastVolume && targetSeries.volumes.includes(targetSeries.lastVolume)
        ? targetSeries.lastVolume
        : targetSeries.volumes[0];

      // A. FileSystemDirectoryHandle이 저장되어 있는 경우
      const savedHandle = await getSeriesDirHandle(seriesId);
      if (savedHandle) {
        try {
          let hasPerm = false;
          try {
            const q = await (savedHandle as any).queryPermission({ mode: 'read' });
            if (q === 'granted') hasPerm = true;
            else {
              const r = await (savedHandle as any).requestPermission({ mode: 'read' });
              if (r === 'granted') hasPerm = true;
            }
          } catch {}

          if (hasPerm) {
            setDirHandle(savedHandle as any);
            await scanAndLoadFromHandle(savedHandle, targetVol, seriesId);
            return;
          }
        } catch (e) {
          console.warn('저장된 핸들 전환 실패:', e);
        }
      }

      // B. 메모리에 하위 폴더 맵이 있는 경우
      if (allSeriesSubDirsMapRef.current.has(seriesId)) {
        const subMap = allSeriesSubDirsMapRef.current.get(seriesId)!;
        subDirsMapRef.current = subMap;
        if (subMap.has(targetVol)) {
          await handleMultipleImageFiles(subMap.get(targetVol)!, targetVol, seriesId);
          setCurrentArchiveName(targetVol);
          localStorage.setItem('foldbook_last_archive', targetVol);
          return;
        }
      }

      // C. 메모리 해제 시 폴더 재선택 안내
      alert(`"${targetSeries.title}"의 연결을 복원하기 위해 해당 폴더를 다시 선택해 주세요.`);
      if (supportsDirPicker()) {
        handlePickDirectory();
      } else {
        folderInputRef.current?.click();
      }
    },
    [seriesList, rawFiles, scanAndLoadFromHandle, handlePickDirectory]
  );

  // --- 책장 넘김 완료 애니메이션 (finishCurl) ---
  const finishCurl = useCallback(
    (c: CurlState, complete: boolean) => {
      animatingRef.current = true;
      if (complete) playPageSound();

      const startX = c.m.x;
      const startY = c.m.y;
      const targetX = complete ? -(c.w * 0.98) : c.g.x;
      const targetY = c.g.y;
      const startTime = performance.now();
      const duration = 220;

      const animate = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);

        const currM: Pt = {
          x: startX + (targetX - startX) * ease,
          y: startY + (targetY - startY) * ease,
        };

        setCurl({ ...c, m: currM });

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          if (complete) {
            setCurrentIndex(c.nextIdx);
          }
          setCurl(null);
          animatingRef.current = false;
        }
      };

      requestAnimationFrame(animate);
    },
    [playPageSound]
  );

  // --- 제스처 이벤트 핸들러 (플리커 완벽 차단) ---
  const handleCurlDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const chassis = chassisRef.current;
    if (curl !== null || animatingRef.current || pages.length <= 1 || !chassis) return;

    // 모바일에서 홈 다녀왔을 때 터치 한 번으로 OS 전체화면 복구
    if (immersive && !document.fullscreenElement) {
      try {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen();
        }
      } catch {}
    }

    const rect = chassis.getBoundingClientRect();
    const scale = rect.width / chassis.offsetWidth || 1;
    const isSingle = isDisplaySingle;

    const w = isSingle ? chassis.offsetWidth : chassis.offsetWidth / 2;
    const h = chassis.offsetHeight;

    const cx = (e.clientX - rect.left) / scale;
    const cy = (e.clientY - rect.top) / scale;

    const edgeY = cy < h / 2 ? 0 : h;
    const gy = Math.max(0, Math.min(h, cy * 0.3 + edgeY * 0.7));
    const g: Pt = { x: w, y: gy };

    if (showImmersiveControls) setShowImmersiveControls(false);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: performance.now(),
      vx: 0,
      scale,
      w,
      h,
      cx,
      cy,
      gy,
      moved: false,
    };

    chassis.setPointerCapture(e.pointerId);
  };

  const handleCurlMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current;
    if (!d || d.pointerId !== e.pointerId) return;

    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    const inst = (e.clientX - d.lastX) / dt;
    d.vx = d.vx * 0.6 + inst * 0.4;
    d.lastX = e.clientX;
    d.lastT = now;

    const dxClient = e.clientX - d.startX;
    const dyClient = e.clientY - d.startY;

    if (Math.abs(dxClient) > 5 || Math.abs(dyClient) > 5) {
      d.moved = true;
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapRef.current = null;
    }

    if (!d.moved) return;

    // [정확한 방향 감지]:
    // 좌에서 우로 쓸기 (dxClient > 0) -> [다음 페이지(+1)] 좌측 페이지 컬
    // 우에서 좌로 쓸기 (dxClient < 0) -> [이전 페이지(-1)] 우측 페이지 컬
    const isRightSwipe = dxClient > 0;
    const side: 'left' | 'right' = isRightSwipe ? 'left' : 'right';
    const delta = isRightSwipe ? 1 : -1;
    const nextIdx = currentIndex + delta;

    if (nextIdx < 0) return;
    if (nextIdx >= pages.length) {
      if (hasNextBook) {
        d.atEndNext = true;
      }
      return;
    }

    const g: Pt = { x: d.w, y: d.gy };

    const dxLocal = (side === 'right' ? dxClient : -dxClient) / d.scale;
    const dyLocal = dyClient / d.scale;

    const mRaw: Pt = { x: d.w + dxLocal, y: d.gy + dyLocal };
    const m = clampCurlPoint(mRaw, g, d.w, d.h);

    setCurl({ side, nextIdx, w: d.w, h: d.h, g, m });
  };

  const handleCurlUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragStateRef.current = null;

    const isSingle = isDisplaySingle;

    if (!d.moved) {
      const now = performance.now();
      const last = lastTapRef.current;
      const clientX = e.clientX;
      const clientY = e.clientY;

      // [더블 탭 감지]: 280ms 이내에 45px 반경 안을 두 번 탭한 경우 전체화면 토글
      if (last && now - last.time < 280 && Math.hypot(clientX - last.x, clientY - last.y) < 45) {
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTapRef.current = null;
        toggleFullscreen();
        return;
      }

      lastTapRef.current = { time: now, x: clientX, y: clientY };

      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }

      singleTapTimerRef.current = setTimeout(() => {
        singleTapTimerRef.current = null;
        lastTapRef.current = null;

        // [단순 싱글 탭 - 메뉴 토글 모드]
        if (tapAction === 'menu') {
          if (immersive) {
            setShowImmersiveControls((v) => !v);
          }
          return;
        }

        // [단순 싱글 탭 - 페이지 넘김 모드 (디폴트)]
        const isRightTap = isSingle ? d.cx >= d.w / 2 : d.cx >= d.w;
        const delta = isRightTap ? 1 : -1;

        const nextIdx = currentIndex + delta;
        if (nextIdx >= pages.length && hasNextBook) {
          goNextBookRef.current();
          playPageSound();
          return;
        }

        if (nextIdx >= 0 && nextIdx < pages.length) {
          const tapSide: 'left' | 'right' = delta > 0 ? 'left' : 'right';
          const g: Pt = { x: d.w, y: d.h / 2 };
          const instantCurl: CurlState = { side: tapSide, nextIdx, w: d.w, h: d.h, g, m: g };
          setCurl(instantCurl);
          finishCurl(instantCurl, true);
        }
      }, 240);

      return;
    }

    if (d.atEndNext) {
      const dxClient = e.clientX - d.startX;
      const isCompleteSwipe = d.vx > 0.08 || dxClient > 30 || Math.abs(dxClient) > d.w * 0.08;
      if (isCompleteSwipe) {
        goNextBookRef.current();
        playPageSound();
        return;
      }
    }

    if (!curl) return;

    const dxClient = e.clientX - d.startX;
    const progress = curlProgress(curl.m, d.w);

    const towardSpine = curl.side === 'left' ? d.vx : -d.vx;

    let complete: boolean;
    if (towardSpine > 0.18) {
      complete = true;
    } else if (towardSpine < -0.20) {
      complete = false;
    } else {
      complete = progress > 0.10 || Math.abs(dxClient) > d.w * 0.15;
    }

    finishCurl(curl, complete);
  };

  const handleMainPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (e.target !== containerRef.current) return;
    const now = performance.now();
    const last = mainLastTapRef.current;
    if (last && now - last.time < 280 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 45) {
      mainLastTapRef.current = null;
      toggleFullscreen();
    } else {
      mainLastTapRef.current = { time: now, x: e.clientX, y: e.clientY };
    }
  };

  const nextSpread = curl ? pages[curl.nextIdx] : null;

  return (
    <div className="flex flex-col w-screen h-screen bg-neutral-950 text-neutral-100 overflow-hidden select-none">
      {/* --- 상단 툴바 (버튼 및 터치 영역 확대) --- */}
      {!immersive && (
        <header className="flex items-center justify-between px-3 sm:px-5 py-3 bg-neutral-900 border-b border-neutral-800 z-30 shrink-0 min-h-[56px]">
          <div className="flex items-center gap-2.5">
            {archives.length > 0 && (
              <button
                onClick={() => setShowDrawer((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-950/70 hover:bg-indigo-900 border border-indigo-500/40 text-indigo-200 text-xs sm:text-sm font-semibold transition-colors shadow-sm min-h-[38px]"
                title="도서 목록 열기"
              >
                <BookOpen className="w-4 h-4 text-indigo-400 shrink-0" />
                <span className="truncate max-w-[90px] sm:max-w-none">
                  도서 목록 ({archives.length})
                </span>
              </button>
            )}
            <h1 className="text-sm sm:text-base font-semibold truncate max-w-[130px] sm:max-w-xs text-neutral-200">
              {bookTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2">

            {/* 1. 파일 열기 (ZIP, CBZ 또는 이미지들) */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
              title="파일 열기 (ZIP, CBZ 압축 파일 또는 이미지 여러 장)"
            >
              <FileArchive className="w-5 h-5 text-indigo-400" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.cbz,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                const fileList = Array.from(files);
                const zips = fileList
                  .filter((f) => /\.(zip|cbz)$/i.test(f.name))
                  .sort((a, b) => collator.compare(a.name, b.name));

                if (zips.length > 0) {
                  const map = new Map<string, File>();
                  const persistItems: { name: string; blob: Blob }[] = [];
                  zips.forEach((f) => {
                    map.set(f.name, f);
                    persistItems.push({ name: f.name, blob: f });
                  });
                  zipFilesMapRef.current = map;
                  persistAllZipArchives(persistItems);
                  const names = zips.map((f) => f.name);
                  setArchives(names);
                  localStorage.setItem('foldbook_archive_list', JSON.stringify(names));
                  loadZipFile(zips[0]);
                  setCurrentArchiveName(zips[0].name);
                  localStorage.setItem('foldbook_last_archive', zips[0].name);
                  if (zips.length > 1) {
                    setShowDrawer(true);
                  }
                } else {
                  handleMultipleImageFiles(fileList);
                }
                e.target.value = '';
              }}
            />

            {/* 2. 폴더 열기 (이미지 폴더 통째로 로드) */}
            <button
              onClick={() => {
                if (supportsDirPicker()) {
                  handlePickDirectory();
                } else {
                  folderInputRef.current?.click();
                }
              }}
              className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
              title="이미지/만화책 폴더 통째로 열기"
            >
              <FolderOpen className="w-5 h-5 text-amber-400" />
            </button>
            <input
              ref={folderInputRef}
              type="file"
              // @ts-ignore
              webkitdirectory=""
              directory=""
              multiple
              className="hidden"
              onChange={handleFolderChange}
            />

            <div className="w-[1px] h-5 bg-neutral-800 mx-0.5" />

            {/* 보기 모드 전환 (페이지 위치 자동 보정) */}
            <button
              onClick={handleToggleViewMode}
              className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs sm:text-sm font-medium text-neutral-200 flex items-center gap-1.5 transition-colors shadow-sm min-h-[38px]"
              title="보기 모드 전환"
            >
              <Columns className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400" />
              <span className="hidden sm:inline">
                {viewMode === 'spread'
                  ? '양면 폴드북'
                  : viewMode === 'split'
                  ? '단면 꽉참 (Fold 커버)'
                  : '2장 합치기'}
              </span>
            </button>

            {/* 읽기 방향 전환 */}
            <button
              onClick={() => setReadingDirection((d) => (d === 'rtl' ? 'ltr' : 'rtl'))}
              className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs sm:text-sm font-medium text-neutral-200 flex items-center gap-1.5 transition-colors shadow-sm min-h-[38px]"
              title="읽기 방향 전환"
            >
              <ArrowLeftRight className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400" />
              <span className="hidden sm:inline">
                {readingDirection === 'rtl' ? '만화 (우->좌)' : '일반 (좌->우)'}
              </span>
            </button>

            {/* 사운드 ON/OFF 버튼 */}
            <button
              onClick={() => setSoundEnabled((v) => !v)}
              className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
              title={soundEnabled ? '효과음 끄기' : '효과음 켜기'}
            >
              {soundEnabled ? (
                <Volume2 className="w-5 h-5 text-emerald-400" />
              ) : (
                <VolumeX className="w-5 h-5 text-neutral-400" />
              )}
            </button>

            <div className="w-[1px] h-5 bg-neutral-800 mx-0.5" />

            {/* 몰입 모드 (전체화면) */}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title="전체화면 몰입 모드"
            >
              <Maximize2 className="w-5 h-5" />
            </button>
          </div>
        </header>
      )}

      {/* --- 메인 뷰어 캔버스 영역 --- */}
      <main
        ref={containerRef}
        className={"relative flex-1 flex items-center justify-center overflow-hidden " + (immersive ? "p-0" : "p-2 sm:p-4")}
        onPointerUp={handleMainPointerUp}
        onDoubleClick={toggleFullscreen}
      >
        {pages.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-neutral-400 gap-5 max-w-sm px-4 text-center">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-3xl bg-indigo-950/60 border border-indigo-500/30 flex items-center justify-center shadow-2xl">
              <BookOpen className="w-8 h-8 sm:w-10 sm:h-10 stroke-[1.5] text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-neutral-100">만화책을 열어주세요</h2>
              <p className="text-xs sm:text-sm text-neutral-400 mt-1">
                {isLoadingSaved
                  ? '이전 독서 기록을 불러오는 중...'
                  : '이미지들이 담긴 폴더를 선택하거나 ZIP/CBZ 압축 파일을 열어보세요.'}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5 w-full mt-1">
              <button
                onClick={() => folderInputRef.current?.click()}
                className="flex-1 py-3 px-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg transition-transform active:scale-95"
              >
                <FolderOpen className="w-4 h-4 text-amber-300" />
                <span>이미지 폴더 열기</span>
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex-1 py-3 px-4 rounded-2xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 border border-neutral-700/80 shadow transition-transform active:scale-95"
              >
                <FileArchive className="w-4 h-4 text-indigo-400" />
                <span>ZIP / CBZ 파일</span>
              </button>
            </div>
          </div>
        ) : (
          <div
            ref={chassisRef}
            style={{
              width: chassisW,
              height: chassisH,
            }}
            className={
              'book-chassis cursor-grab active:cursor-grabbing relative overflow-hidden select-none touch-none ' +
              (immersive ? 'book-chassis-bare' : 'rounded-[10px] shadow-2xl')
            }
            onPointerDown={handleCurlDown}
            onPointerMove={handleCurlMove}
            onPointerUp={handleCurlUp}
            onPointerCancel={handleCurlUp}
            onDoubleClick={toggleFullscreen}
          >
            {isDisplaySingle ? (
              /* [가변 단면 표시 - 단면 표지/작가의 말 또는 분할 모드] */
              <div className="w-full h-full relative overflow-hidden flex items-center justify-center bg-neutral-900">
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    curl && nextSpread
                      ? (nextSpread.isSingle || isDisplaySingle ? nextSpread.left : nextSpread.right)
                      : currentSpread?.left || currentSpread?.right
                  )}
                />
              </div>
            ) : (
              /* [가변 양면 표시 - 2페이지 펼침면] */
              <>
                <div className="page-half left-0 rounded-l-[10px]">
                  <div
                    className="w-full h-full bg-no-repeat"
                    style={getSliceStyle(
                      curl?.side === 'left' && nextSpread ? nextSpread.left : currentSpread?.left
                    )}
                  />
                </div>
                <div className="page-half right-0 rounded-r-[10px]">
                  <div
                    className="w-full h-full bg-no-repeat"
                    style={getSliceStyle(
                      curl?.side === 'right' && nextSpread ? nextSpread.right : currentSpread?.right
                    )}
                  />
                </div>
              </>
            )}

            {/* 3D 책장 넘김 레이어 */}
            {curl && nextSpread && currentSpread && (
              <div
                className="pointer-events-none z-20"
                style={
                  isDisplaySingle && curl.side === 'right'
                    ? {
                        position: 'absolute',
                        top: 0,
                        left: '-100%',
                        width: '200%',
                        height: '100%',
                      }
                    : {
                        position: 'absolute',
                        inset: 0,
                      }
                }
              >
                <PageCurl
                  side={curl.side}
                  w={curl.w}
                  h={curl.h}
                  g={curl.g}
                  m={curl.m}
                  rounded={!immersive}
                  front={getSliceStyle(
                    isDisplaySingle
                      ? currentSpread.left
                      : curl.side === 'right'
                      ? currentSpread.right
                      : currentSpread.left
                  )}
                  back={getSliceStyle(
                    isDisplaySingle
                      ? nextSpread.left
                      : curl.side === 'right'
                      ? nextSpread.left
                      : nextSpread.right
                  )}
                />
              </div>
            )}

            {/* 중앙 제본선 음영은 펼침면 + creaseEnabled 일 때만 표시 (단면 표지에는 표시 안함) */}
            {!isDisplaySingle && creaseEnabled && <div className="center-crease" />}

            {/* 권말 다음 권 안내 배너 (클릭하여 즉시 열기 지원) */}
            {currentIndex === pages.length - 1 && hasNextBook && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goNextBookRef.current();
                  playPageSound();
                }}
                className="absolute bottom-5 sm:bottom-8 px-5 py-2.5 bg-indigo-900/90 hover:bg-indigo-800 border border-indigo-400/50 rounded-full text-indigo-100 text-xs sm:text-sm font-semibold shadow-2xl z-30 animate-pulse backdrop-blur cursor-pointer pointer-events-auto active:scale-95 transition-transform flex items-center gap-1.5"
                title="클릭하여 다음 권 바로 열기"
              >
                <span>마지막 페이지입니다. 탭하여 다음 권 열기 →</span>
              </button>
            )}
          </div>
        )}

        {immersive && (tapAction === 'page' || showImmersiveControls) && (
          <>
            {/* 우상단 전체화면 최소화 버튼 */}
            <button
              onClick={toggleFullscreen}
              style={{
                top: 'calc(1rem + env(safe-area-inset-top, 0px))',
                right: 'calc(1rem + env(safe-area-inset-right, 0px))',
              }}
              className="absolute p-2.5 bg-neutral-900/80 hover:bg-neutral-800 rounded-full text-neutral-300 z-50 backdrop-blur shadow-lg transition-opacity duration-200 flex items-center justify-center"
              title="기본 모드로 복귀"
            >
              <Minimize2 className="w-5 h-5" />
            </button>

            {/* 중앙 하단 페이지 번호 배지 */}
            {tapAction === 'menu' && (
              <div
                style={{
                  bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
                }}
                className="absolute left-1/2 -translate-x-1/2 px-4 py-1.5 bg-neutral-900/80 border border-neutral-700/60 rounded-full text-xs text-neutral-300 backdrop-blur shadow-lg pointer-events-none z-50 font-mono"
              >
                {String(currentIndex + 1) + ' / ' + String(pages.length)}
              </div>
            )}
          </>
        )}
      </main>

      {/* --- 하단 네비게이션 & 페이지 스크러버 --- */}
      {!immersive && pages.length > 0 && (
        <footer className="flex items-center justify-between px-3 sm:px-5 py-2.5 bg-neutral-900 border-t border-neutral-800 z-30 shrink-0 min-h-[52px]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
              disabled={currentIndex === 0}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title="이전 페이지"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => {
                if (currentIndex < pages.length - 1) {
                  setCurrentIndex((idx) => idx + 1);
                } else if (hasNextBook) {
                  goNextBookRef.current();
                  playPageSound();
                }
              }}
              disabled={currentIndex >= pages.length - 1 && !hasNextBook}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title={currentIndex >= pages.length - 1 && hasNextBook ? '다음 권으로 넘어가기' : '다음 페이지'}
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-3 flex-1 max-w-md mx-3">
            <input
              type="range"
              min={0}
              max={pages.length - 1}
              value={currentIndex}
              onChange={(e) => setCurrentIndex(Number(e.target.value))}
              className="w-full accent-indigo-400 h-1.5 bg-neutral-700 rounded-lg cursor-pointer"
            />
            <span className="text-xs sm:text-sm text-neutral-400 font-mono whitespace-nowrap min-w-[55px] text-right">
              {String(currentIndex + 1) + ' / ' + String(pages.length)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setTapAction((a) => (a === 'page' ? 'menu' : 'page'))}
              className={
                'px-2.5 sm:px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-colors shadow-sm ' +
                (tapAction === 'menu'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200 border border-neutral-700')
              }
              title="화면 단순 탭 동작 전환 (페이지 넘기기 vs 전체화면 메뉴 토글)"
            >
              {tapAction === 'menu' ? '탭: 메뉴 토글' : '탭: 페이지 넘김'}
            </button>

            <button
              onClick={() => setCreaseEnabled((v) => !v)}
              className={
                'px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-colors shadow-sm ' +
                (creaseEnabled ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200 border border-neutral-700')
              }
              title="중앙 제본선 음영 토글"
            >
              제본선 {creaseEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </footer>
      )}

      {/* --- 사이드 서랍: 내 서재(시리즈 목록) & 권별 목록 --- */}
      {showDrawer && (
        <div className="fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowDrawer(false)} />
          <div className="relative w-80 bg-neutral-900 h-full p-4 flex flex-col z-10 border-r border-neutral-800 shadow-2xl">
            {/* 서랍 헤더 */}
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-indigo-400" />
                <span className="text-sm font-bold text-neutral-100">내 만화책 서재</span>
              </div>
              <button
                onClick={() => setShowDrawer(false)}
                className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 1. 만화책 시리즈 전환 드롭다운 / 목록 */}
            <div className="py-3 border-b border-neutral-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-neutral-400">만화책 시리즈 ({seriesList.length})</span>
                <button
                  onClick={() => {
                    if (supportsDirPicker()) {
                      handlePickDirectory();
                    } else {
                      folderInputRef.current?.click();
                    }
                  }}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1"
                >
                  + 새 시리즈 추가
                </button>
              </div>

              {seriesList.length > 0 && (
                <div className="flex flex-col gap-1 max-h-36 overflow-y-auto pr-1">
                  {seriesList.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        if (s.id !== currentSeriesId) {
                          switchSeries(s.id);
                        }
                      }}
                      className={
                        'w-full text-left px-2.5 py-1.5 rounded-lg text-xs truncate transition-colors flex items-center justify-between ' +
                        (s.id === currentSeriesId
                          ? 'bg-indigo-600 text-white font-semibold shadow-sm'
                          : 'bg-neutral-800/80 text-neutral-300 hover:bg-neutral-800')
                      }
                      title={s.title}
                    >
                      <span className="truncate flex-1">{s.title}</span>
                      <span className="text-[10px] opacity-70 shrink-0 ml-1.5">({s.volumes.length}권)</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 2. 현재 선택된 시리즈의 권별 목록 (도라에몽 01권, 02권...) */}
            <div className="flex items-center justify-between pt-3 pb-2">
              <span className="text-xs font-semibold text-neutral-400">
                권별 목록 ({archives.length})
              </span>
              <span className="text-[11px] text-neutral-400 font-mono truncate max-w-[120px]">
                {currentArchiveName || '권 선택'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {archives.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    loadArchiveByIndex(name);
                    setShowDrawer(false);
                  }}
                  className={
                    'w-full text-left px-3 py-2.5 rounded-xl text-xs sm:text-sm truncate transition-colors flex items-center justify-between ' +
                    (name === currentArchiveName
                      ? 'bg-indigo-600/30 text-indigo-200 font-semibold border border-indigo-500/30'
                      : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200')
                  }
                >
                  <span className="truncate">{name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
