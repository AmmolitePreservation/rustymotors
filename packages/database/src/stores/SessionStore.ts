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

import type {
    ConnectionRecord,
    IRunningServerInfo,
    ISessionStore,
} from "rusty-motors-shared";
import type { UserInfo } from "rusty-motors-shared";
import { createHash } from "node:crypto";

// A customer's newest logins whose keys are kept; an older one's clients cannot open new connections.
const maximumKeysPerCustomer = 100;

/**
 * In-memory session store implementation
 * Manages runtime connection sessions, user state, and game servers
 */
export class SessionStore implements ISessionStore {
    private sessions: ConnectionRecord[] = [];
    // The login whose key each persona's client named in its lobby login (an MD5 of the key).
    private personaSessions: Map<number, ConnectionRecord> = new Map();
    private users: Map<number, UserInfo> = new Map();
    private connections: Map<string, number> = new Map();
    private gameServers: Map<number, IRunningServerInfo> = new Map();

    async updateSessionKey(
        customerId: number,
        sessionKey: string,
        contextId: string,
        connectionId: string,
    ): Promise<void> {
        const sKey = sessionKey.slice(0, 16);

        const updatedSession: ConnectionRecord = {
            customerId,
            sessionKey,
            sKey,
            contextId,
            connectionId,
        };

        // Every client of a customer keeps its own key: several clients of one login play at once.
        this.sessions = this.sessions.filter((session) => session.contextId !== contextId);
        this.sessions.push(updatedSession);
        const customerSessions = this.sessions.filter((session) => session.customerId === customerId);
        if (customerSessions.length > maximumKeysPerCustomer) {
            const oldest = customerSessions[0]!;
            this.sessions = this.sessions.filter((session) => session !== oldest);
            for (const [personaId, session] of this.personaSessions) {
                if (session === oldest) {
                    this.personaSessions.delete(personaId);
                }
            }
        }
    }

    async fetchSessionKeyByHash(
        customerId: number,
        hashKey: Buffer,
    ): Promise<ConnectionRecord> {
        const record = this.sessions.find(
            (session) => session.customerId === customerId &&
                createHash("md5").update(Buffer.from(session.sessionKey, "hex")).digest().equals(hashKey),
        );
        if (typeof record === "undefined") {
            throw new Error(`No login of customer ${customerId} has the session key the lobby login names`);
        }
        return record;
    }

    async bindPersonaSession(personaId: number, record: ConnectionRecord): Promise<void> {
        this.personaSessions.set(personaId, record);
    }

    async fetchSessionKeyForPersona(
        customerId: number,
        personaId: number,
    ): Promise<ConnectionRecord> {
        const bound = this.personaSessions.get(personaId);
        if (typeof bound !== "undefined" && bound.customerId === customerId) {
            return bound;
        }
        const customerSessions = this.sessions.filter((session) => session.customerId === customerId);
        if (customerSessions.length === 1) {
            return customerSessions[0]!;
        }
        throw new Error(
            `Customer ${customerId} has ${customerSessions.length} logins and persona ${personaId} chose none of them in the lobby`,
        );
    }

    async fetchSessionKeyByConnectionId(
        connectionId: string,
    ): Promise<ConnectionRecord> {
        const record = this.sessions.find(
            (session) => session.connectionId === connectionId,
        );
        if (typeof record === "undefined") {
            throw new Error(
                `Session key not found for connection ${connectionId}`,
            );
        }
        return record;
    }

    async updateUser(user: {
        userId: number;
        userInfo: UserInfo;
    }): Promise<void> {
        this.users.set(user.userId, user.userInfo);
    }

    async getUser(userId: number): Promise<UserInfo | undefined> {
        return this.users.get(userId);
    }

    async updateConnection(
        connectionId: string,
        userId: number,
    ): Promise<void> {
        this.connections.set(connectionId, userId);
    }

    async findUserByConnectionId(
        connectionId: string,
    ): Promise<number | undefined> {
        return this.connections.get(connectionId);
    }

    async updateGameServer(
        commId: number,
        gameServer: IRunningServerInfo,
    ): Promise<void> {
        this.gameServers.set(commId, gameServer);
    }

    async getGameServers(): Promise<IRunningServerInfo[]> {
        return Array.from(this.gameServers.values());
    }
}
