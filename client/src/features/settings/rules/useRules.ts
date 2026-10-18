/**
 * 네 화면(자동분류 · 부재중 · 수신거부 · 포워딩)이 공유하는 규칙 모델 로더/세이버.
 *
 * 서버는 활성 Sieve 스크립트 하나를 통째로 다시 쓰기 때문에, 규칙 한 건만 고쳐도
 * 저장은 항상 읽어온 모델 전체를 보낸다(다른 화면 규칙 보존). 낙관적 잠금은
 * 읽은 시점의 activatedAt 으로 건다.
 *
 * 목록 화면은 행(규칙) 단위로 저장하므로 save 에 바뀐 목록을 바로 넘긴다
 * (setState 는 비동기라 state 를 거치면 직전 값이 저장될 수 있다).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { Model } from './types';
import { t } from '../../../i18n';

export function useRules() {
  const [model, setModel] = useState<Model | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api.get<Model>('/api/rules').then(setModel), []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((patch: Partial<Model>) => {
    setModel((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  /** patch 를 덮어쓴 모델 전체를 저장한다. 성공하면 null, 실패하면 오류 문구를 돌려준다 */
  const save = useCallback(
    async (patch?: Partial<Model>): Promise<string | null> => {
      if (!model) return t('rules.loading');
      const next = patch ? { ...model, ...patch } : model;
      setMsg(null);
      try {
        await api.put<{ script: string }>('/api/rules', {
          filters: next.filters,
          rejects: next.rejects,
          forwards: next.forwards,
          vacation: next.vacation,
          expectedActivatedAt: model.activatedAt,
        });
        setMsg(t('common.saved'));
        await load();
        return null;
      } catch (cause) {
        const reason = cause instanceof ApiError ? cause.message : t('common.saveFailed');
        setMsg(reason);
        return reason;
      }
    },
    [model, load],
  );

  return { model, msg, setMsg, update, save };
}
