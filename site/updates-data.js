/*
 * TalkBridge 업데이트 소식 — updates.html 이 읽는 데이터.
 *
 * 싣는 기준: 파트너가 알아야 하는 공개 계약의 추가·변경 (API · 웹훅 · CLI · MCP).
 * 싣지 않는 것: 보안 패치 · 안정성 · 인프라 · 어드민 같은 내부 개선, 미공개 채널·제품.
 * 새 운영 반영이 생기면 맨 위에 release 하나를 추가한다. version = 운영 서버 릴리스 번호.
 *
 * area: api | webhook | cli | mcp
 * docs.href 는 api.talkbridge.io 의 경로. EN 은 /en 접두가 붙고 #앵커는 docs.anchorEn 이 있을 때만 쓴다.
 */
window.TB_UPDATES = [
  {
    version: 'v1.6.0',
    date: '2026-10-30',
    title: { ko: '권한별 Agent Key · 멀티브랜드 관리 API', en: 'Scoped Agent Keys · multi-brand Manage API' },
    items: [
      {
        area: 'api',
        title: { ko: '권한을 골라 만드는 Agent Key', en: 'Agent Keys with chosen permissions' },
        desc: {
          ko: '키를 만들 때 권한을 고릅니다. <b>1개 브랜드</b> 읽기·쓰기, <b>전체 브랜드</b> 읽기·쓰기(나중에 만드는 브랜드 포함), 그리고 상담 없이 연동 설정만 다루는 <b>관리 전용</b>까지 다섯 가지입니다. 조회만 하는 통합에는 읽기 키를 쓰세요.',
          en: 'Choose the permission when you create a key: <b>one brand</b> read or write, <b>all brands</b> read or write (including brands created later), or <b>management only</b> for setup without consultation access — five in total. Use a read key for read-only integrations.'
        },
        code: ['BrandRead · BrandWrite', 'TenantRead · Admin', 'TenantManage'],
        docs: [{ href: '/authentication/#권한-스코프', anchorEn: '#permission-scopes' }]
      },
      {
        area: 'api',
        title: { ko: '관리 API — 여러 브랜드의 연동을 자동화', en: 'Manage API — automate setup across brands' },
        desc: {
          ko: '관리 전용 키 하나로 계정의 모든 브랜드를 다룹니다. 브랜드 조회·생성, 게이트웨이 키 연결·웹훅 등록·켜기, 상담톡 켜기·끄기, <b>상담시간</b>(카카오톡 상담톡), 상담 시작 문구를 API 로 설정합니다. 센터에서 하던 연동 설정을 시스템에서 반복할 때 씁니다.',
          en: 'One management-only key covers every brand in the account: list and create brands, connect the gateway key, register the webhook and turn it on, turn consultations on or off, set <b>consultation hours</b> (KakaoTalk), and manage the start message. Use it to repeat Center setup from your own systems.'
        },
        code: ['GET /api/manage/me', 'GET · POST /api/manage/brands', 'GET · POST /api/manage/channels/{channelId}/schedule'],
        docs: [{ href: '/api/manage/' }, { href: '/api/manage/#schedule', anchorEn: '#schedule', label: { ko: '상담시간', en: 'Hours' } }]
      }
    ]
  },
  {
    version: 'v1.5.4',
    date: '2026-10-26',
    title: { ko: '고객 메시지 읽음 처리 · 상담 시작 문구', en: 'Read receipts · consultation start message' },
    items: [
      {
        area: 'api',
        title: { ko: '고객 메시지 읽음 처리', en: 'Mark customer messages as read' },
        desc: {
          ko: '답장하기 전에 고객 채팅방의 숫자 <b>‘1’</b> 을 지웁니다. 상담 대기가 길어질 때 “확인했어요” 신호로 씁니다. 답장을 보내면 자동으로 읽음이 되고, 상담 건수에는 포함되지 않습니다.',
          en: 'Clears the <b>“1”</b> unread mark in the customer’s chat room before you reply — a “we’ve seen it” signal while the customer waits. Sending a reply marks messages read automatically, and the call does not count toward consultations.'
        },
        code: ['POST /api/agent/read'],
        docs: [{ href: '/api/outbound/#고객-메시지-읽음-처리' }]
      },
      {
        area: 'api',
        title: { ko: '상담 시작 문구 API', en: 'Consultation start message API' },
        desc: {
          ko: '상담이 시작될 때 나가는 안내문에 <b>브랜드 소개 문구</b>를 넣습니다. 신청하면 카카오 검수 요청까지 한 번에 진행되고, 승인 전에는 수정·삭제할 수 있습니다. 채널당 하루 5회.',
          en: 'Adds your <b>brand introduction</b> to the notice sent when a consultation starts. Submitting also files the Kakao review in one step; you can edit or delete it until it is approved. 5 changes per channel per day.'
        },
        code: ['GET /api/agent/sysmsg/start', 'POST /api/agent/sysmsg/start', 'POST /api/agent/sysmsg/start/delete'],
        docs: [{ href: '/api/settings/#start-message', anchorEn: '#start-message' }]
      }
    ]
  },
  {
    version: 'v1.5.1',
    date: '2026-10-13',
    title: { ko: '일반 사진 말풍선', en: 'Plain photo bubbles' },
    items: [
      {
        area: 'api',
        title: { ko: '이미지를 일반 사진 말풍선으로 발신', en: 'Send images as plain photo bubbles' },
        desc: {
          ko: '고객이 보낸 사진과 같은 모양의 말풍선으로 보냅니다. 탭하면 <b>원본 크기</b>로 열려 시안·인쇄 사진처럼 크게 봐야 하는 이미지에 맞습니다. 비율 제약이 없고, 5MB 를 넘으면 서버가 줄여서 보냅니다.',
          en: 'Sends images in the same bubble style customers use. Tapping opens the <b>full-size</b> image — ideal for drafts or print proofs. No aspect-ratio limits; images over 5MB are downscaled by the server.'
        },
        code: ['POST /api/agent/send/attachments  imageStyle=plain', 'POST /api/agent/upload/image  imageType=plain', 'POST /api/agent/send/image'],
        docs: [{ href: '/api/outbound/#첨부-발신' }]
      },
      {
        area: 'api',
        title: { ko: '이미지 형식·용량 사전 검증', en: 'Up-front image validation' },
        desc: {
          ko: '이미지는 <b>jpg·png·gif</b> 만 이미지 말풍선으로 보냅니다. 확장자만 바꾼 파일, 5MB 초과, 카카오에 올리지 않은 외부 주소는 카카오에 보내기 전에 이유가 담긴 코드로 거절합니다.',
          en: 'Only <b>jpg · png · gif</b> go out as image bubbles. Renamed or corrupted files, oversized images and external URLs are rejected before reaching Kakao, with a specific error code.'
        },
        code: ['400 UNSUPPORTED_IMAGE', '413 IMAGE_TOO_LARGE', '400 BAD_URL'],
        docs: [{ href: '/api/errors/' }]
      }
    ]
  },
  {
    version: 'v1.4.9',
    date: '2026-10-07',
    title: { ko: '개인정보 제공 동의 요청', en: 'Personal info consent request' },
    items: [
      {
        area: 'api',
        title: { ko: '개인정보 제공 동의 요청 발신', en: 'Request personal info consent' },
        desc: {
          ko: '고객에게 카카오 <b>개인정보 제공 동의</b> 말풍선을 보냅니다. 고객이 동의하면 닉네임·전화번호를 받을 수 있습니다. 상담 세션당 1회, 동의는 발송 후 3일 안에만 유효합니다.',
          en: 'Sends Kakao’s <b>personal info consent</b> bubble. When the customer agrees you receive their nickname and phone number. Once per consultation session; consent is valid for 3 days after sending.'
        },
        code: ['POST /api/agent/personal-info/request'],
        docs: [{ href: '/api/outbound/#개인정보-제공-동의-요청' }]
      },
      {
        area: 'webhook',
        title: { ko: '동의 결과 웹훅 personal_info', en: 'Consent result webhook: personal_info' },
        desc: {
          ko: '동의 결과는 응답이 아니라 웹훅으로 옵니다. TalkBridge 는 이 값을 <b>저장하지 않고 한 번만 전달</b>하므로, 요청 전에 웹훅을 연결해 두고 받은 즉시 보관하세요. <code>seq</code> 가 없어 <code>X-Bridge-Delivery-Id</code> 로 중복을 거릅니다.',
          en: 'The result arrives by webhook, not in the response. TalkBridge <b>forwards it once without storing it</b> — connect your webhook first and persist it on receipt. It has no <code>seq</code>; dedupe on <code>X-Bridge-Delivery-Id</code>.'
        },
        code: ['kind: "personal_info"', 'personalInfo.phoneNumber · personalInfo.nickname'],
        docs: [{ href: '/webhooks/payload/#개인정보-제공-동의-personal_info' }]
      },
      {
        area: 'cli',
        title: { ko: 'CLI · MCP 에서도 같은 요청', en: 'Same request from CLI and MCP' },
        desc: {
          ko: '터미널에서는 <code>personal-info</code> 명령으로, AI 앱에서는 MCP 도구 <code>request_personal_info</code> 로 같은 말풍선을 보냅니다.',
          en: 'Send the same bubble with the <code>personal-info</code> command in the terminal, or the <code>request_personal_info</code> MCP tool from AI apps.'
        },
        code: ['talkbridge personal-info --channel <키> --to <userKey>'],
        docs: [{ href: '/cli/commands/' }, { href: '/mcp/usage/', label: { ko: 'MCP', en: 'MCP' } }],
        alsoArea: 'mcp'
      }
    ]
  },
  {
    version: 'v1.4.5',
    date: '2026-10-02',
    title: { ko: '상담 건수는 발송 성공 후 차감', en: 'Quota is used only after successful delivery' },
    items: [
      {
        area: 'api',
        title: { ko: '전송되지 않은 발신은 차감하지 않습니다', en: 'Undelivered sends are not charged' },
        desc: {
          ko: '상담사 발신의 상담 건수가 <b>카카오 발송 성공 뒤</b>에 차감됩니다. <code>ok: false</code> 로 끝난 발신은 건수를 쓰지 않으며, 실패 코드와 대응 방법을 문서에 정리했습니다. 전송 여부를 확인할 수 없는 <code>EXCEPTION</code> 은 차감될 수 있습니다.',
          en: 'Agent sends now use quota <b>after Kakao confirms delivery</b>. A send that ends with <code>ok: false</code> is not charged, and failure codes with fixes are now documented. <code>EXCEPTION</code> (delivery unknown) may still be charged.'
        },
        docs: [{ href: '/api/errors/' }, { href: '/center/billing/', label: { ko: '과금', en: 'Billing' } }]
      }
    ]
  },
  {
    version: 'v1.4.3',
    date: '2026-09-30',
    title: { ko: '발신 취소 알림', en: 'Delete notifications' },
    items: [
      {
        area: 'webhook',
        title: { ko: '메시지 삭제 웹훅 deleted', en: 'Message deletion webhook: deleted' },
        desc: {
          ko: '발신 취소가 성공하면 지운 말풍선의 <code>serial</code> 이 담긴 신호가 옵니다. 삭제를 요청하지 않은 쪽(같은 브랜드의 다른 상담 도구)도 이 신호로 화면을 맞출 수 있습니다. 대화 조회에도 삭제된 메시지가 표시되고, 실패 시 이유를 문장으로 돌려줍니다.',
          en: 'A successful delete emits a signal with the deleted bubble’s <code>serial</code>, so other tools on the same brand can update their screens too. Conversation queries now show deleted messages, and failures return a readable reason.'
        },
        code: ['kind: "deleted"', 'serial'],
        docs: [{ href: '/webhooks/payload/#메시지-삭제-deleted' }, { href: '/api/outbound/#발신-취소삭제', label: { ko: '발신 취소', en: 'Delete' } }]
      }
    ]
  },
  {
    version: 'v1.4.0 – v1.4.2',
    anchor: 'v1-4-0',
    date: '2026-09-29',
    title: { ko: '상담 연결 메타 · 묶음사진 · 상담 가능 채널', en: 'Connect metadata · photo bundles · available channels' },
    items: [
      {
        area: 'webhook',
        title: { ko: '상담 연결 메타 extra 전달', en: 'Connect metadata (extra) in webhooks' },
        desc: {
          ko: '상담 연결 링크·버튼이나 챗봇 전환에 심은 값(<code>extra</code>)이 웹훅 신호에 그대로 실립니다. 어떤 상품·페이지에서 상담이 시작됐는지 알고 담당자 라우팅에 쓸 수 있습니다.',
          en: 'Values you embed in consult links, buttons or chatbot handoffs (<code>extra</code>) now arrive in the webhook signal — know which product or page started the chat and route it.'
        },
        code: ['reference.extra', 'lastReference.{extra, bot, botEvent}', 'message.extra'],
        docs: [{ href: '/webhooks/connect-meta/' }]
      },
      {
        area: 'webhook',
        title: { ko: '묶음사진 수신', en: 'Photo bundles' },
        desc: {
          ko: '고객이 여러 장을 묶어 보낸 사진이 메시지 1건으로 오며, 본문에 <b>사진마다 한 줄씩</b> 담깁니다. 본문을 줄 단위로 나눠 읽어야 두 번째 장부터 빠지지 않습니다.',
          en: 'Multiple photos sent together arrive as one message with <b>one line per photo</b>. Split the body by line so you don’t miss photos after the first.'
        },
        code: ['[photo] https://talk.kakaocdn.net/…'],
        docs: [{ href: '/webhooks/content/#이미지--첨부' }]
      },
      {
        area: 'api',
        title: { ko: '상담 가능 채널 조회', en: 'Available channels in /me' },
        desc: {
          ko: '<code>GET /api/agent/me</code> 가 <code>channels</code> 로 키가 상담할 수 있는 채널의 이름·소속 브랜드를 함께 돌려줍니다. 요청의 <code>brandKey</code> 에는 <code>channels[].key</code> 를 넣습니다.',
          en: '<code>GET /api/agent/me</code> now returns <code>channels</code> with each available channel’s name and brand. Use <code>channels[].key</code> as the request <code>brandKey</code>.'
        },
        code: ['GET /api/agent/me  → channels[]'],
        docs: [{ href: '/authentication/' }]
      },
      {
        area: 'cli',
        title: { ko: 'CLI v1.2.0 — whoami 상담 가능 채널 · --channel', en: 'CLI v1.2.0 — whoami channels · --channel' },
        desc: {
          ko: '<code>whoami</code> 가 브랜드별 상담 가능 채널을 보여주고, 명령마다 <code>--channel</code> 로 채널을 지정합니다.',
          en: '<code>whoami</code> lists available channels per brand, and every command takes <code>--channel</code>.'
        },
        code: ['talkbridge whoami', 'talkbridge rooms --channel <키> --json'],
        docs: [{ href: '/cli/commands/' }]
      },
      {
        area: 'api',
        title: { ko: '빠른 답장 버튼 규격 명시', en: 'Quick reply limits documented' },
        desc: {
          ko: '리치 메시지의 <code>quick_replies</code> 는 한 메시지에 최대 10개, 버튼 이름 14자 등 필드별 길이와 종류를 문서에 정리했습니다.',
          en: 'Rich message <code>quick_replies</code>: up to 10 per message, 14-character names, plus per-field lengths and types are now documented.'
        },
        docs: [{ href: '/api/outbound/#quick-replies', anchorEn: '#quick-replies' }]
      }
    ]
  },
  {
    version: 'CLI v1.1.0',
    anchor: 'cli-v1-1-0',
    date: '2026-09-09',
    title: { ko: '발신 취소 · 대화 이력 공개, CLI --json', en: 'Delete & conversation history APIs, CLI --json' },
    items: [
      {
        area: 'api',
        title: { ko: '발신 취소 · 대화 이력 API 공개', en: 'Delete and conversation history APIs' },
        desc: {
          ko: '보낸 메시지를 <b>발송 후 24시간 안에</b> 말풍선 단위로 지우는 발신 취소와, 상담 단위 대화 이력 조회를 공개 API 로 열었습니다. 리치 메시지 스키마와 첨부 발신도 문서화했습니다.',
          en: 'Opened delete (per bubble, <b>within 24 hours</b> of sending) and per-consultation conversation history as public APIs, and documented the rich message schema and attachment sending.'
        },
        code: ['POST /api/agent/delete', 'GET /api/agent/conversations', 'GET /api/agent/conversation?convId=…', 'POST /api/agent/send/attachments'],
        docs: [{ href: '/api/outbound/#발신-취소삭제' }, { href: '/webhooks/content/#대화-이력-convid', label: { ko: '대화 이력', en: 'History' } }]
      },
      {
        area: 'webhook',
        title: { ko: '발신 접수 신호 phase · serial', en: 'Send acknowledgment: phase · serial' },
        desc: {
          ko: '발신 직후 오는 <code>agent</code> 접수 신호에 <code>phase: "accepted"</code> 와 발신 응답과 같은 <code>serial</code> 이 실려, 화면에 먼저 그린 말풍선과 정확히 맞출 수 있습니다.',
          en: 'The <code>agent</code> acknowledgment right after sending carries <code>phase: "accepted"</code> and the same <code>serial</code> as the send response, so you can match optimistic bubbles exactly.'
        },
        code: ['kind: "agent", phase: "accepted", serial'],
        docs: [{ href: '/webhooks/payload/' }]
      },
      {
        area: 'cli',
        title: { ko: 'CLI 전역 --json · 프로그램 호출', en: 'CLI global --json · scripting' },
        desc: {
          ko: '모든 명령에 <code>--json</code> 을 붙이면 REST 와 같은 필드명으로 출력합니다. <code>env --json</code> 의 실행 경로, <code>setup --help</code>·<code>--dry-run</code> 으로 다른 프로그램에서 CLI 를 안전하게 부를 수 있습니다.',
          en: '<code>--json</code> on every command prints REST field names. <code>env --json</code> exposes binary paths, and <code>setup --help</code> / <code>--dry-run</code> make the CLI safe to call from other programs.'
        },
        code: ['talkbridge rooms --channel <키> --json', 'talkbridge env --json'],
        docs: [{ href: '/cli/commands/' }]
      }
    ]
  },
  {
    version: 'v1.0.0',
    date: '2026-09-01',
    launch: true,
    title: { ko: 'TalkBridge 정식 출시', en: 'TalkBridge general availability' },
    items: [
      {
        area: 'api',
        title: { ko: '셀프서브 개방 — CLI · MCP · API', en: 'Self-serve launch — CLI · MCP · API' },
        desc: {
          ko: '카카오 상담톡을 브랜드 키 하나로 CLI · MCP 커넥터 · Developer API 에 연결합니다. 수신은 HMAC 서명 웹훅, 발신은 하나의 발신 API 로.',
          en: 'Connect KakaoTalk consultation chat to the CLI, MCP connector and Developer API with one brand key — signed HMAC webhooks in, one send API out.'
        },
        docs: [{ href: '/getting-started/' }]
      }
    ]
  }
];
