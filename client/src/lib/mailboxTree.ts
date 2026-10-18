/** 편지함 트리 구성. 사이드(USR-3) · 편지함 선택 팝업(POPUP-1) · 편지함 관리(USR-16)가 같이 쓴다 */
import type { Mailbox } from '../api/types';

export interface TreeNode {
  box: Mailbox;
  depth: number;
  children: TreeNode[];
}

/** 기본 편지함 → 개인 편지함 순, 그 안에서 order 순 (설계서 USR-3 · POPUP-1) */
export function buildTree(mailboxes: Mailbox[]): TreeNode[] {
  const byName = new Map(
    mailboxes.map((b) => [b.name, { box: b, depth: 0, children: [] as TreeNode[] } as TreeNode]),
  );
  const roots: TreeNode[] = [];
  const sorted = [...mailboxes].sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
    return a.order - b.order;
  });
  for (const box of sorted) {
    const node = byName.get(box.name)!;
    const parent = box.parentName ? byName.get(box.parentName) : undefined;
    if (parent) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else roots.push(node);
  }
  return roots;
}

/** 트리를 깊이 순으로 펼친 목록 (테이블·select 용) */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
