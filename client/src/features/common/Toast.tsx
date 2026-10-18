/**
 * 화면 상단 중앙에서 내려왔다 잠시 뒤 다시 올라가는 알림.
 *
 * 모달 안(메일쓰기 등)에서도 띄워야 해서 prop 을 내려보내는 대신 모듈 단위 발행/구독을 쓴다.
 * 표시는 App 에 한 번 놓인 <ToastHost /> 가 맡고, 어디서든 showToast() 로 부른다.
 */
import { useEffect, useState } from 'react';

export type ToastKind = 'error' | 'info';

interface ToastMsg {
  /** 같은 문구가 연달아 와도 애니메이션을 다시 돌리기 위한 키 */
  id: number;
  text: string;
  kind: ToastKind;
}

const listeners = new Set<(msg: ToastMsg) => void>();
let seq = 0;

export function showToast(text: string, kind: ToastKind = 'info'): void {
  seq += 1;
  const msg: ToastMsg = { id: seq, text, kind };
  for (const listener of listeners) listener(msg);
}

/** 내려온 뒤 머무는 시간. 이 시간이 지나면 위로 사라진다 */
const HOLD_MS = 1000;
/** styles.css 의 toast-lift 길이와 맞춘다 */
const EXIT_MS = 220;

export function ToastHost() {
  const [current, setCurrent] = useState<ToastMsg | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const listener = (msg: ToastMsg) => setCurrent(msg);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    setLeaving(false);
    const hold = setTimeout(() => setLeaving(true), HOLD_MS);
    const gone = setTimeout(() => setCurrent(null), HOLD_MS + EXIT_MS);
    return () => {
      clearTimeout(hold);
      clearTimeout(gone);
    };
  }, [current]);

  if (!current) return null;
  return (
    <div
      key={current.id}
      className={`toast-top ${current.kind}${leaving ? ' leaving' : ''}`}
      role={current.kind === 'error' ? 'alert' : 'status'}
    >
      {current.text}
    </div>
  );
}
