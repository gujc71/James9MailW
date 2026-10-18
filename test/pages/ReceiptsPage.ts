/**
 * 수신확인 팝업 (receipts/Receipts.tsx). 내가 보낸 메일을 읽을 때 "수신 확인" 버튼이 연다.
 *
 * 수신확인·회수는 내부 계정 수신자에게만 통한다. 외부 도메인 수신자는 "확인 불가" 로
 * 드러나고 체크박스가 잠긴다 — 이 팝업 스펙의 핵심은 그 구분이 화면에 보이는지다.
 */
import type { Locator, Page } from '@playwright/test';

export class ReceiptsPage {
  constructor(readonly page: Page) {}

  get modal(): Locator {
    return this.page.locator('.modal-backdrop .modal');
  }

  get detailGrid(): Locator {
    return this.modal.locator('table.grid');
  }

  detailRow(recipient: string): Locator {
    return this.detailGrid.locator('tbody tr', { hasText: recipient }).first();
  }

  detailCheckbox(recipient: string): Locator {
    return this.detailRow(recipient).locator('input[type="checkbox"]');
  }

  get recallButton(): Locator {
    return this.modal.getByRole('button', { name: 'Recall', exact: true });
  }

  get recallAllButton(): Locator {
    return this.modal.getByRole('button', { name: 'Recall all' });
  }

  get modalMessage(): Locator {
    return this.modal.locator('.info, .error');
  }
}
