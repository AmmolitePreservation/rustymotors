import { runWithLogContext } from "@rustymotors/logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	McosSession,
	OldServerMessage,
	addSession,
	createInitialState,
	databaseProvider,
	fetchStateFromDatabase,
	starterCash,
	type IDatabaseServices,
	type PersonaOptions,
	type PersonaPhysical,
	type PersonaPlayer,
	type PersonaSummary,
} from "rusty-motors-shared";
import { loggerMock } from "rusty-motors-shared/test";
import { _buyCarFromDealer } from "../src/_buyCarFromDealer.js";
import { _deletePersona } from "../src/_deletePersona.js";
import { _getPlayerInfo } from "../src/_getPlayerInfo.js";
import { _getPlayerPhysical } from "../src/_getPlayerPhysical.js";
import { _getStockCarInfo } from "../src/_getStockCarInfo.js";
import { _setOptions } from "../src/_setOptions.js";
import { _setPersonaDescription } from "../src/_setPersonaDescription.js";
import { _updatePlayerPhysical } from "../src/_updatePlayerPhysical.js";
import { clientConnect } from "../src/clientConnect.js";
import { login } from "../src/login.js";
import type { MessageHandlerArgs, MessageHandlerResult } from "../src/handlers.js";

const connectionId = "test:43300";
const loginAddress = "10.111.111.11";
const customerId = 654321;
const personaId = 1000;
const sequence = 7;

const marty: PersonaPlayer = {
	personaId,
	customerId,
	name: "Marty",
	bankBalance: 2606,
	carsOwned: 1,
	plateCode: 0x0102,
	plateText: "OUTATIM",
	carInfoSetting: 3,
	carNumbers: ["88", "", "", "", "", "7"],
	description: "Doc's friend",
	physical: { bodyType: 2, hairColor: -5487603, skinColor: -12634, shirtColor: -1, pantsColor: -10197916 },
};

type Calls = {
	options: { personaId: number; options: PersonaOptions }[];
	physical: { personaId: number; physical: PersonaPhysical }[];
	descriptions: { personaId: number; description: string }[];
	purchases: { playerId: number; brandedPartId: number; skinId: number; price: number }[];
};

function registerStores(bankBalance = starterCash, carsOwned = marty.carsOwned, isDeleted = false): Calls {
	const calls: Calls = { options: [], physical: [], descriptions: [], purchases: [] };
	const personas: PersonaSummary[] = [{ personaId, customerId, name: "Marty", shardId: 44, createStamp: 0x66000010 }];
	databaseProvider.register({
		auth: { hasSessionFromAddress: (customer: number, address: string) => customer === customerId && address === loginAddress },
		persona: {
			findPersona: async (id: number) => (isDeleted ? undefined : personas.find((persona) => persona.personaId === id)),
			findPlayer: async (id: number) => (id === personaId ? { ...marty, carsOwned } : undefined),
			setOptions: async (id: number, options: PersonaOptions) => {
				calls.options.push({ personaId: id, options });
			},
			setPhysical: async (id: number, physical: PersonaPhysical) => {
				calls.physical.push({ personaId: id, physical });
			},
			setDescription: async (id: number, description: string) => {
				calls.descriptions.push({ personaId: id, description });
			},
		},
		gameData: {
			purchaseStockCar: async (playerId: number, brandedPartId: number, skinId: number, price: number) => {
				calls.purchases.push({ playerId, brandedPartId, skinId, price });
				return bankBalance >= price ? 5001 : undefined;
			},
		},
	} as unknown as IDatabaseServices);
	return calls;
}

function connectAsPersona(id: number) {
	addSession(fetchStateFromDatabase(), new McosSession({ connectionId, gameId: id })).save();
}

function request(body: Buffer): OldServerMessage {
	const packet = new OldServerMessage();
	packet._header.sequence = sequence;
	packet.setBuffer(body);
	return packet;
}

function fixed(text: string, length: number): Buffer {
	const field = Buffer.alloc(length);
	field.write(text, "latin1");
	return field;
}

function u16(value: number): Buffer {
	const bytes = Buffer.alloc(2);
	bytes.writeUInt16LE(value, 0);
	return bytes;
}

function u32(value: number): Buffer {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32LE(value, 0);
	return bytes;
}

function i32(value: number): Buffer {
	const bytes = Buffer.alloc(4);
	bytes.writeInt32LE(value, 0);
	return bytes;
}

function setOptionsRequest(plateText: string, carNumbers: string[]): OldServerMessage {
	return request(Buffer.concat([u16(109), u16(0x0102), fixed(plateText, 8), u32(3), ...carNumbers.map((n) => fixed(n, 3))]));
}

function physicalRequest(playerId: number): OldServerMessage {
	return request(Buffer.concat([u16(266), u32(playerId), i32(2), i32(-5487603), i32(-12634), i32(-1), i32(-10197916)]));
}

async function reply(
	handler: (args: MessageHandlerArgs) => Promise<MessageHandlerResult>,
	packet: OldServerMessage,
	remoteAddress = loginAddress,
): Promise<Buffer> {
	const result = await runWithLogContext({ remoteAddress }, () => handler({ connectionId, packet, log: loggerMock }));
	expect(result.messages).toHaveLength(1);
	const message = result.messages[0]!;
	expect(message.sequenceNumber).toBe(sequence);
	return message.data;
}

beforeEach(() => createInitialState({}).save());
afterEach(() => databaseProvider.unregister());

describe("_setOptions", () => {
	it("stores the plate, car info setting, and car numbers for the connection's persona and answers MC_SUCCESS", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		const data = await reply(_setOptions, setOptionsRequest("OUTATIM", ["88", "", "", "", "", "7"]));
		expect(calls.options).toEqual([
			{ personaId, options: { plateCode: 0x0102, plateText: "OUTATIM", carInfoSetting: 3, carNumbers: ["88", "", "", "", "", "7"] } },
		]);
		expect([data.readUInt16LE(0), data.readUInt16LE(2)]).toEqual([101, 109]);
	});

	it("refuses a plate the client cannot produce", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		await expect(reply(_setOptions, setOptionsRequest(" LEAD", ["", "", "", "", "", ""]))).rejects.toThrow(/plate text/);
		expect(calls.options).toEqual([]);
	});

	it("refuses a connection that has not connected as a persona", async () => {
		const calls = registerStores();
		await expect(reply(_setOptions, setOptionsRequest("OUTATIM", ["", "", "", "", "", ""]))).rejects.toThrow(/not connected/);
		expect(calls.options).toEqual([]);
	});
});

describe("_updatePlayerPhysical", () => {
	it("stores the body type and the colors as signed ARGB for the connection's persona", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		const data = await reply(_updatePlayerPhysical, physicalRequest(personaId));
		expect(calls.physical).toEqual([{ personaId, physical: marty.physical }]);
		expect([data.readUInt16LE(0), data.readUInt16LE(2)]).toEqual([101, 266]);
	});

	it("refuses another player's look", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		await expect(reply(_updatePlayerPhysical, physicalRequest(21))).rejects.toThrow(/player 21 on persona 1000/);
		expect(calls.physical).toEqual([]);
	});
});

describe("_setPersonaDescription", () => {
	it("stores the description up to its NUL", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		const data = await reply(_setPersonaDescription, request(Buffer.concat([u16(492), fixed("Where we're going", 256)])));
		expect(calls.descriptions).toEqual([{ personaId, description: "Where we're going" }]);
		expect([data.readUInt16LE(0), data.readUInt16LE(2)]).toEqual([101, 492]);
	});
});

describe("_getPlayerInfo", () => {
	it("answers with the persona's stored name, money, cars, plate, and description", async () => {
		registerStores();
		const data = await reply(_getPlayerInfo, request(Buffer.concat([u16(108), u32(personaId), u32(0)])));
		expect(data.readUInt32LE(2)).toBe(personaId);
		expect(data.subarray(6, 12).toString("latin1")).toBe("Marty\u0000");
		expect(data.readUInt32LE(32)).toBe(2606);
		expect(data.readUInt16LE(36)).toBe(1);
		expect(data.subarray(39, 57)).toEqual(Buffer.concat(marty.carNumbers.map((carNumber) => fixed(carNumber, 3))));
		expect(data.readUInt16LE(57)).toBe(0x0102);
		expect(data.subarray(59, 67).toString("latin1")).toBe("OUTATIM\u0000");
		expect(data.readUInt32LE(67)).toBe(3);
		expect(data.subarray(166, 179).toString("latin1")).toBe("Doc's friend\u0000");
	});

	it("refuses a player who is not a live persona", async () => {
		registerStores();
		await expect(reply(_getPlayerInfo, request(Buffer.concat([u16(108), u32(4242), u32(0)])))).rejects.toThrow(/4242/);
	});
});

describe("_getPlayerPhysical", () => {
	it("answers MC_PLAYER_PHYSICAL_INFO with the stored look", async () => {
		registerStores();
		const data = await reply(_getPlayerPhysical, request(Buffer.concat([u16(264), u32(personaId), u32(0)])));
		expect(data).toEqual(Buffer.concat([u16(265), u32(personaId), i32(2), i32(-5487603), i32(-12634), i32(-1), i32(-10197916)]));
	});
});

describe("clientConnect", () => {
	function connectRequest(customer: number, persona: number): OldServerMessage {
		return request(Buffer.concat([u16(438), u32(customer), u32(persona), fixed("", 13), fixed("Marty", 13), fixed("", 4)]));
	}

	it("refuses a persona the customer does not have", async () => {
		registerStores();
		await expect(reply(clientConnect, connectRequest(customerId, 21))).rejects.toThrow(/persona 21, which customer 654321 does not have/);
		expect(fetchStateFromDatabase().sessions[connectionId]).toBeUndefined();
	});

	it("refuses a connect from an address that did not log in as the customer", async () => {
		registerStores();
		await expect(reply(clientConnect, connectRequest(customerId, personaId), "203.0.113.9")).rejects.toThrow(/not from the address/);
		expect(fetchStateFromDatabase().sessions[connectionId]).toBeUndefined();
	});
});

describe("_getStockCarInfo", () => {
	it("offers the starter dealer's three cars with the starter cash", async () => {
		registerStores();
		const data = await reply(_getStockCarInfo, request(Buffer.concat([u16(141), u32(8), u32(0)])));
		expect(data.length).toBe(17 + 3 * 10);
		expect([data.readUInt16LE(0), data.readInt32LE(2), data.readInt32LE(6), data.readInt32LE(10), data.readUInt16LE(14)]).toEqual([
			141, starterCash, 8, 105, 3,
		]);
		const cars = [0, 1, 2].map((index) => {
			const offset = 17 + index * 10;
			return [data.readUInt32LE(offset), data.readInt32LE(offset + 4), data.readInt16LE(offset + 8)];
		});
		expect(cars).toEqual([[113, 7394, 0], [104, 6495, 1], [402, 5995, 0]]);
	});

	it("refuses a dealer that has no stock cars", async () => {
		registerStores();
		await expect(reply(_getStockCarInfo, request(Buffer.concat([u16(141), u32(6), u32(0)])))).rejects.toThrow(/dealer 6/);
	});
});

describe("_buyCarFromDealer", () => {
	function purchaseRequest(brandedPartId: number, tradeInCarId = 0): OldServerMessage {
		return request(Buffer.concat([u16(142), u32(8), u32(brandedPartId), u32(41), u32(tradeInCarId)]));
	}

	it("charges the dealer's price to the connection's persona and answers with the new car's id", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		const data = await reply(_buyCarFromDealer, purchaseRequest(104));
		expect(calls.purchases).toEqual([{ playerId: personaId, brandedPartId: 104, skinId: 41, price: 6495 }]);
		expect([data.readUInt16LE(0), data.readUInt16LE(2), data.readUInt32LE(8)]).toEqual([101, 142, 5001]);
	});

	it("answers MC_FAILED when the bank cannot cover the price", async () => {
		registerStores(6000);
		connectAsPersona(personaId);
		const data = await reply(_buyCarFromDealer, purchaseRequest(113));
		expect([data.readUInt16LE(0), data.readUInt16LE(2)]).toEqual([102, 142]);
	});

	it("refuses a car the dealer does not sell and a trade-in", async () => {
		const calls = registerStores();
		connectAsPersona(personaId);
		await expect(reply(_buyCarFromDealer, purchaseRequest(999))).rejects.toThrow(/does not sell branded part 999/);
		await expect(reply(_buyCarFromDealer, purchaseRequest(104, 77))).rejects.toThrow(/trade-ins/);
		expect(calls.purchases).toEqual([]);
	});
});

describe("login", () => {
	function loginRequest(persona: number, dealerId: number, brandedPartId: number): OldServerMessage {
		return request(Buffer.concat([
			u16(105), u32(customerId), u32(persona), u32(dealerId), u32(brandedPartId), u32(41), fixed("Marty", 13), u32(0),
		]));
	}

	it("buys the starter car the first login after creation names, at the starter dealer's price", async () => {
		const calls = registerStores(starterCash, 0);
		connectAsPersona(personaId);
		const data = await reply(login, loginRequest(personaId, 8, 402));
		expect(calls.purchases).toEqual([{ playerId: personaId, brandedPartId: 402, skinId: 41, price: 5995 }]);
		expect(data.readUInt16LE(0)).toBe(213);
	});

	it("buys nothing for a persona that already owns a car", async () => {
		const calls = registerStores(starterCash, 1);
		connectAsPersona(personaId);
		await reply(login, loginRequest(personaId, 8, 402));
		expect(calls.purchases).toEqual([]);
	});

	it("refuses a login as another persona", async () => {
		const calls = registerStores(starterCash, 0);
		connectAsPersona(personaId);
		await expect(reply(login, loginRequest(21, 8, 402))).rejects.toThrow(/persona 21 on persona 1000/);
		expect(calls.purchases).toEqual([]);
	});
});

describe("_deletePersona", () => {
	it("answers MC_SUCCESS once the NPS delete has retired the connection's persona", async () => {
		registerStores(starterCash, 1, true);
		connectAsPersona(personaId);
		const data = await reply(_deletePersona, request(Buffer.concat([u16(320), u32(personaId), u32(0)])));
		expect([data.readUInt16LE(0), data.readUInt16LE(2)]).toEqual([101, 320]);
	});

	it("refuses a persona the NPS delete has not deleted, and another persona", async () => {
		registerStores(starterCash, 1, false);
		connectAsPersona(personaId);
		await expect(reply(_deletePersona, request(Buffer.concat([u16(320), u32(personaId), u32(0)])))).rejects.toThrow(/has not deleted/);
		await expect(reply(_deletePersona, request(Buffer.concat([u16(320), u32(21), u32(0)])))).rejects.toThrow(/persona 21 on persona 1000/);
	});
});
