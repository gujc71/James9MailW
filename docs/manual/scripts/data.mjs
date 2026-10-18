// 매뉴얼 그림에 들어가는 샘플 데이터 (언어별). seed · cleanup · cap-* 가 함께 쓴다.
const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join('');

export const DATA = {
  ko: {
    names: { admin: '관리자', user1: '사용자1', user2: '사용자2', user3: '사용자3' },
    notice: {
      subject: '[공지] 10월 시스템 정기 점검 안내',
      html: p('안녕하세요, 시스템 관리자입니다.', '10월 정기 점검이 아래와 같이 진행됩니다.',
        '<b>일시</b> : 10월 12일(일) 02:00 ~ 06:00', '<b>영향</b> : 점검 시간 동안 웹메일 접속이 일시 중단됩니다.',
        '이용에 참고 부탁드립니다.'),
    },
    q3: {
      subject: '3분기 영업 실적 자료 검토 부탁드립니다',
      key: '3분기',
      html: p('사용자1님, 안녕하세요.', '3분기 영업 실적 자료를 첨부합니다.', '금요일까지 검토 의견 주시면 반영하겠습니다.', '감사합니다.<br>사용자2 드림'),
      file: '3분기_영업실적.csv',
      csv: '﻿구분,7월,8월,9월,합계\n국내,1200,1350,1410,3960\n해외,830,910,1020,2760\n합계,2030,2260,2430,6720\n',
    },
    kickoff: {
      subject: '신규 프로젝트 킥오프 일정 협의',
      key: '킥오프 일정 협의',
      html: p('사용자2님, 안녕하세요.', '신규 프로젝트 킥오프 회의 일정을 정하려고 합니다.',
        '다음 주 화요일 또는 수요일 오후 중 가능한 시간을 알려 주세요.', '사용자1 드림'),
      replies: [
        p('사용자1님,', '수요일 오후 2시가 좋겠습니다. 회의실은 제가 예약해 두겠습니다.', '사용자2 드림'),
        p('네, 수요일 오후 2시로 하겠습니다. 안건은 제가 정리해서 공유드릴게요.', '사용자1 드림')
          + '<blockquote>수요일 오후 2시가 좋겠습니다. 회의실은 제가 예약해 두겠습니다.</blockquote>',
        p('좋습니다. 대회의실로 예약 완료했습니다.', '사용자2 드림')
          + '<blockquote>네, 수요일 오후 2시로 하겠습니다. 안건은 제가 정리해서 공유드릴게요.</blockquote>',
      ],
    },
    review: {
      subject: '디자인 리뷰 회의',
      key: '디자인 리뷰',
      location: '본사 3층 대회의실',
      description: '신규 화면 시안 리뷰',
      html: p('디자인 리뷰 회의에 초대합니다.', '참석 여부를 알려 주세요.'),
    },
    news: {
      subject: '사내 소식지 10월호',
      key: '소식지',
      html: '<div style="font-family:sans-serif"><h2 style="color:#4f46e5">사내 소식지 10월호</h2>'
        + '<img src="https://picsum.photos/600/200" alt="배너" width="600" height="200">'
        + p('이번 호에서는 하반기 워크숍 소식과 신규 입사자를 소개합니다.', '많은 관심 부탁드립니다.') + '</div>',
    },
    lunch: {
      subject: '점심 메뉴 추천 받습니다',
      key: '점심',
      html: p('오늘 점심 같이 하실 분? 회사 앞 국수집 어떠세요?'),
    },
    acceptedPrefix: '수락: ',
    // 캡처 중 입력하는 값
    searchWord: '프로젝트',
    suggestTyping: '관리',
    compose: {
      subject: '10월 주간 업무 보고',
      body: ['팀장님, 10월 첫째 주 업무 보고 드립니다.', '1. 신규 프로젝트 킥오프 준비', '3분기 실적 자료 검토'],
      apptLocation: '본사 2층 소회의실',
      apptDescription: '주간 업무 공유',
    },
    calendar: {
      event: '주간 팀 회의',
      location: '본사 2층 소회의실',
      tasks: ['3분기 보고서 작성', '킥오프 안건 정리', '디자인 시안 피드백'],
    },
  },

  en: {
    names: { admin: 'Admin', user1: 'User 1', user2: 'User 2', user3: 'User 3' },
    notice: {
      subject: '[Notice] Scheduled maintenance in October',
      html: p('Hello, this is the system administrator.', 'Scheduled maintenance will take place as follows.',
        '<b>When</b>: Sunday, October 12, 02:00 – 06:00', '<b>Impact</b>: Webmail will be unavailable during the maintenance window.',
        'Thank you for your understanding.'),
    },
    q3: {
      subject: 'Please review the Q3 sales report',
      key: 'Q3 sales',
      html: p('Hi User 1,', 'Attached is the Q3 sales report.', 'Please send me your comments by Friday.', 'Thanks,<br>User 2'),
      file: 'Q3_sales_report.csv',
      csv: 'Region,Jul,Aug,Sep,Total\nDomestic,1200,1350,1410,3960\nOverseas,830,910,1020,2760\nTotal,2030,2260,2430,6720\n',
    },
    kickoff: {
      subject: 'Scheduling the new project kickoff',
      key: 'project kickoff',
      html: p('Hi User 2,', 'I would like to schedule the kickoff meeting for the new project.',
        'Could you let me know if Tuesday or Wednesday afternoon next week works for you?', 'Best,<br>User 1'),
      replies: [
        p('Hi User 1,', 'Wednesday at 2 PM works for me. I will book a meeting room.', 'User 2'),
        p('Great, Wednesday at 2 PM it is. I will prepare the agenda and share it.', 'User 1')
          + '<blockquote>Wednesday at 2 PM works for me. I will book a meeting room.</blockquote>',
        p('Perfect. The large conference room is booked.', 'User 2')
          + '<blockquote>Great, Wednesday at 2 PM it is. I will prepare the agenda and share it.</blockquote>',
      ],
    },
    review: {
      subject: 'Design review meeting',
      key: 'Design review',
      location: 'HQ 3F, large conference room',
      description: 'Review of the new screen mockups',
      html: p('You are invited to the design review meeting.', 'Please let me know if you can attend.'),
    },
    news: {
      subject: 'Company newsletter – October',
      key: 'newsletter',
      html: '<div style="font-family:sans-serif"><h2 style="color:#4f46e5">Company newsletter – October</h2>'
        + '<img src="https://picsum.photos/600/200" alt="Banner" width="600" height="200">'
        + p('This issue covers the second-half workshop and introduces our new colleagues.', 'Enjoy!') + '</div>',
    },
    lunch: {
      subject: 'Lunch suggestions?',
      key: 'Lunch',
      html: p('Anyone up for lunch today? How about the noodle place across the street?'),
    },
    acceptedPrefix: 'Accepted: ',
    searchWord: 'project',
    suggestTyping: 'Adm',
    compose: {
      subject: 'Weekly report – first week of October',
      body: ['Hi, here is my report for the first week of October.', '1. Preparing the new project kickoff', 'Reviewing the Q3 sales report'],
      apptLocation: 'HQ 2F, small meeting room',
      apptDescription: 'Weekly status update',
    },
    calendar: {
      event: 'Weekly team meeting',
      location: 'HQ 2F, small meeting room',
      tasks: ['Write the Q3 report', 'Prepare the kickoff agenda', 'Send feedback on the design mockups'],
    },
  },
};
