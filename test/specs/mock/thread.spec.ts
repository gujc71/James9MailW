/**
 * 대화로 묶어 보기 (feature-gap 2-2 — thread.ts, MessageList.tsx, App.tsx).
 *
 * 묶는 기준은 서버가 내려준 threadId 하나다. 그래서 여기서 보는 것은 "그래프를 제대로
 * 풀었는가" 가 아니라 **같은 threadId 가 한 줄로 접히고, 펼치면 다 나오고, 접힌 줄 하나를
 * 건드리면 대화 전체가 함께 움직이는가** 다.
 *
 * 제목은 서로 부분 문자열이 되지 않게 골랐다 — 행을 집는 필터가 부분 일치라서, 제목이
 * 겹치면 "없어졌는지" 를 묻는 단정이 조용히 거짓 통과한다.
 */
import { expect, test } from '../../fixtures';
import { BOX, makeMessage } from '../../fixtures/factories';
import { ownSignatureEml, replyChainEml, simpleEml, TINY_PNG } from '../../fixtures/eml';
import { MailboxPage } from '../../pages/MailboxPage';
import { ConversationPage } from '../../pages/ConversationPage';
import { ReadingPage } from '../../pages/ReadingPage';

/** 세 통이 한 대화, 나머지 둘은 따로. 대화 안에 안 읽은 메일과 첨부를 하나씩 남겨 둔다 */
const THREAD = '<budget-root@example.com>';
/** 접힌 대화의 대표행 = 최근순 정렬에서 가장 앞선 메일 */
const HEAD = 'Budget final numbers';

test.beforeEach(async ({ state }) => {
  state.messages = [
    makeMessage({ uid: 1, subject: 'Budget kickoff', threadId: THREAD, seen: true, receivedAt: '2026-09-20T09:00:00.000Z' }),
    makeMessage({ uid: 2, subject: 'Budget follow-up', threadId: THREAD, seen: false, receivedAt: '2026-09-21T09:00:00.000Z' }),
    makeMessage({ uid: 3, subject: HEAD, threadId: THREAD, seen: true, hasAttachment: true, receivedAt: '2026-09-22T09:00:00.000Z' }),
    makeMessage({ uid: 4, subject: 'Lunch?', seen: true, receivedAt: '2026-09-23T09:00:00.000Z' }),
    makeMessage({ uid: 5, subject: 'Standalone note', seen: true, receivedAt: '2026-09-19T09:00:00.000Z' }),
  ];
});

test('묶지 않으면 대화의 메일이 각각 한 줄로 나온다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  await list.expectRow('Budget kickoff');
  await list.expectRow('Budget follow-up');
  await list.expectRow(HEAD);
  await expect(list.threadChildren).toHaveCount(0);
});

test('묶지 않아도 두 통 이상인 대화는 줄마다 통수를 보여 준다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();

  // 접지 않았으니 세 줄 모두에 "3" 이 붙는다. 안 읽은 통수는 숨은 메일이 없어 적지 않는다
  await expect(list.threadCount(HEAD)).toHaveText('3');
  await expect(list.threadCount('Budget kickoff')).toHaveText('3');
  await expect(list.threadCount('Budget follow-up')).toHaveText('3');
  // 한 통짜리에는 여전히 배지가 없다
  await expect(list.row('Lunch?').locator('.thread-count')).toHaveCount(0);
  await expect(list.row('Standalone note').locator('.thread-count')).toHaveCount(0);
});

test('묶으면 대화가 한 줄로 접히고 통수가 보인다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  await list.expectRow(HEAD);
  await list.expectNoRow('Budget kickoff');
  await list.expectNoRow('Budget follow-up');
  // 세 통 중 한 통이 안 읽음이라 "3 (1)" 이다
  await expect(list.threadCount(HEAD)).toHaveText('3 (1)');
  // 대화가 아닌 메일에는 배지가 없다
  await expect(list.row('Lunch?').locator('.thread-count')).toHaveCount(0);
});

test('안 읽은 메일이 대화 안에 있으면 접힌 줄이 안읽음으로 보인다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  // 대표행 자체는 읽은 메일인데, 대화 안에 안 읽은 답장이 남아 있다
  await expect(list.row(HEAD)).toHaveClass(/unseen/);
  await expect(list.row('Lunch?')).not.toHaveClass(/unseen/);
});

test('대화 안에 첨부가 있으면 접힌 줄에 표시가 남는다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  await expect(list.row(HEAD).locator('.clip')).toBeVisible();
});

test('펼치면 대화의 나머지 메일이 들여쓰여 나오고, 다시 접으면 사라진다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  await list.expandThread(HEAD);
  await expect(list.threadChildren).toHaveCount(2);
  await list.expectRow('Budget follow-up');
  await list.expectRow('Budget kickoff');

  await list.expandThread(HEAD);
  await expect(list.threadChildren).toHaveCount(0);
});

test('접힌 줄을 체크하면 대화의 메일이 모두 선택된다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  await list.rowCheckbox(HEAD).check();

  // 선택 수는 "More ▾ (n)" 라벨에 실린다 — 대표행 하나가 아니라 세 통이어야 한다
  await expect(list.bulkMenuButton).toContainText('(3)');
});

test('접힌 대화를 지우면 대화의 메일이 함께 지워진다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  await list.rowCheckbox(HEAD).check();
  await list.bulkAction('Delete');

  await list.expectNoRow(HEAD);
  await list.expectNoRow('Budget follow-up');
  await list.expectNoRow('Budget kickoff');
  // 대화가 아닌 메일은 남아 있다
  await list.expectRow('Lunch?');
});

test('메일을 열어도 대화는 펼쳐지지 않는다 — 펼치는 것은 삼각형뿐이다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  const reading = new ReadingPage(page);
  await shell.open();
  await list.toggleThreadView();

  await list.open(HEAD);

  // 메일은 열렸지만 목록의 줄 수는 그대로다
  await expect(reading.subject).toHaveText(HEAD);
  await expect(list.threadChildren).toHaveCount(0);

  // 삼각형을 누르면 그때 펼쳐진다
  await list.expandThread(HEAD);
  await expect(list.threadChildren).toHaveCount(2);
});

test('묶어 보기 토글은 새로 고쳐도 유지된다', async ({ shell, page }) => {
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();
  await expect(list.threadCount(HEAD)).toBeVisible();

  await page.reload();

  await expect(new MailboxPage(page).threadCount(HEAD)).toBeVisible();
});

test('보낸 편지함에서도 대화로 묶인다', async ({ shell, page, state }) => {
  state.messages = [
    makeMessage({ uid: 10, mailboxId: BOX.sent, subject: 'Budget reply out', threadId: THREAD, to: 'boss@example.com', toDisplay: 'Boss', receivedAt: '2026-09-22T09:00:00.000Z' }),
    makeMessage({ uid: 11, mailboxId: BOX.sent, subject: 'Budget kickoff', threadId: THREAD, to: 'boss@example.com', toDisplay: 'Boss', receivedAt: '2026-09-20T09:00:00.000Z' }),
  ];
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();
  await shell.selectMailbox('Sent');

  await expect(list.threadCount('Budget reply out')).toHaveText('2');
});

test('threadId 가 없는 옛 메일은 각각 한 통짜리 대화로 남는다', async ({ shell, page, state }) => {
  state.messages = [
    makeMessage({ uid: 20, subject: 'Legacy one', threadId: null, seen: true, receivedAt: '2026-09-22T09:00:00.000Z' }),
    makeMessage({ uid: 21, subject: 'Legacy two', threadId: null, seen: true, receivedAt: '2026-09-21T09:00:00.000Z' }),
  ];
  const list = new MailboxPage(page);
  await shell.open();
  await list.toggleThreadView();

  await list.expectRow('Legacy one');
  await list.expectRow('Legacy two');
  await expect(list.list.locator('.thread-count')).toHaveCount(0);
});

/**
 * 통수 배지를 눌러 보는 **대화 내용** (ConversationPane.tsx + conversation.ts).
 *
 * 대화의 마지막 메일 원문 하나를 파싱해 주고받은 메일을 발송자 · 시간 · 본문으로 되돌린다.
 * 그래서 입력은 목록이 아니라 원문이다 — fixtures/eml.ts 의 replyChainEml 이 세 겹 인용된
 * 메일을 만든다. 편지함에는 세 통이 있고 그 중 마지막 한 통 안에 대화가 통째로 들어 있다.
 */
const CHAIN = 'Re: Re: Re: aaaaaaaaaa';

test.describe('대화 내용 보기', () => {
  test.beforeEach(async ({ state }) => {
    state.messages = [
      makeMessage({ uid: 31, subject: 'aaaaaaaaaa', threadId: THREAD, seen: true, receivedAt: '2026-09-30T12:35:00.000Z' }),
      // 크기순으로 세우면 대표행이 되는 메일. 대화의 끝이 아니라서 파싱 대상이 아니다
      makeMessage({ uid: 32, subject: 'Re: aaaaaaaaaa', threadId: THREAD, seen: true, size: 99_000, receivedAt: '2026-10-02T12:22:00.000Z' }),
      makeMessage({ uid: 33, subject: CHAIN, threadId: THREAD, seen: true, receivedAt: '2026-10-02T12:30:40.000Z' }),
    ];
    state.raw.set(`${BOX.inbox}:33`, replyChainEml());
  });

  test('배지를 누르면 원문에서 주고받은 메일 넷을 시간 순서로 늘어놓는다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    await expect(conv.items).toHaveCount(4);
    // 메신저처럼 **오래된 것이 위**다. 맨 아래가 이 메일 자신(From · Date 헤더)이다
    await expect(conv.who(0)).toHaveText('관리자');
    await expect(conv.when(0)).toHaveText('2026-09-30 21:35');
    await expect(conv.body(0)).toHaveText('aaaaaaaaaaaaaaaaaaaa');

    await expect(conv.who(1)).toHaveText('테스트');
    await expect(conv.when(1)).toHaveText('2026-10-02 21:22');
    await expect(conv.body(1)).toHaveText('sssssssssss');

    await expect(conv.who(2)).toHaveText('관리자');
    // 영문 머리말의 'On' 은 날짜가 아니라 문장 조각이라 떼어 낸다
    await expect(conv.when(2)).toHaveText('2026-10-02 21:23');
    await expect(conv.body(2)).toHaveText('cccccccccccc');

    await expect(conv.who(3)).toHaveText('테스트');
    await expect(conv.when(3)).toHaveText('2026-10-02 21:30');
    await expect(conv.body(3)).toHaveText('eeeeeeeeeeeeee');
  });

  test('남이 보낸 메일은 왼쪽, 내가 보낸 메일은 오른쪽에 선다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    // 계정은 user1@example.com(테스트) 이다 — 그 두 통만 내 쪽(오른쪽)이다
    await expect(conv.ownItems).toHaveCount(2);
    await expect(conv.item(0)).not.toHaveClass(/own/);
    await expect(conv.item(1)).toHaveClass(/own/);
    await expect(conv.item(2)).not.toHaveClass(/own/);
    await expect(conv.item(3)).toHaveClass(/own/);

    // 줄이 실제로 반대쪽에 서 있는지 — 가운데를 기준으로 가른다. class 만 보면 CSS 한 줄이
    // 바뀌어 두 줄이 같은 쪽에 서 버려도 조용히 통과한다
    const pane = (await conv.pane.boundingBox())!;
    const mid = pane.x + pane.width / 2;
    const center = async (index: number) => {
      const box = (await conv.item(index).boundingBox())!;
      return box.x + box.width / 2;
    };
    expect(await center(0)).toBeLessThan(mid);
    expect(await center(1)).toBeGreaterThan(mid);
  });

  test('보낸사람 사진이 있으면 말풍선 옆에 사진으로 선다', async ({ shell, page, state }) => {
    // 사진은 인용문에 없다. 같은 대화의 메일(목록이 아바타에 쓰는 값)에서 가져온다.
    // **실제로 뜨는 그림**이어야 한다 — 404 가 나면 화면이 이름 첫 글자로 되돌리므로
    // (목록과 같은 처리) 사진을 찾았는지 못 찾았는지가 구분되지 않는다
    const photo = `data:image/png;base64,${TINY_PNG}`;
    state.messages = state.messages.map((message) =>
      message.uid === 31 ? { ...message, from: 'admin@example.com', fromPhoto: photo } : message,
    );
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    // 관리자가 보낸 줄에는 사진이 선다
    await expect(conv.avatar(0)).toHaveAttribute('src', photo);
    // 내가 보낸 줄에는 사진도 글자 아바타도 없다 — 오른쪽에 선 것이 이미 나라는 표시다
    await expect(conv.avatar(1)).toHaveCount(0);
  });

  test('구분선 아래 서명은 아예 보여 주지 않는다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    // 본문은 그대로 서고, 서명은 화면 어디에도 없다 (본문으로 새어 들어와도 여기서 걸린다)
    await expect(conv.body(0)).toHaveText('aaaaaaaaaaaaaaaaaaaa');
    await expect(conv.body(2)).toHaveText('cccccccccccc');
    await expect(conv.pane).not.toContainText('signature-oldest');
    await expect(conv.pane).not.toContainText('signature-middle');
  });

  test('우리가 보낸 메일의 서명은 구분선이 없어도 빠진다', async ({ shell, page, state }) => {
    // 우리 서버는 서명을 div.j9-signature 로 감싸 본문 끝에 붙인다. 구분선은 없다
    state.raw.set(`${BOX.inbox}:33`, ownSignatureEml());
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    await expect(conv.items).toHaveCount(2);
    await expect(conv.body(0)).toHaveText('물어본 내용');
    await expect(conv.body(1)).toHaveText('답장 한 줄');
    await expect(conv.pane).not.toContainText('홍길동 드림');
    await expect(conv.pane).not.toContainText('02-000-0000');
  });

  test('인용된 시각은 헤더에서 읽은 시각과 구분해 보여 준다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    // 마지막 한 통만 Date 헤더라 정확하고, 그 앞은 인용문에 적힌 표기일 뿐이다
    await expect(conv.when(3)).not.toHaveClass(/quoted/);
    await expect(conv.when(2)).toHaveClass(/quoted/);
  });

  test('묶지 않고 보는 중에도 배지로 대화 내용을 열 수 있다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    // 묶기를 켜지 않은 평평한 목록. 배지는 두 통 이상인 대화면 줄마다 붙는다
    await list.openConversation(CHAIN);

    await expect(conv.items).toHaveCount(4);
  });

  test('크기순으로 세워 대표행이 바뀌어도 대화의 마지막 메일을 파싱한다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();
    await list.toggleThreadView();
    await list.sortBy('Size');

    // 대표행은 가장 큰 메일(Re: aaaaaaaaaa)이지만, 대화 내용은 마지막 메일에서 나온다
    await list.openConversation('Re: aaaaaaaaaa');

    await expect(conv.items).toHaveCount(4);
    await expect(conv.body(3)).toHaveText('eeeeeeeeeeeeee');
  });

  test('메일을 열면 대화 내용이 닫히고, 대화 내용에서 마지막 메일을 열 수 있다', async ({ shell, page }) => {
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    const reading = new ReadingPage(page);
    await shell.open();

    await list.openConversation(CHAIN);
    await expect(conv.pane).toBeVisible();

    await conv.openLastButton.click();
    await expect(conv.pane).toHaveCount(0);
    // 제목 줄은 두 화면이 같은 class 를 쓴다. 메일을 열었는지는 보낸사람 · 받는사람 상자로 가린다
    await expect(reading.meta).toBeVisible();
    await expect(reading.subject).toHaveText(CHAIN);

    // 다시 배지를 누르면 열려 있던 메일 대신 대화 내용이 선다
    await list.openConversation(CHAIN);
    await expect(conv.pane).toBeVisible();
    await expect(reading.meta).toHaveCount(0);
  });

  test('긴 본문은 100자에서 자르고 가리키면 전문이 뜬다', async ({ shell, page, state }) => {
    // 102자 — 한 글자만 넘겨도 잘리는지 본다. 자리표시가 아니라 길이가 기준이다
    const long = 'ㄱ'.repeat(60) + 'ㄴ'.repeat(42);
    state.raw.set(`${BOX.inbox}:33`, simpleEml({ subject: CHAIN, html: `<p>${long}</p>` }));
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    await expect(conv.body(0)).toHaveText(`${long.slice(0, 100)}…`);
    // 전문은 풍선도움말에 들어 있다
    await expect(conv.body(0)).toHaveAttribute('title', long);
  });

  test('짧은 본문에는 풍선도움말을 달지 않는다', async ({ shell, page, state }) => {
    // 100자까지는 그대로 선다 — 보이는 글자가 또 뜨는 풍선은 방해만 된다
    const exact = 'ㄱ'.repeat(100);
    state.raw.set(`${BOX.inbox}:33`, simpleEml({ subject: CHAIN, html: `<p>${exact}</p>` }));
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    await expect(conv.body(0)).toHaveText(exact);
    await expect(conv.body(0)).not.toHaveAttribute('title', /./);
  });

  test('인용이 없는 메일은 한 덩이만 나오고 그렇다고 알려 준다', async ({ shell, page, state }) => {
    state.raw.set(`${BOX.inbox}:33`, simpleEml({ subject: CHAIN, text: 'no quote here' }));
    const list = new MailboxPage(page);
    const conv = new ConversationPage(page);
    await shell.open();

    await list.openConversation(CHAIN);

    await expect(conv.items).toHaveCount(1);
    await expect(conv.pane).toContainText('quotes no earlier mail');
  });
});
