/** 서명관리(USR-17) · 주소록(POPUP-3) */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import * as aliases from '../repositories/aliases.js';
import * as gu from '../repositories/gu.js';
import * as contactRepo from '../repositories/contacts.js';
import * as contacts from '../services/contacts.js';
import * as users from '../repositories/users.js';
import { sanitizeOutgoingHtml } from '../mime/sanitize.js';

const typed = z.object({ type: z.string().max(20).default('other'), value: z.string().max(255) });

/** 연락처 필드 (contacts/vcard.ts 의 ContactFields) */
const contactFields = z.object({
  kind: z.enum(['individual', 'group']).default('individual'),
  displayName: z.string().max(200).default(''),
  familyName: z.string().max(100).default(''),
  givenName: z.string().max(100).default(''),
  nickname: z.string().max(100).default(''),
  emails: z
    .array(z.object({ type: z.string().max(20).default('other'), value: z.string().trim().email('err.badEmail').max(255) }))
    .max(20)
    .default([]),
  phones: z.array(typed).max(20).default([]),
  org: z.string().max(200).default(''),
  department: z.string().max(200).default(''),
  title: z.string().max(200).default(''),
  addresses: z
    .array(
      z.object({
        type: z.string().max(20).default('other'),
        poBox: z.string().max(200).default(''),
        extended: z.string().max(200).default(''),
        street: z.string().max(500).default(''),
        locality: z.string().max(200).default(''),
        region: z.string().max(200).default(''),
        postalCode: z.string().max(50).default(''),
        country: z.string().max(200).default(''),
      }),
    )
    .max(10)
    .default([]),
  birthday: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})?$/)
    .default(''),
  urls: z.array(z.string().max(1000)).max(10).default([]),
  note: z.string().max(10_000).default(''),
  photo: z
    .string()
    .max(1024 * 1024 + 100)
    .nullable()
    .default(null),
  members: z.array(z.string().max(300)).max(5000).default([]),
});

const hasFields = (body: unknown) => typeof body === 'object' && body !== null && 'fields' in body;

/** 수정 · 삭제 대상 서명의 소유권 확인. 서명은 본인 것만 손댄다 */
async function requireOwnSignature(userName: string, signatureId: number): Promise<void> {
  const target = await gu.findSignature(signatureId);
  if (!target) throw notFound('err.notFound');
  if (target.userName !== userName) throw forbidden();
}

export async function personalRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- 서명 (USR-17)

  app.get('/api/signatures', { onRequest: [app.requireUser] }, async (request) =>
    gu.listSignatures(sessionOf(request).userName),
  );

  app.post('/api/signatures', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({
        name: z.string().min(1).max(100),
        content: z.string().max(100_000),
        isDefault: z.boolean().default(false),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);
    const signatureId = await gu.createSignature(session.userName, {
      ...input,
      content: sanitizeOutgoingHtml(input.content),
    });
    return { signatureId };
  });

  /**
   * 기본 서명 지정 (USR-17). :id 보다 먼저 선언해야 'default' 가 id 로 잡히지 않는다.
   */
  app.put('/api/signatures/default', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const input = z.object({ signatureId: z.number().int().nullable() }).parse(request.body);
    // 남의 서명을 내 기본으로 지정할 수는 없다
    if (input.signatureId !== null) await requireOwnSignature(session.userName, input.signatureId);
    await gu.setDefaultSignature(session.userName, input.signatureId);
    return { ok: true };
  });

  app.put('/api/signatures/:id', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const input = z
      .object({
        name: z.string().min(1).max(100).optional(),
        content: z.string().max(100_000).optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(request.body);
    await requireOwnSignature(session.userName, id);
    await gu.updateSignature(id, {
      ...input,
      content: input.content === undefined ? undefined : sanitizeOutgoingHtml(input.content),
    });
    return { ok: true };
  });

  app.delete('/api/signatures/:id', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    await requireOwnSignature(session.userName, id);
    await gu.deleteSignature(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- 주소록 (POPUP-3 · 개인 환경설정 > 주소록)
  //   한 행 = vCard 한 장 (개인 또는 그룹). 화면은 필드(ContactFields)로 주고받는다 (services/contacts.ts)

  app.get('/api/addresses', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const query = z
      .object({
        keyword: z.string().optional(),
        kind: z.enum(['I', 'G']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);
    return contactRepo.listContacts({ userName: session.userName, ...query });
  });

  /**
   * 수신자 자동완성 후보 (USR-1.4). 내 주소록(GU_ADDRESS_BOOK) · 내부 계정(JAMES_USER) ·
   * 알리아스(GU_MAIL_ALIAS)를 같이 훑어 주소 기준으로 합친다.
   * 이름은 주소록 이름 → 계정 표시이름 → 알리아스 이름 순으로 앞선다.
   * 내부 도메인 주소는 지금 메일을 받을 수 있는 것만 남긴다 — 주소록에는 중지·삭제된
   * 계정이나 중지된 알리아스가 수집된 채로 남아 있다 (4-3).
   * 주소록 그룹은 이름으로 찾아 멤버를 풀어 준다 (address 는 비우고 members 에 담는다).
   * complete = 한도에 걸리지 않고 다 담았다는 뜻. 브라우저는 이 목록만 캐시해
   * 더 길어진 입력은 DB 를 다시 부르지 않고 캐시에서 걸러 쓴다.
   */
  app.get('/api/addresses/suggest', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { q, limit } = z
      .object({ q: z.string().min(1).max(100), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    const keyword = q.trim();
    if (!keyword) return { items: [], complete: true };

    const GROUP_LIMIT = 5;
    const [book, accounts, aliasList, groups] = await Promise.all([
      contactRepo.searchAddresses(session.userName, keyword, limit),
      users.searchUsers(keyword, limit),
      aliases.searchAliases(keyword, limit),
      contactRepo.searchGroups(session.userName, keyword, GROUP_LIMIT),
    ]);

    const merged = new Map<string, { address: string; name: string | null }>();
    for (const row of [...book, ...accounts, ...aliasList]) {
      const key = row.address.toLowerCase();
      const found = merged.get(key);
      if (!found) merged.set(key, row);
      else if (!found.name && row.name) found.name = row.name;
    }

    // 내부 도메인 주소인데 계정도 알리아스도 살아 있지 않으면 뺀다. 세 갈래 중 주소록만
    // 상태를 모르므로(자동 수집된 뒤 계정이 중지돼도 행은 남는다) 여기서 한 번 맞춘다.
    // 외부 주소는 확인할 방법이 없으니 건드리지 않는다.
    const domains = new Set(await users.listDomains());
    const internal = [...merged.values()]
      .map((row) => row.address)
      .filter((address) => {
        const at = address.lastIndexOf('@');
        return at > 0 && domains.has(address.slice(at + 1).toLowerCase());
      });
    if (internal.length > 0) {
      const [liveUsers, liveAliases] = await Promise.all([
        users.activeAddresses(internal),
        aliases.activeAliasAddresses(internal),
      ]);
      for (const address of internal) {
        const key = address.toLowerCase();
        if (!liveUsers.has(key) && !liveAliases.has(key)) merged.delete(key);
      }
    }

    // 무엇으로 찾았든 이름은 같이 나와야 한다. 한쪽에서만 걸려 이름이 빈 주소는
    // (예: 이름 없는 수집 주소록 행이 주소로 걸린 경우, 한도에 잘려 짝이 안 온 경우)
    // 세 표에서 주소로 한 번 더 찾아 채운다.
    const nameless = [...merged.values()].filter((row) => !row.name).map((row) => row.address);
    if (nameless.length > 0) {
      const [contactNames, displays, aliasLabels] = await Promise.all([
        contactRepo.contactNames(session.userName, nameless),
        users.displayNames(nameless),
        aliases.aliasNames(nameless),
      ]);
      for (const row of merged.values()) {
        if (row.name) continue;
        const key = row.address.toLowerCase();
        row.name = contactNames.get(key) ?? displays.get(key) ?? aliasLabels.get(key) ?? null;
      }
    }

    const groupItems: { address: string; name: string; groupId: number; members: contacts.Recipient[] }[] = [];
    for (const group of groups) {
      const members = await contacts.expandGroups(session.userName, [group.addressId]);
      if (members.length) groupItems.push({ address: '', name: group.contactName ?? '', groupId: group.addressId, members });
    }

    return {
      items: [...groupItems, ...merged.values()],
      complete: book.length < limit && accounts.length < limit && aliasList.length < limit && groups.length < GROUP_LIMIT,
    };
  });

  /** 연락처 · 그룹 하나 (편집 화면). 그룹이면 멤버를 연락처 행으로 풀어 같이 준다 */
  app.get('/api/addresses/:id', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const detail = await contacts.getDetail(session.userName, id);
    const members = detail.kind === 'G' ? await contacts.groupMembers(session.userName, detail.fields.members) : [];
    return { ...detail, members };
  });

  /** 그룹을 받는 사람 목록으로 푼다 (주소록 팝업에서 그룹을 골랐을 때) */
  app.post('/api/addresses/expand', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { ids } = z.object({ ids: z.array(z.number().int()).max(500) }).parse(request.body);
    return contacts.expandGroups(session.userName, ids);
  });

  /**
   * 추가. fields 를 주면 상세 편집 화면에서, contactName · mailAddress 만 주면 주소록 팝업의
   * 빠른 추가다 (이미 있는 주소면 이름만 고친다).
   */
  app.post('/api/addresses', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    if (hasFields(request.body)) {
      const { fields } = z.object({ fields: contactFields }).parse(request.body);
      return { addressId: await contacts.saveFields(session.userName, null, fields) };
    }
    const input = z
      .object({
        contactName: z.string().max(100).nullable().optional(),
        mailAddress: z.string().email('err.badEmail'),
      })
      .parse(request.body);
    // 이름을 주지 않았으면 내부 계정의 표시 이름(USER_DISPLAY_NAME)을 이름으로 채운다
    const contactName =
      input.contactName?.trim() ||
      (await users.displayNames([input.mailAddress])).get(input.mailAddress.toLowerCase()) ||
      null;
    await contacts.quickAdd(session.userName, input.mailAddress, contactName);
    return { ok: true };
  });

  app.put('/api/addresses/:id', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    if (hasFields(request.body)) {
      const { fields } = z.object({ fields: contactFields }).parse(request.body);
      await contacts.saveFields(session.userName, id, fields);
      return { ok: true };
    }
    const input = z
      .object({
        contactName: z.string().max(100).nullable().optional(),
        mailAddress: z.string().email('err.badEmail').optional(),
      })
      .parse(request.body);
    // 소유권은 USER_NAME 조건으로 읽는 getDetail 이 보장한다
    await contacts.quickUpdate(session.userName, id, input);
    return { ok: true };
  });

  app.delete('/api/addresses/:id', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(request.params);
    await contacts.remove(session.userName, [id]);
    return { ok: true };
  });

  /** 여러 건 삭제 (개인 환경설정 > 주소록의 선택 삭제) */
  app.post('/api/addresses/delete', { onRequest: [app.requireUser] }, async (request) => {
    const session = sessionOf(request);
    const { ids } = z.object({ ids: z.array(z.number().int()).min(1).max(5000) }).parse(request.body);
    return { deleted: await contacts.remove(session.userName, ids) };
  });

  /** .vcf · .csv 가져오기. 글자셋을 서버가 가려야 해서(CP949 CSV) 파일 바이트를 base64 로 받는다 */
  app.post('/api/addresses/import', { onRequest: [app.requireUser], bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const session = sessionOf(request);
    const input = z
      .object({
        fileName: z.string().max(255),
        data: z.string().min(1).max(15 * 1024 * 1024),
        overwrite: z.boolean().default(false),
      })
      .parse(request.body);
    const ext = input.fileName.toLowerCase().split('.').pop();
    const format = ext === 'vcf' || ext === 'vcard' ? 'vcf' : ext === 'csv' || ext === 'txt' || ext === 'tab' ? 'csv' : null;
    if (!format) throw badRequest('err.importFormat');
    return contacts.importContacts(session.userName, format, Buffer.from(input.data, 'base64'), input.overwrite);
  });

  /** 내보내기. vcf 는 썬더버드 · 아웃룩 · 휴대폰이 그대로 읽고, csv 는 썬더버드 CSV 머리글이다 */
  app.get('/api/addresses/export', { onRequest: [app.requireUser] }, async (request, reply) => {
    const session = sessionOf(request);
    const { format } = z.object({ format: z.enum(['vcf', 'csv']).default('vcf') }).parse(request.query);
    const text = await contacts.exportContacts(session.userName, format);
    return reply
      .header('Content-Type', format === 'vcf' ? 'text/vcard; charset=utf-8' : 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="contacts.${format}"`)
      .send(text);
  });
}
