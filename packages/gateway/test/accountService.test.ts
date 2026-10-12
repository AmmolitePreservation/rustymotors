import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { databaseProvider, type IDatabaseServices, type PersonaCar } from "rusty-motors-shared";
import { handleAccountServiceRequest, readAccountServiceSettings, type AccountServiceSettings } from "../src/accountService.js";
import { initializeRouteHandlers, processHttpRequest } from "../src/web.js";

const token = "a-token-only-ammolite-holds";
const ammoliteAddress = "10.111.111.140";
const settings: AccountServiceSettings = {
	port: 8107,
	tokenSha256: createHash("sha256").update(token).digest("hex"),
	allowedAddress: ammoliteAddress,
};

type Login = { name: string; password: string; isLocked: boolean; customerId: number };

function registerLogins(logins: Login[], personas: { loginName: string; personaName: string; car: PersonaCar | null }[] = []): Login[] {
	databaseProvider.register({
		auth: {
			findUser: async (name: string, password: string) => {
				const login = logins.find((candidate) => candidate.name === name && candidate.password === password);
				if (typeof login === "undefined") {
					throw new Error("User not found");
				}
				return { customerId: login.customerId, userName: login.name, loginLevel: 0, isLocked: login.isLocked };
			},
			startSession: () => {},
			createLogin: async (name: string, password: string) => {
				if (logins.some((login) => login.name.toLowerCase() === name.toLowerCase())) {
					return undefined;
				}
				logins.push({ name, password, isLocked: false, customerId: 1000000 + logins.length });
				return logins.at(-1)!.customerId;
			},
			setLoginPassword: async (name: string, password: string) => {
				const login = logins.find((candidate) => candidate.name === name);
				if (login) {
					login.password = password;
				}
				return typeof login !== "undefined";
			},
			verifyLogin: async (name: string, password: string) =>
				logins.find((login) => login.name === name && login.password === password)?.name,
			setLoginLocked: async (name: string, isLocked: boolean) => {
				const login = logins.find((candidate) => candidate.name === name);
				if (login) {
					login.isLocked = isLocked;
				}
				return typeof login !== "undefined";
			},
			findLogins: async (names: string[]) => logins.map((login) => login.name).filter((name) => names.includes(name)),
			countLogins: async () => logins.length,
		},
		persona: {
			listPersonasOfLogins: async (names: string[]) => personas.filter((persona) => names.includes(persona.loginName)),
		},
	} as unknown as IDatabaseServices);
	return logins;
}

function call(path: string, body: unknown, options: { address?: string; authorization?: string; method?: string } = {}) {
	return handleAccountServiceRequest(settings, {
		method: options.method ?? "POST",
		path,
		remoteAddress: options.address ?? `::ffff:${ammoliteAddress}`,
		authorization: options.authorization ?? `Bearer ${token}`,
		body: JSON.stringify(body),
	});
}

afterEach(() => databaseProvider.unregister());

describe("account service gate", () => {
	it("refuses other addresses before reading the token, and a wrong token or method from ammolite", async () => {
		registerLogins([]);
		expect(await call("/v1/health", {}, { address: "203.0.113.9" })).toEqual([403, { error: "address refused" }]);
		expect(await call("/v1/health", {}, { authorization: "Bearer guessed" })).toEqual([401, { error: "token refused" }]);
		expect(await call("/v1/health", {}, { authorization: token })).toEqual([401, { error: "token refused" }]);
		expect(await call("/v1/health", {}, { method: "GET" })).toEqual([405, { error: "POST only" }]);
	});

	it("answers this machine, for the link script's health check", async () => {
		registerLogins([{ name: "admin", password: "x", isLocked: false, customerId: 654321 }]);
		expect(await call("/v1/health", {}, { address: "127.0.0.1" })).toEqual([200, { status: "ok", logins: 1 }]);
	});
});

describe("account service logins", () => {
	it("creates a login with a new customer id and refuses a name taken in any case", async () => {
		const logins = registerLogins([{ name: "admin", password: "admin", isLocked: false, customerId: 654321 }]);
		expect(await call("/v1/accounts/create", { account: "Marty_88", password: "flux-capacitor" })).toEqual([200, { account: "Marty_88", customerId: 1000001 }]);
		expect(await call("/v1/accounts/create", { account: "ADMIN", password: "whatever1" })).toEqual([409, { error: "that login already exists" }]);
		expect(logins.map((login) => login.name)).toEqual(["admin", "Marty_88"]);
	});

	it("verifies a password with the login's own spelling, null when wrong", async () => {
		registerLogins([{ name: "Marty_88", password: "flux-capacitor", isLocked: false, customerId: 1000001 }]);
		expect(await call("/v1/accounts/verify", { account: "Marty_88", password: "flux-capacitor" })).toEqual([200, { account: "Marty_88" }]);
		expect(await call("/v1/accounts/verify", { account: "Marty_88", password: "wrong-one" })).toEqual([200, { account: null }]);
	});

	it("changes a password, locks and unlocks, and answers 404 for a login it does not have", async () => {
		const logins = registerLogins([{ name: "Marty_88", password: "flux-capacitor", isLocked: false, customerId: 1000001 }]);
		expect(await call("/v1/accounts/password", { account: "Marty_88", password: "1.21-gigawatts" })).toEqual([200, {}]);
		expect(await call("/v1/accounts/lock", { account: "Marty_88" })).toEqual([200, {}]);
		expect(logins[0]).toEqual({ name: "Marty_88", password: "1.21-gigawatts", isLocked: true, customerId: 1000001 });
		expect(await call("/v1/accounts/unlock", { account: "Marty_88" })).toEqual([200, {}]);
		expect(logins[0]!.isLocked).toBe(false);
		expect(await call("/v1/accounts/lock", { account: "Biff" })).toEqual([404, { error: "no such login" }]);
	});

	it("refuses malformed names, passwords, and bodies", async () => {
		registerLogins([]);
		expect(await call("/v1/accounts/create", { account: "a b", password: "flux-capacitor" })).toEqual([400, { error: "account is missing or malformed" }]);
		expect(await call("/v1/accounts/create", { account: "Marty", password: "has space" })).toEqual([400, { error: "password is missing or malformed" }]);
		expect(await call("/v1/accounts/create", ["Marty"])).toEqual([400, { error: "the body is not a JSON object" }]);
		expect(await call("/v1/nothing", {})).toEqual([404, { error: "no such route" }]);
	});
});

describe("account service characters", () => {
	it("lists the logins it has and their live personas with level, rank and car, so a missing login differs from one without personas", async () => {
		registerLogins(
			[
				{ name: "admin", password: "admin", isLocked: false, customerId: 654321 },
				{ name: "Marty_88", password: "x", isLocked: false, customerId: 1000001 },
			],
			[
				{ loginName: "admin", personaName: "Dr Brown", car: null },
				{ loginName: "admin", personaName: "George", car: { modelYear: 1957, brand: "Chevrolet", model: "Bel-Air" } },
			],
		);
		expect(await call("/v1/characters", { accounts: ["admin", "Marty_88", "Biff"] })).toEqual([200, {
			logins: ["admin", "Marty_88"],
			characters: [
				{ account: "admin", name: "Dr Brown", level: 1, rank: "Newbie", car: null },
				{ account: "admin", name: "George", level: 1, rank: "Newbie", car: "'57 Chevrolet Bel-Air" },
			],
		}]);
		expect(await call("/v1/characters", { accounts: [] })).toEqual([400, { error: "accounts must list 1-100 logins" }]);
	});
});

describe("account service settings", () => {
	function settingsFile(contents: unknown): string {
		const path = join(mkdtempSync(join(tmpdir(), "accountService")), "accountService.json");
		writeFileSync(path, JSON.stringify(contents));
		return path;
	}

	it("reads the link script's file, and an absent file means not linked", () => {
		expect(readAccountServiceSettings(settingsFile(settings))).toEqual(settings);
		expect(readAccountServiceSettings(join(tmpdir(), "noSuchAccountServiceFile.json"))).toBeUndefined();
	});

	it("refuses a file with missing, extra, or malformed settings", () => {
		expect(() => readAccountServiceSettings(settingsFile({ port: 8107, tokenSha256: settings.tokenSha256 }))).toThrow(/exactly port/);
		expect(() => readAccountServiceSettings(settingsFile({ ...settings, port: 70000 }))).toThrow(/port must be/);
		expect(() => readAccountServiceSettings(settingsFile({ ...settings, tokenSha256: token }))).toThrow(/tokenSha256/);
	});
});

describe("AuthLogin", () => {
	async function send(method: string, url: string, body: string): Promise<string> {
		initializeRouteHandlers();
		let reply = "";
		const response = { setHeader: () => {}, end: (text: string) => { reply = text; } } as unknown as http.ServerResponse;
		const request = Object.assign(Readable.from([Buffer.from(body)]), { method, url }) as unknown as http.IncomingMessage;
		await processHttpRequest(request, response);
		return reply;
	}

	function authLogin(name: string, password: string): Promise<string> {
		const form = new URLSearchParams({ username: name, password, serviceID: "2176", version: "2.0" });
		return send("POST", "/AuthLogin", form.toString());
	}

	it("refuses a locked login and lets it in once unlocked", async () => {
		const logins = registerLogins([{ name: "Marty_88", password: "flux-capacitor", isLocked: true, customerId: 1000001 }]);
		expect(await authLogin("Marty_88", "flux-capacitor")).toBe("reasoncode=INV-100\nreasontext=This login is locked.\nreasonurl=https://winehq.com");
		logins[0]!.isLocked = false;
		expect(await authLogin("Marty_88", "flux-capacitor")).toMatch(/^Valid=TRUE\nTicket=[0-9a-f]{34}$/);
	});

	it("reads a password with URL-special characters, longer than the game's old 16, exactly as sent", async () => {
		registerLogins([{ name: "Doc_55", password: "Gig4w4tts#&+%=1.21!", isLocked: false, customerId: 1000002 }]);
		expect(await authLogin("Doc_55", "Gig4w4tts#&+%=1.21!")).toMatch(/^Valid=TRUE\nTicket=[0-9a-f]{34}$/);
		expect(await authLogin("Doc_55", "Gig4w4tts")).toBe("reasoncode=INV-100\nreasontext=Opps!\nreasonurl=https://winehq.com");
	});

	it("answers the game's own GET login with the clearcoat download, without reading its query string", async () => {
		registerLogins([{ name: "Marty_88", password: "flux-capacitor", isLocked: false, customerId: 1000001 }]);
		expect(await send("GET", "/AuthLogin?username=Marty_88&password=flux-capacitor&serviceID=2176&version=2.0", "")).toBe(
			"reasoncode=INV-200\nreasontext=This login needs the current clearcoat.\nreasonurl=https://ammolite.unseencolor.com:1996/packages/clearcoat");
	});
});
