import { getLogContext } from "@rustymotors/logging";
import { databaseProvider } from "./database/DatabaseProvider.js";

/**
 * What a new persona starts with: the create dialog's starter car screen (MC_STOCK_CAR_INFO) shows it
 * as the starter cash, the starter car is bought from it, and the rest stays in the bank.
 */
export const starterCash = 10000;

/**
 * The most personas one account may have: one login holds all of a player's personas. The client reads it
 * from the persona list, where it is one byte, and, per shard, from the shard list's MaxPersonasPerUser.
 */
export const maximumPersonasPerCustomer = 100;

/**
 * Every persona's level, points to the next level and reputation rank until racing earns points: what
 * MC_GET_PLAYER_INFO reports and the hub shows ("Level: 1 (Newbie)").
 */
export const personaLevel = 1;
export const personaPointsToNextLevel = 3;
export const personaRank = 0;

/** The client's reputation ranks (Data\Text\text.eng), by rank number. */
export const reputationRanks = ["Newbie", "Amateur", "Intermediate", "Experienced", "Veteran", "Ace", "Top Ace"];

/** A car as the client names it, from its model year, brand and model: '57 Chevrolet Bel-Air. */
export function carDisplayName(modelYear: number, brand: string, model: string): string {
	return `'${String(modelYear % 100).padStart(2, "0")} ${brand} ${model}`;
}

// The create dialog's license plate keeps at most 7 characters.
export const plateTextMaximumLength = 7;
const plateTextPattern = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;

/** Whether a license plate's text is one the client's plate field can produce. */
export function isPlateTextWellFormed(text: string): boolean {
	return text.length <= plateTextMaximumLength && plateTextPattern.test(text);
}

/**
 * Whether a request for this customer comes from the address its session logged in from. The
 * persona port's requests and the MCOTS connect carry a customer id and nothing that proves it.
 */
export function isRequestFromCustomer(customerId: number): boolean {
	const remoteAddress = getLogContext()?.remoteAddress;
	if (typeof remoteAddress === "undefined") {
		throw new Error("The request's connection has no remote address");
	}
	return databaseProvider.getAuthStore().findSessionAddress(customerId) === remoteAddress;
}
