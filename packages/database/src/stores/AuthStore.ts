// mcos is a game server, written from scratch, for an old game
// Copyright (C) <2017>  <Drazi Crendraven>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { compare, compareSync, hash, hashSync } from "bcrypt";
import Database from "better-sqlite3";
import { type ConnectionPool, type ConnectionPoolConfig, sql } from "@databases/pg";
import * as pg from "@databases/pg";
import { getServerLogger, type ServerLogger, type UserRecordMini, type IAuthStore } from "rusty-motors-shared";

type createConnectionPool = (
    connectionConfig?: string | ConnectionPoolConfig | undefined,
) => ConnectionPool;

const SQL = {
    CREATE_USER_TABLE: `
        CREATE TABLE IF NOT EXISTS user(
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        customerId INTEGER PRIMARY KEY NOT NULL
    ) STRICT`,
    CREATE_SESSION_TABLE: `
        CREATE TABLE session(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contextId TEXT UNIQUE NOT NULL,
        customerId INTEGER NOT NULL,
        profileId INTEGER DEFAULT 0,
        remoteAddress TEXT
    ) STRICT`,
    UPDATE_SESSION:
        "INSERT OR REPLACE INTO session (contextId, customerId, profileId) VALUES (?, ?, ?)",
    DELETE_CUSTOMER_SESSIONS: "DELETE FROM session WHERE customerId = ?",
    FIND_SESSION_BY_CONTEXT: "SELECT * FROM session WHERE contextId = ?",
    BIND_SESSION_ADDRESS: "UPDATE session SET remoteAddress = ? WHERE contextId = ?",
    FIND_SESSION_ADDRESS: "SELECT remoteAddress FROM session WHERE customerId = ? AND remoteAddress IS NOT NULL",
} as const;

type DBLogin = {
    login_name: string;
    password: string;
    customer_id: number;
    login_level: number;
    is_locked: boolean;
};

const passwordHashRounds = 10;

/**
 * Auth store implementation - manages authentication and local session cache
 * Uses SQLite for local session cache and PostgreSQL for login credentials
 */
export class AuthStore implements IAuthStore {
    private database: Database.Database;
    private pgPool: ConnectionPool | null = null;
    private logger: ServerLogger;
    private postgresUrl: string | undefined;
    private _isDatabaseConnected: boolean = false;

    constructor(
        sqlitePath: string,
        postgresUrl?: string,
        logger?: ServerLogger,
    ) {
        this.logger = logger ?? getServerLogger("AuthStore");
        this.postgresUrl = postgresUrl;

        // Initialize SQLite database
        this.database = new Database(sqlitePath);
        this.database.pragma("journal_mode = WAL");

        this.initializeSchema();
        this._isDatabaseConnected = true;
    }

    get isDatabaseConnected(): boolean {
        return this._isDatabaseConnected;
    }

    private initializeSchema(): void {
        this.database.exec(SQL.CREATE_USER_TABLE);
        this.database.exec(
            "CREATE INDEX IF NOT EXISTS idx_user_username ON user(username)",
        );
        this.database.exec(
            "CREATE INDEX IF NOT EXISTS idx_user_customerId ON user(customerId)",
        );
        // Tickets live until the next login or server start, so the session table is
        // made new each start. That also ends the fixed demo tickets earlier releases kept.
        this.database.exec("DROP TABLE IF EXISTS session");
        this.database.exec(SQL.CREATE_SESSION_TABLE);
        this.database.exec(
            "CREATE INDEX IF NOT EXISTS idx_session_customerId ON session(customerId)",
        );
        // The demo login is created once; a password changed later is kept.
        this.registerNewUser("admin", "admin", 654321);
        this.logger.info("Database initialized");
    }

    private ensurePostgresPool(): ConnectionPool {
        if (!this.pgPool) {
            if (!this.postgresUrl) {
                throw new Error(
                    "DATABASE_URL environment variable is required for PostgreSQL operations",
                );
            }
            this.pgPool = (pg.default as unknown as createConnectionPool)({
                bigIntMode: "bigint",
            });
        }
        return this.pgPool;
    }

    private generatePasswordHash(password: string, saltRounds = 10): string {
        return hashSync(password, saltRounds);
    }

    registerNewUser(
        username: string,
        password: string,
        customerId: number,
    ): void {
        const hashedPassword = this.generatePasswordHash(password);
        const db = this.ensurePostgresPool();
        try {
            db.query(sql`INSERT
                INTO login (login_name, "password", customer_id)
                VALUES (${username}, ${hashedPassword}, ${customerId})
                ON CONFLICT (customer_id) DO NOTHING;`);
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.includes("UNIQUE constraint failed")
            ) {
                this.logger.warn(`User ${username} already exists`);
                return;
            }
            throw error;
        }
    }

    async findUser(
        username: string,
        password: string,
    ): Promise<{ customerId: number; userName: string; loginLevel: number; isLocked: boolean }> {
        const db = this.ensurePostgresPool();
        const userRecords = (await db.query(
            sql`SELECT * FROM login WHERE login_name = ${username}`,
        )) as unknown as DBLogin[];

        if (userRecords.length === 0) {
            this.logger.error("user not found");
            throw new Error("User not found");
        }

        const user = userRecords[0] as DBLogin;
        if (!compareSync(password, user.password)) {
            this.logger.error("password invalid");
            throw new Error("password invalid for user");
        }

        return {
            customerId: user.customer_id,
            userName: user.login_name,
            loginLevel: user.login_level,
            isLocked: user.is_locked,
        };
    }

    async findLogin(
        loginName: string,
    ): Promise<{ customerId: number; userName: string; loginLevel: number; isLocked: boolean } | undefined> {
        const userRecords = (await this.ensurePostgresPool().query(
            sql`SELECT * FROM login WHERE login_name = ${loginName}`,
        )) as unknown as DBLogin[];
        const user = userRecords[0];
        if (typeof user === "undefined") {
            return undefined;
        }
        return {
            customerId: user.customer_id,
            userName: user.login_name,
            loginLevel: user.login_level,
            isLocked: user.is_locked,
        };
    }

    async createLogin(loginName: string, password: string): Promise<number | undefined> {
        const passwordHash = await hash(password, passwordHashRounds);
        const rows = (await this.ensurePostgresPool().query(sql`
            INSERT INTO login (login_name, "password", customer_id)
            VALUES (${loginName}, ${passwordHash}, nextval('customer_id_seq'))
            ON CONFLICT DO NOTHING
            RETURNING customer_id`)) as { customer_id: bigint }[];
        return rows.length === 1 ? Number(rows[0]!.customer_id) : undefined;
    }

    async setLoginPassword(loginName: string, password: string): Promise<boolean> {
        const passwordHash = await hash(password, passwordHashRounds);
        const rows = await this.ensurePostgresPool().query(sql`
            UPDATE login SET "password" = ${passwordHash} WHERE login_name = ${loginName} RETURNING login_name`);
        return rows.length === 1;
    }

    async verifyLogin(loginName: string, password: string): Promise<string | undefined> {
        const rows = (await this.ensurePostgresPool().query(sql`
            SELECT login_name, "password" FROM login WHERE login_name = ${loginName}`)) as DBLogin[];
        const login = rows[0];
        if (typeof login === "undefined" || !(await compare(password, login.password))) {
            return undefined;
        }
        return login.login_name;
    }

    async setLoginLocked(loginName: string, isLocked: boolean): Promise<boolean> {
        const rows = await this.ensurePostgresPool().query(sql`
            UPDATE login SET is_locked = ${isLocked} WHERE login_name = ${loginName} RETURNING login_name`);
        return rows.length === 1;
    }

    async findLogins(loginNames: string[]): Promise<string[]> {
        const rows = (await this.ensurePostgresPool().query(sql`
            SELECT login_name FROM login WHERE login_name = ANY(${loginNames}) ORDER BY login_name`)) as DBLogin[];
        return rows.map((row) => row.login_name);
    }

    async countLogins(): Promise<number> {
        const rows = (await this.ensurePostgresPool().query(sql`SELECT count(*) AS logins FROM login`)) as { logins: bigint }[];
        return Number(rows[0]!.logins);
    }

    updateSession(
        customerId: number,
        contextId: string,
        profileId: number,
    ): void {
        const insert = this.database.prepare(SQL.UPDATE_SESSION);
        insert.run(contextId, customerId, profileId);
    }

    startSession(customerId: number, contextId: string): void {
        const replaceSessions = this.database.transaction(() => {
            this.database.prepare(SQL.DELETE_CUSTOMER_SESSIONS).run(customerId);
            this.database.prepare(SQL.UPDATE_SESSION).run(contextId, customerId, 0);
        });
        replaceSessions();
    }

    bindSessionAddress(contextId: string, remoteAddress: string): void {
        const result = this.database.prepare(SQL.BIND_SESSION_ADDRESS).run(remoteAddress, contextId);
        if (result.changes !== 1) {
            throw new Error(`No session holds the ticket the login presented`);
        }
    }

    findSessionAddress(customerId: number): string | undefined {
        const row = this.database.prepare(SQL.FIND_SESSION_ADDRESS).get(customerId) as
            | { remoteAddress: string }
            | undefined;
        return row?.remoteAddress;
    }

    findCustomerByContext(contextId: string): UserRecordMini | undefined {
        this.logger.info("findCustomerByContext");
        try {
            const query = this.database.prepare(SQL.FIND_SESSION_BY_CONTEXT);
            const user = query.get(contextId) as UserRecordMini | undefined;
            this.logger.info("findCustomerByContext-end");
            return user;
        } catch (error: unknown) {
            this.logger.error((error as Error).message);
            throw error;
        }
    }
}
