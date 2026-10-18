/**
 * 수신자 입력칸 (USR-1.4). 주소를 한 덩어리(블럭)로 다룬다.
 *  - 엔터·콤마(,)·세미콜론(;) → 입력 중인 주소를 블럭으로 확정
 *  - 블럭을 클릭해 고른 뒤 Del·Backspace → 삭제, ←·→ → 옆 블럭 이동, 더블클릭 → 다시 편집
 *  - 블럭을 끌어 같은 칸에서 순서 변경, 받는사람 ↔ 참조 ↔ 숨은참조 이동 (양방향)
 *  - 입력 중에는 주소록·내부 계정에서 찾은 후보를 아래에 펼친다 (useAddressSuggest)
 * 칸 사이 이동을 한 번에 처리하려면 세 칸의 목록을 useRecipients 훅 하나가 들고 있어야 한다.
 */
import { Fragment, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { displayAddress } from '../../lib/format';
import { useAddressSuggest } from './useAddressSuggest';
import { t } from '../../i18n';

export type AddressField = 'to' | 'cc' | 'bcc';

interface Spot {
  field: AddressField;
  index: number;
}

/** dragover 단계에서는 dataTransfer 값을 읽을 수 없어 커스텀 타입으로 "블럭 드래그" 임을 표시한다 */
const DRAG_TYPE = 'application/x-james9-recipient';

const ADDRESS_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** "홍길동 <a@b>" 형태면 꺾쇠 안의 주소만 꺼낸다 */
export function addressOf(entry: string): string {
  const match = /<([^>]+)>/.exec(entry);
  return (match?.[1] ?? entry).trim();
}

export function isValidAddress(entry: string): boolean {
  return ADDRESS_RE.test(addressOf(entry));
}

/** 콤마·세미콜론·줄바꿈으로 끊어 주소 목록을 만든다 */
export function parseAddresses(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sameAddress(a: string, b: string): boolean {
  return addressOf(a).toLowerCase() === addressOf(b).toLowerCase();
}

export interface RecipientControl {
  /** 자동완성 캐시의 주인. 로그인 계정이 바뀌면 캐시를 버린다 */
  owner: string;
  /** 발송·미리보기에 쓰는 값. 아직 확정하지 않은 입력 중 주소까지 포함한다 */
  to: string;
  cc: string;
  bcc: string;
  isEmpty: boolean;
  entries: (field: AddressField) => string[];
  draft: (field: AddressField) => string;
  setDraft: (field: AddressField, text: string) => void;
  /** 입력 중인 텍스트를 블럭으로 확정 */
  commit: (field: AddressField) => void;
  add: (field: AddressField, entries: string[]) => void;
  insert: (field: AddressField, index: number, entries: string[]) => void;
  remove: (field: AddressField, index: number) => void;
  move: (from: Spot, to: Spot) => void;
  dragging: Spot | null;
  dropAt: Spot | null;
  beginDrag: (spot: Spot) => void;
  hoverDrop: (spot: Spot | null) => void;
  endDrag: () => void;
  /** 드롭 순간의 드래그 원본 (state 반영 전에도 읽히도록 ref 로 보관) */
  source: () => Spot | null;
}

export function useRecipients(
  seed: { to?: string; cc?: string; bcc?: string },
  owner: string,
): RecipientControl {
  const [lists, setLists] = useState<Record<AddressField, string[]>>(() => ({
    to: parseAddresses(seed.to ?? ''),
    cc: parseAddresses(seed.cc ?? ''),
    bcc: parseAddresses(seed.bcc ?? ''),
  }));
  const [drafts, setDrafts] = useState<Record<AddressField, string>>({ to: '', cc: '', bcc: '' });
  const [dragging, setDragging] = useState<Spot | null>(null);
  const [dropAt, setDropAt] = useState<Spot | null>(null);
  const sourceRef = useRef<Spot | null>(null);

  function insert(field: AddressField, index: number, entries: string[]) {
    const added = entries.map((entry) => entry.trim()).filter(Boolean);
    if (added.length === 0) return;
    setLists((prev) => {
      const next = [...prev[field]];
      const fresh: string[] = [];
      // 같은 칸에 같은 주소는 한 번만 둔다
      for (const entry of added) {
        if (next.some((e) => sameAddress(e, entry))) continue;
        if (fresh.some((e) => sameAddress(e, entry))) continue;
        fresh.push(entry);
      }
      if (fresh.length === 0) return prev;
      next.splice(Math.max(0, Math.min(index, next.length)), 0, ...fresh);
      return { ...prev, [field]: next };
    });
  }

  function value(field: AddressField): string {
    return [...lists[field], ...parseAddresses(drafts[field])].join(', ');
  }

  return {
    owner,
    to: value('to'),
    cc: value('cc'),
    bcc: value('bcc'),
    isEmpty: !value('to') && !value('cc') && !value('bcc'),
    entries: (field) => lists[field],
    draft: (field) => drafts[field],
    setDraft: (field, text) => setDrafts((prev) => ({ ...prev, [field]: text })),
    commit(field) {
      const entries = parseAddresses(drafts[field]);
      if (entries.length > 0) insert(field, lists[field].length, entries);
      if (drafts[field]) setDrafts((prev) => ({ ...prev, [field]: '' }));
    },
    add: (field, entries) => insert(field, lists[field].length, entries),
    insert,
    remove: (field, index) => setLists((prev) => ({ ...prev, [field]: prev[field].filter((_, i) => i !== index) })),
    move(from, to) {
      setLists((prev) => {
        const entry = prev[from.field][from.index];
        if (entry === undefined) return prev;
        const next = { to: [...prev.to], cc: [...prev.cc], bcc: [...prev.bcc] };
        next[from.field].splice(from.index, 1);
        // 같은 칸에서 뒤로 옮기면 원본을 뺀 만큼 자리가 당겨진다
        const index = from.field === to.field && to.index > from.index ? to.index - 1 : to.index;
        const target = next[to.field];
        // 옮겨 갈 칸에 이미 있는 주소면 원본만 지워 중복을 정리한다
        if (!target.some((e) => sameAddress(e, entry))) {
          target.splice(Math.max(0, Math.min(index, target.length)), 0, entry);
        }
        return next;
      });
    },
    dragging,
    dropAt,
    beginDrag(spot) {
      sourceRef.current = spot;
      setDragging(spot);
    },
    hoverDrop: (spot) => setDropAt(spot),
    endDrag() {
      sourceRef.current = null;
      setDragging(null);
      setDropAt(null);
    },
    source: () => sourceRef.current,
  };
}

export function RecipientInput({
  ctl,
  field,
  placeholder,
}: {
  ctl: RecipientControl;
  field: AddressField;
  placeholder?: string;
}) {
  const entries = ctl.entries(field);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropIndex = ctl.dropAt && ctl.dropAt.field === field ? ctl.dropAt.index : null;

  const suggest = useAddressSuggest(ctl.owner);
  const [active, setActive] = useState(-1);
  // 이미 이 칸에 넣은 주소는 후보에서 뺀다
  const options = suggest.items.filter(
    (item) => !entries.some((entry) => addressOf(entry).toLowerCase() === item.address.toLowerCase()),
  );
  const open = options.length > 0 && ctl.draft(field).trim().length > 0;
  // 후보 목록이 줄어드는 사이 고른 자리가 밖으로 나갈 수 있다
  const activeIndex = active < options.length ? active : -1;

  function closeSuggest() {
    suggest.clear();
    setActive(-1);
  }

  /** 후보를 골라 블럭으로 넣는다. 이름이 있으면 "홍길동 <hong@x>" 로 적는다 */
  function choose(index: number) {
    const item = options[index];
    if (!item) return;
    // 주소록 그룹은 멤버 전부를 블럭으로 넣는다 (이미 이 칸에 있는 주소는 add 가 거른다)
    if (item.members) ctl.add(field, item.members.map((m) => displayAddress(m.name, m.address)));
    else ctl.add(field, [displayAddress(item.name, item.address)]);
    ctl.setDraft(field, '');
    closeSuggest();
    inputRef.current?.focus();
  }

  /** 삭제·이동으로 다시 그려진 다음에 포커스를 옮긴다 (포커스 = 고른 블럭) */
  function focusChip(index: number) {
    setTimeout(() => {
      const chips = boxRef.current?.querySelectorAll<HTMLElement>('.chip');
      const chip = chips?.[Math.max(0, Math.min(index, chips.length - 1))];
      if (chip) chip.focus();
      else inputRef.current?.focus();
    }, 0);
  }

  /** 블럭을 텍스트로 되돌려 고칠 수 있게 한다 */
  function editChip(index: number) {
    const entry = entries[index];
    if (!entry) return;
    ctl.remove(field, index);
    ctl.setDraft(field, [ctl.draft(field).trim(), entry].filter(Boolean).join(' '));
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function onInputChange(text: string) {
    // 구분자가 섞여 들어오면(타이핑·붙여넣기) 끊어서 블럭으로 확정하고 마지막 조각만 입력칸에 남긴다
    if (!/[,;\n]/.test(text)) {
      ctl.setDraft(field, text);
      suggest.query(text);
      setActive(-1);
      return;
    }
    const parts = text.split(/[,;\n]+/);
    const rest = parts.pop() ?? '';
    ctl.add(field, parts);
    ctl.setDraft(field, rest);
    suggest.query(rest);
    setActive(-1);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const draft = ctl.draft(field);
    if (event.nativeEvent.isComposing) return; // 한글 조합 중의 엔터는 조합 확정이다
    if (open) {
      // 후보를 펼친 동안에는 ↑↓ 로 고르고 Enter·Tab 으로 넣는다
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((index) => (index + 1 >= options.length ? 0 : index + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => (index <= 0 ? options.length - 1 : index - 1));
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSuggest();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && activeIndex >= 0) {
        event.preventDefault();
        choose(activeIndex);
        return;
      }
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      ctl.commit(field);
      closeSuggest();
    } else if (event.key === 'Tab' && draft.trim()) {
      ctl.commit(field);
      closeSuggest();
    } else if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && !draft && entries.length > 0) {
      // 입력칸이 비었으면 마지막 블럭을 고른 상태로 만든다. 한 번 더 누르면 지워진다
      event.preventDefault();
      focusChip(entries.length - 1);
    }
  }

  function onChipKeyDown(event: KeyboardEvent<HTMLSpanElement>, index: number) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      ctl.remove(field, index);
      focusChip(event.key === 'Backspace' ? index - 1 : index);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (index < entries.length - 1) focusChip(index + 1);
      else inputRef.current?.focus();
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      editChip(index);
    }
  }

  /** 첨부 파일 드롭(부모 모달이 처리)에는 끼어들지 않는다 */
  function accepts(event: DragEvent): boolean {
    const types = event.dataTransfer.types;
    if (types.includes('Files')) return false;
    return types.includes(DRAG_TYPE) || types.includes('text/plain');
  }

  function onChipDragOver(event: DragEvent<HTMLSpanElement>, index: number) {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    // 블럭의 좌·우 절반 중 어느 쪽에 놓는지로 끼어들 자리를 정한다
    const rect = event.currentTarget.getBoundingClientRect();
    ctl.hoverDrop({ field, index: event.clientX > rect.left + rect.width / 2 ? index + 1 : index });
  }

  function onBoxDragOver(event: DragEvent<HTMLDivElement>) {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    ctl.hoverDrop({ field, index: entries.length });
  }

  function onBoxDrop(event: DragEvent<HTMLDivElement>) {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = dropIndex ?? entries.length;
    const source = ctl.source();
    if (source) ctl.move(source, { field, index });
    else ctl.insert(field, index, parseAddresses(event.dataTransfer.getData('text/plain')));
    ctl.endDrag();
  }

  return (
    <div
      ref={boxRef}
      className={`chips ${ctl.dragging ? 'dnd' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) inputRef.current?.focus();
      }}
      onDragOver={onBoxDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) ctl.hoverDrop(null);
      }}
      onDrop={onBoxDrop}
    >
      {entries.map((entry, index) => (
        <Fragment key={`${index}-${entry}`}>
          {dropIndex === index && <span className="chip-caret" aria-hidden />}
          <span
            className={[
              'chip',
              isValidAddress(entry) ? '' : 'invalid',
              ctl.dragging?.field === field && ctl.dragging.index === index ? 'moving' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            tabIndex={0}
            draggable
            title={isValidAddress(entry) ? entry : t('recipient.invalid', { entry })}
            onClick={(event) => event.currentTarget.focus()}
            onDoubleClick={() => editChip(index)}
            onKeyDown={(event) => onChipKeyDown(event, index)}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, `${field}:${index}`);
              event.dataTransfer.setData('text/plain', entry);
              event.dataTransfer.effectAllowed = 'move';
              ctl.beginDrag({ field, index });
            }}
            onDragEnd={() => ctl.endDrag()}
            onDragOver={(event) => onChipDragOver(event, index)}
          >
            <span className="chip-text">{entry}</span>
            <button
              type="button"
              className="chip-x"
              tabIndex={-1}
              title={t('common.delete')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                ctl.remove(field, index);
                focusChip(index);
              }}
            >
              ✕
            </button>
          </span>
        </Fragment>
      ))}
      {dropIndex === entries.length && <span className="chip-caret" aria-hidden />}
      <input
        ref={inputRef}
        className="chip-input"
        value={ctl.draft(field)}
        placeholder={entries.length === 0 ? placeholder : ''}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={onInputKeyDown}
        onBlur={() => {
          ctl.commit(field);
          closeSuggest();
        }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {open && (
        <ul className="suggest" role="listbox">
          {options.map((item, index) => (
            <li
              key={item.address || `group-${item.groupId}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`suggest-item ${index === activeIndex ? 'on' : ''}`}
              // 클릭하려고 누르는 순간 입력칸이 blur 되면 목록이 닫혀 버린다
              onMouseDown={(event) => {
                event.preventDefault();
                choose(index);
              }}
              onMouseEnter={() => setActive(index)}
            >
              {item.members ? (
                <>
                  <span className="suggest-name">{item.name}</span>
                  <span className="suggest-addr">{t('addressbook.groupMembers', { count: item.members.length })}</span>
                </>
              ) : item.name ? (
                <>
                  <span className="suggest-name">{item.name}</span>
                  <span className="suggest-addr">&lt;{item.address}&gt;</span>
                </>
              ) : (
                <span className="suggest-addr">{item.address}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
