/**
 * Kysely instance over the James MariaDB.
 *
 * webmail-architecture.md 2.3:
 * - 조회 전용 풀을 James 배달 트랜잭션과 분리한다.
 * - 격리 수준을 READ COMMITTED 로 낮춘다. MariaDB 기본 REPEATABLE READ 는 커넥션을
 *   오래 잡으면 스냅샷이 고정돼 새로 배달된 메일이 보이지 않는다.
 */
import { Kysely, MysqlDialect } from 'kysely';
import { createPool, type Pool } from 'mysql2';
import { config } from '../config.js';
import type { Database } from './schema.js';

function makePool(connectionLimit: number): Pool {
  return createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit,
    charset: 'utf8mb4',
    // 새로 배달된 메일이 즉시 보이도록 스냅샷을 고정하지 않는다
    // (단 MAIL_SIZE 등 BIGINT 는 안전 정수 범위 안이라 숫자로 받는다)
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    connectAttributes: { program_name: 'james9mail-web' },
  });
}

const readPool = makePool(config.db.poolSize);
readPool.on('connection', (conn) => {
  conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
});

/** 읽기 전용 조회에 쓰는 인스턴스. James 스키마 지식은 repositories/ 안에만 둔다 */
export const db = new Kysely<Database>({
  dialect: new MysqlDialect({ pool: readPool as never }),
});

/**
 * GU_ 테이블 쓰기용 인스턴스. James 테이블은 이 인스턴스로도 쓰지 않는다
 * (쓰기는 전부 James WebAdmin 경유: webmail-architecture.md 2.3).
 */
const writePool = makePool(Math.max(4, Math.floor(config.db.poolSize / 2)));
export const dbWrite = new Kysely<Database>({
  dialect: new MysqlDialect({ pool: writePool as never }),
});

export async function closeDb(): Promise<void> {
  await Promise.allSettled([db.destroy(), dbWrite.destroy()]);
}
