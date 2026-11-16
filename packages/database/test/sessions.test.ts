import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/stores/SessionStore.js";

const customerId = 4242;
const keyOfClientA = "aa".repeat(32);
const keyOfClientB = "bb".repeat(32);
const md5 = (hexKey: string) => createHash("md5").update(Buffer.from(hexKey, "hex")).digest();

describe("SessionStore keys of one customer", () => {
	it("keeps one key per login and finds a lobby login's key by its MD5", async () => {
		const store = new SessionStore();
		await store.updateSessionKey(customerId, keyOfClientA, "ticketA", "loginA");
		await store.updateSessionKey(customerId, keyOfClientB, "ticketB", "loginB");
		expect((await store.fetchSessionKeyByHash(customerId, md5(keyOfClientA))).sessionKey).toBe(keyOfClientA);
		expect((await store.fetchSessionKeyByHash(customerId, md5(keyOfClientB))).sessionKey).toBe(keyOfClientB);
		await expect(store.fetchSessionKeyByHash(customerId, md5("cc".repeat(32)))).rejects.toThrow(/No login of customer 4242/);
		await expect(store.fetchSessionKeyByHash(customerId + 1, md5(keyOfClientA))).rejects.toThrow();
	});

	it("gives each persona the key its lobby login named, and refuses to guess between logins", async () => {
		const store = new SessionStore();
		await store.updateSessionKey(customerId, keyOfClientA, "ticketA", "loginA");
		expect((await store.fetchSessionKeyForPersona(customerId, 7)).sessionKey).toBe(keyOfClientA);
		await store.updateSessionKey(customerId, keyOfClientB, "ticketB", "loginB");
		await expect(store.fetchSessionKeyForPersona(customerId, 7)).rejects.toThrow(/has 2 logins and persona 7 chose none/);
		await store.bindPersonaSession(7, await store.fetchSessionKeyByHash(customerId, md5(keyOfClientA)));
		await store.bindPersonaSession(8, await store.fetchSessionKeyByHash(customerId, md5(keyOfClientB)));
		expect((await store.fetchSessionKeyForPersona(customerId, 7)).sessionKey).toBe(keyOfClientA);
		expect((await store.fetchSessionKeyForPersona(customerId, 8)).sessionKey).toBe(keyOfClientB);
	});

	it("replaces a login's key when the same ticket logs in again", async () => {
		const store = new SessionStore();
		await store.updateSessionKey(customerId, keyOfClientA, "ticketA", "loginA");
		await store.updateSessionKey(customerId, keyOfClientB, "ticketA", "loginA2");
		await expect(store.fetchSessionKeyByHash(customerId, md5(keyOfClientA))).rejects.toThrow();
		expect((await store.fetchSessionKeyForPersona(customerId, 7)).sessionKey).toBe(keyOfClientB);
	});
});
