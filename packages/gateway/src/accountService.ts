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

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import {
	carDisplayName,
	databaseProvider,
	maximumPersonasPerCustomer,
	personaLevel,
	personaRank,
	reputationRanks,
	type ServerLogger,
} from "rusty-motors-shared";

/**
 * The ammolite portal's account service: creates, re-passwords, checks, and locks logins, and lists
 * their personas. POST /v1/health, /v1/accounts/create, /v1/accounts/password, /v1/accounts/verify,
 * /v1/accounts/lock, /v1/accounts/unlock, /v1/characters; JSON in, JSON out, the same contract as the
 * account services of ammolite's other games. Only ammolite's address (and this machine) may call it,
 * with the token whose SHA-256 the settings file holds; the token itself is not stored here.
 */
export type AccountServiceSettings = {
	port: number;
	tokenSha256: string;
	allowedAddress: string;
};

type Reply = [status: number, body: Record<string, unknown>];

const loginNamePattern = /^[A-Za-z0-9_]{3,32}$/;
// bcrypt reads at most 72 bytes of a password.
const passwordPattern = /^[!-~]{1,72}$/;
const maximumLoginsPerCall = 100;
// player.persona is VARCHAR(30).
const personaNameLength = 30;
const maximumBodyBytes = 64 * 1024;
const loopbackAddresses = ["127.0.0.1", "::1"];

class RequestError extends Error {}

/** The settings the link script wrote; undefined when the file is absent, which means not linked. */
export function readAccountServiceSettings(path: string): AccountServiceSettings | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	const settings = JSON.parse(readFileSync(path, "utf8")) as Partial<AccountServiceSettings>;
	const keys = Object.keys(settings).sort().join(",");
	if (keys !== "allowedAddress,port,tokenSha256") {
		throw new Error(`${path} must hold exactly port, tokenSha256, and allowedAddress, not ${keys}`);
	}
	if (!Number.isInteger(settings.port) || settings.port! < 1 || settings.port! > 65535) {
		throw new Error(`${path}: port must be a whole number from 1 to 65535`);
	}
	if (!/^[0-9a-f]{64}$/.test(settings.tokenSha256 ?? "")) {
		throw new Error(`${path}: tokenSha256 must be 64 lowercase hex digits`);
	}
	if (!/^[0-9.:a-f]+$/.test(settings.allowedAddress ?? "")) {
		throw new Error(`${path}: allowedAddress must be an IP address`);
	}
	return settings as AccountServiceSettings;
}

export function plainAddress(address: string | undefined): string {
	return (address ?? "").replace(/^::ffff:/, "");
}

function isTokenAccepted(authorization: string | undefined, tokenSha256: string): boolean {
	const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
	if (typeof token === "undefined") {
		return false;
	}
	return timingSafeEqual(createHash("sha256").update(token, "utf8").digest(), Buffer.from(tokenSha256, "hex"));
}

function requiredText(body: Record<string, unknown>, name: string, pattern: RegExp): string {
	const value = body[name];
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new RequestError(`${name} is missing or malformed`);
	}
	return value;
}

function requiredLoginNames(body: Record<string, unknown>): string[] {
	const accounts = body["accounts"];
	if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > maximumLoginsPerCall) {
		throw new RequestError(`accounts must list 1-${maximumLoginsPerCall} logins`);
	}
	return accounts.map((account) => {
		if (typeof account !== "string" || !loginNamePattern.test(account)) {
			throw new RequestError("accounts holds a malformed login name");
		}
		return account;
	});
}

function requiredPersonaNames(body: Record<string, unknown>): string[] {
	const names = body["characters"];
	if (!Array.isArray(names) || names.length === 0 || names.length > maximumPersonasPerCustomer) {
		throw new RequestError(`characters must list 1 to ${maximumPersonasPerCustomer} persona names`);
	}
	return names.map((name) => {
		if (typeof name !== "string" || name.length < 1 || name.length > personaNameLength) {
			throw new RequestError(`characters holds a name that is not 1 to ${personaNameLength} characters of text`);
		}
		return name;
	});
}

/** Answers one request that has passed the address and token checks. */
export async function answerAccountRequest(path: string, body: Record<string, unknown>): Promise<Reply> {
	const logins = databaseProvider.getAuthStore();
	switch (path) {
		case "/v1/health":
			return [200, { status: "ok", logins: await logins.countLogins() }];
		case "/v1/accounts/create": {
			const account = requiredText(body, "account", loginNamePattern);
			const customerId = await logins.createLogin(account, requiredText(body, "password", passwordPattern));
			return typeof customerId === "undefined"
				? [409, { error: "that login already exists" }]
				: [200, { account, customerId }];
		}
		case "/v1/accounts/password": {
			const account = requiredText(body, "account", loginNamePattern);
			const isChanged = await logins.setLoginPassword(account, requiredText(body, "password", passwordPattern));
			return isChanged ? [200, {}] : [404, { error: "no such login" }];
		}
		case "/v1/accounts/verify": {
			const account = requiredText(body, "account", loginNamePattern);
			const verified = await logins.verifyLogin(account, requiredText(body, "password", passwordPattern));
			return [200, { account: verified ?? null }];
		}
		case "/v1/accounts/lock":
		case "/v1/accounts/unlock": {
			const account = requiredText(body, "account", loginNamePattern);
			const isChanged = await logins.setLoginLocked(account, path === "/v1/accounts/lock");
			return isChanged ? [200, {}] : [404, { error: "no such login" }];
		}
		case "/v1/characters/move": {
			const from = requiredText(body, "from", loginNamePattern);
			const to = requiredText(body, "to", loginNamePattern);
			const personaNames = requiredPersonaNames(body);
			const source = await logins.findLogin(from);
			const target = await logins.findLogin(to);
			if (typeof source === "undefined" || typeof target === "undefined") {
				return [404, { error: `no such login: ${typeof source === "undefined" ? from : to}` }];
			}
			const result = await databaseProvider.getPersonaStore().movePersonas(personaNames, source.customerId, target.customerId);
			return "refusal" in result ? [409, { error: result.refusal }] : [200, { moved: result.moved }];
		}
		case "/v1/characters": {
			const accounts = requiredLoginNames(body);
			const personas = await databaseProvider.getPersonaStore().listPersonasOfLogins(accounts);
			return [200, {
				logins: await logins.findLogins(accounts),
				characters: personas.map((persona) => ({
					account: persona.loginName,
					name: persona.personaName,
					level: personaLevel,
					rank: reputationRanks[personaRank],
					car: persona.car === null ? null : carDisplayName(persona.car.modelYear, persona.car.brand, persona.car.model),
				})),
			}];
		}
		default:
			return [404, { error: "no such route" }];
	}
}

/**
 * Answers one HTTP request: the caller's address and token first, then the route. Logs paths and
 * statuses only; login names and passwords stay out of the log.
 */
export async function handleAccountServiceRequest(
	settings: AccountServiceSettings,
	request: { method: string; path: string; remoteAddress: string | undefined; authorization: string | undefined; body: string },
): Promise<Reply> {
	if (![settings.allowedAddress, ...loopbackAddresses].includes(plainAddress(request.remoteAddress))) {
		return [403, { error: "address refused" }];
	}
	if (request.method !== "POST") {
		return [405, { error: "POST only" }];
	}
	if (!isTokenAccepted(request.authorization, settings.tokenSha256)) {
		return [401, { error: "token refused" }];
	}
	let body: unknown;
	try {
		body = JSON.parse(request.body);
	} catch {
		return [400, { error: "the body is not JSON" }];
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return [400, { error: "the body is not a JSON object" }];
	}
	try {
		return await answerAccountRequest(request.path, body as Record<string, unknown>);
	} catch (error) {
		if (error instanceof RequestError) {
			return [400, { error: error.message }];
		}
		throw error;
	}
}

export function startAccountService(settings: AccountServiceSettings, log: ServerLogger): http.Server {
	const server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maximumBodyBytes) {
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			const path = new URL(request.url ?? "/", "http://accountService").pathname;
			handleAccountServiceRequest(settings, {
				method: request.method ?? "",
				path,
				remoteAddress: request.socket.remoteAddress,
				authorization: request.headers.authorization,
				body: Buffer.concat(chunks).toString("utf8"),
			})
				.catch((error: unknown) => {
					log.error(`Account service ${path} failed: ${String(error)}`);
					return [500, { error: "the account service failed; see the server log" }] as Reply;
				})
				.then(([status, reply]) => {
					log.info(`Account service ${path}: ${status}`);
					response.writeHead(status, { "Content-Type": "application/json" });
					response.end(JSON.stringify(reply));
				});
		});
	});
	server.listen(settings.port);
	log.info(`Account service listening on port ${settings.port} for ${settings.allowedAddress}`);
	return server;
}
