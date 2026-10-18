/**
 * 대화 내용 보기 (client/src/features/message/ConversationPane.tsx).
 *
 * 목록의 통수 배지를 누르면 읽기 영역에 뜬다. 입력은 **대화 마지막 메일의 원문**이고,
 * 화면은 그 안에 쌓인 인용을 갈라 발송자 · 시간 · 본문을 한 덩이씩 보여 준다.
 * 그래서 이 화면의 스펙도 원문을 골라 넣고 뽑힌 덩이들을 보는 식이다 (fixtures/eml.ts).
 */
import type { Locator, Page } from '@playwright/test';

export class ConversationPage {
  constructor(readonly page: Page) {}

  get pane(): Locator {
    return this.page.locator('.reading.conv');
  }

  /** 뽑힌 메일들. 메신저처럼 **오래된 것이 위, 최근이 아래**다 */
  get items(): Locator {
    return this.pane.locator('.chat-row');
  }

  /** 내가 보낸 메일만 — 오른쪽에 서는 줄이다 (남이 보낸 메일은 왼쪽) */
  get ownItems(): Locator {
    return this.pane.locator('.chat-row.own');
  }

  /** 말풍선 옆 사진. 사진이 없으면 이름 첫 글자를 넣은 span 이 대신 서고, 내 말에는 없다 */
  avatar(index: number): Locator {
    return this.item(index).locator('.avatar');
  }

  item(index: number): Locator {
    return this.items.nth(index);
  }

  who(index: number): Locator {
    return this.item(index).locator('.conv-who');
  }

  when(index: number): Locator {
    return this.item(index).locator('.conv-when');
  }

  body(index: number): Locator {
    return this.item(index).locator('.conv-body');
  }

  get openLastButton(): Locator {
    return this.pane.locator('.reading-toolbar button');
  }
}
